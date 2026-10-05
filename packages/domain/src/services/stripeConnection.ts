import {
  and,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  stripeConnectionOperations,
  stripeConnections,
  stripeConnectStates,
  stripeWebhookEvents,
} from "../db/schema.js";
import {
  ConflictError,
  InvalidStripeConnectStateError,
  NotFoundError,
  StripeConnectionOperationConflictError,
  ValidationError,
} from "../errors.js";
import type {
  StripeAccountStatus,
  StripeConnection,
  StripeConnectionOperation,
  StripeConnectionStatus,
  StripeConnectState,
  StripeObservationResult,
} from "../types.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DISCONNECT_ATTEMPT_TTL_MS = 60 * 1000;

export type CreateOAuthStateInput = {
  state: string;
  userId: string;
  livemode: boolean;
};

export type ConsumeOAuthStateInput = CreateOAuthStateInput;

export type ConnectAccountInput = StripeAccountStatus & {
  userId: string;
  operationId: string;
};

export type RecordAuthorizedAccountInput = {
  userId: string;
  operationId: string;
  stripeAccountId: string;
};

export type PersistAuthorizedConnectionInput = {
  userId: string;
  operationId: string;
  livemode: boolean;
};

export type PersistAuthorizedConnectionResult =
  | { outcome: "persisted"; connection: StripeConnection }
  | { outcome: "owner_conflict" };

export type AuthorizedStripeConnectionOperation = {
  operationId: string;
  stripeAccountId: string | null;
  livemode: boolean;
  phase: "authorizing" | "authorized";
};

export type UpdateAuthorizedAccountStatusInput = AccountStatusObservationInput & {
  userId: string;
  operationId: string;
};

export type CompleteAuthorizedConnectionInput = {
  userId: string;
  operationId: string;
  connectionId: string;
  expectedAuthorizationRevision: string;
};

export type CompleteDeauthorizedConnectOperationInput = {
  userId: string;
  operationId: string;
  stripeAccountId: string;
};

export type CompleteUnconfirmedConnectOperationInput = {
  userId: string;
  operationId: string;
};

export type AccountStatusObservationInput = StripeAccountStatus & {
  expectedAuthorizationRevision: string;
  observedAt: Date;
};

export type ExternalDeauthorizationObservationInput = {
  stripeAccountId: string;
  livemode: boolean;
  expectedAuthorizationRevision: string;
};

export type RestoreDisconnectedAccountInput = {
  connectionId: string;
  userId: string;
  disconnectOperationId: string;
  expectedAuthorizationRevision: string;
  attemptId: string;
  observation?: { account: StripeAccountStatus; observedAt: Date };
};

export type FinalizeDisconnectedAccountInput =
  RestoreDisconnectedAccountInput;

export type CompleteOAuthStateInput = {
  stateHash: string;
  userId: string;
  operationId: string;
};

export type DisconnectAttemptInput = Omit<
  RestoreDisconnectedAccountInput,
  "attemptId"
>;

export type DisconnectAttempt = {
  connection: StripeConnection;
  attemptId: string;
};

export type StripeAccountDeletionBlock =
  | "active_connection"
  | "pending_disconnect"
  | "authorized_connection"
  | "outstanding_payments";

export function stripePaymentWorkResolved(userId: string) {
  return sql`NOT EXISTS (SELECT 1 FROM invoices i WHERE i.user_id = ${userId}
    AND (i.status = 'sent' OR i.stripe_void_pending = 1))
    AND NOT EXISTS (SELECT 1 FROM invoice_checkout_attempts a JOIN invoices i ON i.id = a.invoice_id
      WHERE i.user_id = ${userId} AND a.state IN ('creating', 'open', 'processing', 'unknown'))`;
}

function asConnection(
  row: typeof stripeConnections.$inferSelect,
): StripeConnection {
  return row;
}

function asOperation(
  row: typeof stripeConnectionOperations.$inferSelect,
): StripeConnectionOperation {
  return row as StripeConnectionOperation;
}

export async function getCurrentOperation(
  db: Database,
  userId: string,
): Promise<StripeConnectionOperation | null> {
  const [row] = await db
    .select()
    .from(stripeConnectionOperations)
    .where(eq(stripeConnectionOperations.user_id, userId));

  return row ? asOperation(row) : null;
}

export async function getCurrentAuthorizedOperation(
  db: Database,
  userId: string,
): Promise<AuthorizedStripeConnectionOperation | null> {
  const [row] = await db
    .select({
      operationId: stripeConnectionOperations.id,
      stripeAccountId: stripeConnectionOperations.stripe_account_id,
      livemode: stripeConnectStates.livemode,
      phase: stripeConnectionOperations.phase,
    })
    .from(stripeConnectionOperations)
    .innerJoin(
      stripeConnectStates,
      and(
        eq(
          stripeConnectStates.operation_id,
          stripeConnectionOperations.id,
        ),
        eq(stripeConnectStates.user_id, userId),
        isNotNull(stripeConnectStates.consumed_at),
        isNull(stripeConnectStates.completed_at),
      ),
    )
    .where(
      and(
        eq(stripeConnectionOperations.user_id, userId),
        eq(stripeConnectionOperations.kind, "connect"),
      ),
    )
    .limit(1);

  if (
    !row ||
    (row.phase !== "authorizing" && row.phase !== "authorized")
  ) {
    return null;
  }
  return {
    operationId: row.operationId,
    stripeAccountId: row.stripeAccountId,
    livemode: row.livemode,
    phase: row.phase,
  };
}

async function releaseOperation(
  db: Database,
  operationId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .delete(stripeConnectionOperations)
    .where(
      and(
        eq(stripeConnectionOperations.id, operationId),
        eq(stripeConnectionOperations.user_id, userId),
      ),
    );

  return result.meta.changes === 1;
}

async function hashOAuthState(state: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(state),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function getIgnoredObservationResult(
  db: Database,
  input: ExternalDeauthorizationObservationInput,
): Promise<StripeObservationResult> {
  const [current] = await db
    .select({
      livemode: stripeConnections.livemode,
      disconnected_at: stripeConnections.disconnected_at,
      authorization_revision: stripeConnections.authorization_revision,
    })
    .from(stripeConnections)
    .where(eq(stripeConnections.stripe_account_id, input.stripeAccountId));

  if (!current) return { outcome: "ignored", reason: "not_found" };
  if (current.livemode !== input.livemode) {
    return { outcome: "ignored", reason: "mode_mismatch" };
  }
  if (current.disconnected_at !== null) {
    return { outcome: "ignored", reason: "inactive" };
  }
  if (
    current.authorization_revision !== input.expectedAuthorizationRevision
  ) {
    return {
      outcome: "ignored",
      reason: "authorization_revision_mismatch",
    };
  }
  return { outcome: "ignored", reason: "stale" };
}

export function getConnectionStatus(
  connection: StripeConnection,
  expectedLivemode: boolean | null,
): StripeConnectionStatus {
  const active = connection.disconnected_at === null;
  const disconnectPending = connection.disconnect_operation_id !== null ||
    connection.disconnect_started_at !== null;
  const modeMatches =
    expectedLivemode !== null && connection.livemode === expectedLivemode;

  return {
    ...connection,
    active,
    disconnect_pending: disconnectPending,
    mode_matches: modeMatches,
    ready:
      active &&
      !disconnectPending &&
      modeMatches &&
      (!connection.livemode || (
        connection.details_submitted &&
        connection.charges_enabled &&
        connection.payouts_enabled
      )),
  };
}

export function isConnectionReady(
  connection: StripeConnection,
  expectedLivemode: boolean,
): boolean {
  return getConnectionStatus(connection, expectedLivemode).ready;
}

export async function getActiveConnection(
  db: Database,
  userId: string,
): Promise<StripeConnection | null> {
  const [row] = await db
    .select()
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.user_id, userId),
        isNull(stripeConnections.disconnected_at),
      ),
    );

  return row ? asConnection(row) : null;
}

export async function getCurrentUiConnection(
  db: Database,
  userId: string,
): Promise<StripeConnection | null> {
  const [pending] = await db
    .select()
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.user_id, userId),
        isNotNull(stripeConnections.disconnected_at),
        isNotNull(stripeConnections.disconnect_operation_id),
      ),
    )
    .orderBy(desc(stripeConnections.disconnect_started_at))
    .limit(1);

  if (pending) return asConnection(pending);
  return getActiveConnection(db, userId);
}

export async function getConnectionById(
  db: Database,
  connectionId: string,
): Promise<StripeConnection | null> {
  const [row] = await db
    .select()
    .from(stripeConnections)
    .where(eq(stripeConnections.id, connectionId));

  return row ? asConnection(row) : null;
}

export async function getConnectionByAccountId(
  db: Database,
  stripeAccountId: string,
): Promise<StripeConnection | null> {
  const [row] = await db
    .select()
    .from(stripeConnections)
    .where(eq(stripeConnections.stripe_account_id, stripeAccountId));

  return row ? asConnection(row) : null;
}

export async function createOAuthState(
  db: Database,
  input: CreateOAuthStateInput,
  now = new Date(),
): Promise<StripeConnectState> {
  if (!input.state) {
    throw new ValidationError("Stripe connection state is required");
  }

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString();
  const operationId = crypto.randomUUID();
  const operation = {
    id: operationId,
    user_id: input.userId,
    kind: "connect",
    connection_id: null,
    expires_at: expiresAt,
    phase: "authorizing",
    stripe_account_id: null,
    attempt_id: null,
    attempt_expires_at: null,
    created_at: createdAt,
  } as const;
  const state: StripeConnectState = {
    state_hash: await hashOAuthState(input.state),
    user_id: input.userId,
    livemode: input.livemode,
    operation_id: operationId,
    expires_at: expiresAt,
    consumed_at: null,
    completed_at: null,
    created_at: createdAt,
  };

  try {
    await db.batch([
      db
        .delete(stripeConnectStates)
        .where(
          or(
            isNotNull(stripeConnectStates.completed_at),
            and(
              lte(stripeConnectStates.expires_at, createdAt),
              isNull(stripeConnectStates.consumed_at),
              sql`NOT EXISTS (
                SELECT 1 FROM ${stripeConnectionOperations}
                WHERE ${stripeConnectionOperations.id} = ${stripeConnectStates.operation_id}
                  AND ${stripeConnectionOperations.kind} = 'connect'
                  AND ${stripeConnectionOperations.phase} = 'authorized'
                  AND ${stripeConnectionOperations.stripe_account_id} IS NOT NULL
              )`,
            ),
          ),
        ),
      db
        .delete(stripeConnectionOperations)
        .where(
          and(
            eq(stripeConnectionOperations.kind, "connect"),
            eq(stripeConnectionOperations.phase, "authorizing"),
            isNotNull(stripeConnectionOperations.expires_at),
            lte(stripeConnectionOperations.expires_at, createdAt),
            sql`NOT EXISTS (
              SELECT 1 FROM ${stripeConnectStates}
              WHERE ${stripeConnectStates.operation_id} = ${stripeConnectionOperations.id}
                AND ${stripeConnectStates.consumed_at} IS NOT NULL
                AND ${stripeConnectStates.completed_at} IS NULL
            )`,
          ),
        ),
      db.insert(stripeConnectionOperations).values(operation),
    ]);
  } catch (error) {
    const current = await getCurrentOperation(db, input.userId);
    if (current) {
      throw new StripeConnectionOperationConflictError(
        current.kind === "disconnect"
          ? "pending_disconnect"
          : "operation_in_progress",
      );
    }
    throw error;
  }

  try {
    const [pending] = await db
      .select({ id: stripeConnections.id })
      .from(stripeConnections)
      .where(
        and(
          eq(stripeConnections.user_id, input.userId),
          isNotNull(stripeConnections.disconnect_operation_id),
        ),
      )
      .limit(1);
    if (pending) {
      throw new StripeConnectionOperationConflictError("pending_disconnect");
    }

    const active = await getActiveConnection(db, input.userId);
    if (active) {
      throw new StripeConnectionOperationConflictError("active_connection");
    }

    await db.insert(stripeConnectStates).values(state);
    return state;
  } catch (error) {
    await releaseOperation(db, operationId, input.userId);
    throw error;
  }
}

export async function consumeOAuthState(
  db: Database,
  input: ConsumeOAuthStateInput,
  now = new Date(),
): Promise<StripeConnectState> {
  if (!input.state) {
    throw new InvalidStripeConnectStateError();
  }

  const stateHash = await hashOAuthState(input.state);
  const consumedAt = now.toISOString();
  const extendedExpiry = new Date(
    now.getTime() + OAUTH_STATE_TTL_MS,
  ).toISOString();
  const validState = sql`EXISTS (
    SELECT 1 FROM ${stripeConnectStates} AS connect_state
    WHERE connect_state.state_hash = ${stateHash}
      AND connect_state.user_id = ${input.userId}
      AND connect_state.livemode = ${input.livemode}
      AND connect_state.consumed_at IS NULL
      AND connect_state.completed_at IS NULL
      AND connect_state.expires_at > ${consumedAt}
      AND connect_state.operation_id = ${stripeConnectionOperations.id}
      AND ${stripeConnectionOperations.phase} = 'authorizing'
  )`;
  const [, states] = await db.batch([
    db
      .update(stripeConnectionOperations)
      .set({ expires_at: extendedExpiry })
      .where(
        and(
          eq(stripeConnectionOperations.user_id, input.userId),
          eq(stripeConnectionOperations.kind, "connect"),
          gt(stripeConnectionOperations.expires_at, consumedAt),
          validState,
        ),
      ),
    db
      .update(stripeConnectStates)
      .set({ consumed_at: consumedAt, expires_at: extendedExpiry })
      .where(
        and(
          eq(stripeConnectStates.state_hash, stateHash),
          eq(stripeConnectStates.user_id, input.userId),
          eq(stripeConnectStates.livemode, input.livemode),
          isNull(stripeConnectStates.consumed_at),
          isNull(stripeConnectStates.completed_at),
          gt(stripeConnectStates.expires_at, consumedAt),
          sql`EXISTS (
            SELECT 1 FROM ${stripeConnectionOperations}
            WHERE ${stripeConnectionOperations.id} = ${stripeConnectStates.operation_id}
              AND ${stripeConnectionOperations.user_id} = ${input.userId}
              AND ${stripeConnectionOperations.kind} = 'connect'
              AND ${stripeConnectionOperations.expires_at} = ${extendedExpiry}
          )`,
        ),
      )
      .returning(),
  ]);
  const state = states[0];

  if (state) return state;

  const [recoverable] = await db
    .select()
    .from(stripeConnectStates)
    .where(
      and(
        eq(stripeConnectStates.state_hash, stateHash),
        eq(stripeConnectStates.user_id, input.userId),
        eq(stripeConnectStates.livemode, input.livemode),
        isNotNull(stripeConnectStates.consumed_at),
        isNull(stripeConnectStates.completed_at),
        sql`EXISTS (
          SELECT 1 FROM ${stripeConnectionOperations}
          WHERE ${stripeConnectionOperations.id} = ${stripeConnectStates.operation_id}
            AND ${stripeConnectionOperations.user_id} = ${input.userId}
            AND ${stripeConnectionOperations.kind} = 'connect'
            AND ${stripeConnectionOperations.phase} = 'authorized'
            AND ${stripeConnectionOperations.stripe_account_id} IS NOT NULL
        )`,
      ),
    );

  if (!recoverable) throw new InvalidStripeConnectStateError();
  return recoverable;
}

export async function completeOAuthState(
  db: Database,
  input: CompleteOAuthStateInput,
  now = new Date(),
): Promise<boolean> {
  const completedAt = now.toISOString();
  const [states] = await db.batch([
    db
      .update(stripeConnectStates)
      .set({ completed_at: completedAt })
      .where(
        and(
          eq(stripeConnectStates.state_hash, input.stateHash),
          eq(stripeConnectStates.user_id, input.userId),
          eq(stripeConnectStates.operation_id, input.operationId),
          isNotNull(stripeConnectStates.consumed_at),
          isNull(stripeConnectStates.completed_at),
          sql`EXISTS (
            SELECT 1 FROM ${stripeConnectionOperations}
            WHERE ${stripeConnectionOperations.id} = ${input.operationId}
              AND ${stripeConnectionOperations.user_id} = ${input.userId}
              AND ${stripeConnectionOperations.kind} = 'connect'
          )`,
        ),
      )
      .returning({ state_hash: stripeConnectStates.state_hash }),
    db
      .delete(stripeConnectionOperations)
      .where(
        and(
          eq(stripeConnectionOperations.id, input.operationId),
          eq(stripeConnectionOperations.user_id, input.userId),
          eq(stripeConnectionOperations.kind, "connect"),
          sql`EXISTS (
            SELECT 1 FROM ${stripeConnectStates}
            WHERE ${stripeConnectStates.state_hash} = ${input.stateHash}
              AND ${stripeConnectStates.user_id} = ${input.userId}
              AND ${stripeConnectStates.operation_id} = ${input.operationId}
              AND ${stripeConnectStates.completed_at} = ${completedAt}
          )`,
        ),
      ),
  ]);

  return states.length === 1;
}

export async function recordAuthorizedAccount(
  db: Database,
  input: RecordAuthorizedAccountInput,
): Promise<StripeConnectionOperation> {
  if (!input.stripeAccountId.startsWith("acct_")) {
    throw new ValidationError("Stripe account ID is invalid");
  }

  const [operation] = await db
    .update(stripeConnectionOperations)
    .set({
      phase: "authorized",
      stripe_account_id: input.stripeAccountId,
    })
    .where(
      and(
        eq(stripeConnectionOperations.id, input.operationId),
        eq(stripeConnectionOperations.user_id, input.userId),
        eq(stripeConnectionOperations.kind, "connect"),
        or(
          and(
            eq(stripeConnectionOperations.phase, "authorizing"),
            isNull(stripeConnectionOperations.stripe_account_id),
          ),
          and(
            eq(stripeConnectionOperations.phase, "authorized"),
            eq(
              stripeConnectionOperations.stripe_account_id,
              input.stripeAccountId,
            ),
          ),
        ),
      ),
    )
    .returning();

  if (!operation) {
    throw new StripeConnectionOperationConflictError("operation_in_progress");
  }
  return asOperation(operation);
}

export async function getAccountDeletionBlock(
  db: Database,
  userId: string,
): Promise<StripeAccountDeletionBlock | null> {
  const unresolved = await db.get<{ resolved: number }>(sql`SELECT ${stripePaymentWorkResolved(userId)} AS resolved`);
  if (!unresolved?.resolved) return "outstanding_payments";
  const [connection] = await db
    .select({
      disconnected_at: stripeConnections.disconnected_at,
      disconnect_operation_id: stripeConnections.disconnect_operation_id,
    })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.user_id, userId),
        or(
          isNull(stripeConnections.disconnected_at),
          isNotNull(stripeConnections.disconnect_operation_id),
        ),
      ),
    )
    .limit(1);
  if (connection?.disconnect_operation_id) return "pending_disconnect";
  if (connection) return "active_connection";

  const [operation] = await db
    .select({ id: stripeConnectionOperations.id })
    .from(stripeConnectionOperations)
    .where(
      and(
        eq(stripeConnectionOperations.user_id, userId),
        eq(stripeConnectionOperations.kind, "connect"),
        sql`EXISTS (
          SELECT 1 FROM ${stripeConnectStates}
          WHERE ${stripeConnectStates.operation_id} = ${stripeConnectionOperations.id}
            AND ${stripeConnectStates.user_id} = ${userId}
            AND ${stripeConnectStates.consumed_at} IS NOT NULL
            AND ${stripeConnectStates.completed_at} IS NULL
        )`,
      ),
    )
    .limit(1);
  return operation ? "authorized_connection" : null;
}

export async function persistAuthorizedConnection(
  db: Database,
  input: PersistAuthorizedConnectionInput,
  now = new Date(),
): Promise<PersistAuthorizedConnectionResult> {
  const persistedAt = now.toISOString();
  const operation = await getCurrentOperation(db, input.userId);
  if (
    !operation ||
    operation.id !== input.operationId ||
    operation.kind !== "connect" ||
    operation.phase !== "authorized" ||
    operation.stripe_account_id === null
  ) {
    throw new StripeConnectionOperationConflictError("operation_in_progress");
  }

  const claimed = await getConnectionByAccountId(
    db,
    operation.stripe_account_id,
  );
  if (claimed && claimed.user_id !== input.userId) {
    return { outcome: "owner_conflict" };
  }
  if (claimed?.disconnected_at === null) {
    if (claimed.livemode !== input.livemode) {
      throw new ConflictError("Stripe account mode changed");
    }
    return { outcome: "persisted", connection: claimed };
  }
  if (claimed?.disconnect_operation_id) {
    throw new StripeConnectionOperationConflictError("pending_disconnect");
  }

  const authorizationRevision = crypto.randomUUID();
  const safeStatus = {
    livemode: input.livemode,
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    requirements: null,
    disconnected_at: null,
    disconnect_operation_id: null,
    disconnect_started_at: null,
    authorization_revision: authorizationRevision,
    stripe_status_at: persistedAt,
    updated_at: persistedAt,
  } as const;

  if (claimed) {
    const [reactivated] = await db
      .update(stripeConnections)
      .set(safeStatus)
      .where(
        and(
          eq(stripeConnections.id, claimed.id),
          eq(stripeConnections.user_id, input.userId),
          eq(
            stripeConnections.authorization_revision,
            claimed.authorization_revision,
          ),
          isNotNull(stripeConnections.disconnected_at),
          isNull(stripeConnections.disconnect_operation_id),
          sql`NOT EXISTS (
            SELECT 1 FROM ${stripeConnections} AS active_connection
            WHERE active_connection.user_id = ${input.userId}
              AND active_connection.disconnected_at IS NULL
          )`,
          sql`EXISTS (
            SELECT 1 FROM ${stripeConnectionOperations}
            WHERE ${stripeConnectionOperations.id} = ${input.operationId}
              AND ${stripeConnectionOperations.user_id} = ${input.userId}
              AND ${stripeConnectionOperations.kind} = 'connect'
              AND ${stripeConnectionOperations.phase} = 'authorized'
              AND ${stripeConnectionOperations.stripe_account_id} = ${operation.stripe_account_id}
          )`,
        ),
      )
      .returning();
    if (!reactivated) {
      throw new ConflictError("Stripe account authorization changed");
    }
    return { outcome: "persisted", connection: asConnection(reactivated) };
  }

  const id = crypto.randomUUID();
  try {
    const inserted = await db.run(sql`
      INSERT INTO ${stripeConnections} (
        id,
        user_id,
        stripe_account_id,
        livemode,
        charges_enabled,
        payouts_enabled,
        details_submitted,
        disconnected_at,
        disconnect_operation_id,
        disconnect_started_at,
        authorization_revision,
        stripe_status_at,
        created_at,
        updated_at
      )
      SELECT
        ${id},
        ${input.userId},
        ${operation.stripe_account_id},
        ${input.livemode ? 1 : 0},
        0,
        0,
        0,
        NULL,
        NULL,
        NULL,
        ${authorizationRevision},
        ${persistedAt},
        ${persistedAt},
        ${persistedAt}
      WHERE EXISTS (
        SELECT 1 FROM ${stripeConnectionOperations}
        WHERE ${stripeConnectionOperations.id} = ${input.operationId}
          AND ${stripeConnectionOperations.user_id} = ${input.userId}
          AND ${stripeConnectionOperations.kind} = 'connect'
          AND ${stripeConnectionOperations.phase} = 'authorized'
          AND ${stripeConnectionOperations.stripe_account_id} = ${operation.stripe_account_id}
      )
        AND NOT EXISTS (
          SELECT 1 FROM ${stripeConnections} AS active_connection
          WHERE active_connection.user_id = ${input.userId}
            AND active_connection.disconnected_at IS NULL
        )
    `);
    if (inserted.meta.changes !== 1) {
      const owner = await getConnectionByAccountId(
        db,
        operation.stripe_account_id,
      );
      if (owner && owner.user_id !== input.userId) {
        return { outcome: "owner_conflict" };
      }
      if (owner?.disconnected_at === null) {
        return { outcome: "persisted", connection: owner };
      }
      if (await getActiveConnection(db, input.userId)) {
        throw new StripeConnectionOperationConflictError("active_connection");
      }
      throw new StripeConnectionOperationConflictError(
        "operation_in_progress",
      );
    }
  } catch (error: unknown) {
    const owner = await getConnectionByAccountId(
      db,
      operation.stripe_account_id,
    );
    if (owner && owner.user_id !== input.userId) {
      return { outcome: "owner_conflict" };
    }
    if (owner?.disconnected_at === null) {
      return { outcome: "persisted", connection: owner };
    }
    throw error;
  }

  const connected = await getConnectionById(db, id);
  if (!connected) throw new NotFoundError("Stripe connection", id);
  return { outcome: "persisted", connection: connected };
}

export async function connectAccount(
  db: Database,
  input: ConnectAccountInput,
  now = new Date(),
): Promise<StripeConnection> {
  await recordAuthorizedAccount(db, {
    userId: input.userId,
    operationId: input.operationId,
    stripeAccountId: input.stripe_account_id,
  });
  const persisted = await persistAuthorizedConnection(
    db,
    {
      userId: input.userId,
      operationId: input.operationId,
      livemode: input.livemode,
    },
    now,
  );
  if (persisted.outcome === "owner_conflict") {
    throw new ConflictError("Stripe account is already connected to another user");
  }

  const observation = await updateAccountStatus(
    db,
    {
      ...input,
      expectedAuthorizationRevision:
        persisted.connection.authorization_revision,
      observedAt: now,
    },
    now,
  );
  if (observation.outcome !== "applied") {
    throw new ConflictError("Stripe account authorization changed");
  }

  const connected = await getConnectionById(db, persisted.connection.id);
  if (!connected) {
    throw new NotFoundError("Stripe connection", persisted.connection.id);
  }
  return connected;
}

export async function updateAccountStatus(
  db: Database,
  status: AccountStatusObservationInput,
  now = new Date(),
): Promise<StripeObservationResult> {
  const observedAt = status.observedAt.toISOString();
  const result = await db
    .update(stripeConnections)
    .set({
      charges_enabled: status.charges_enabled,
      payouts_enabled: status.payouts_enabled,
      details_submitted: status.details_submitted,
      requirements: status.requirements ?? null,
      stripe_status_at: observedAt,
      updated_at: now.toISOString(),
    })
    .where(
      and(
        eq(stripeConnections.stripe_account_id, status.stripe_account_id),
        eq(stripeConnections.livemode, status.livemode),
        isNull(stripeConnections.disconnected_at),
        eq(
          stripeConnections.authorization_revision,
          status.expectedAuthorizationRevision,
        ),
        lte(stripeConnections.stripe_status_at, observedAt),
      ),
    );

  if (result.meta.changes) return { outcome: "applied" };
  return getIgnoredObservationResult(db, {
    stripeAccountId: status.stripe_account_id,
    livemode: status.livemode,
    expectedAuthorizationRevision: status.expectedAuthorizationRevision,
  });
}

export async function updateAuthorizedAccountStatus(
  db: Database,
  status: UpdateAuthorizedAccountStatusInput,
  now = new Date(),
): Promise<StripeObservationResult> {
  const observedAt = status.observedAt.toISOString();
  const result = await db
    .update(stripeConnections)
    .set({
      charges_enabled: status.charges_enabled,
      payouts_enabled: status.payouts_enabled,
      details_submitted: status.details_submitted,
      requirements: status.requirements ?? null,
      stripe_status_at: observedAt,
      updated_at: now.toISOString(),
    })
    .where(
      and(
        eq(stripeConnections.user_id, status.userId),
        eq(stripeConnections.stripe_account_id, status.stripe_account_id),
        eq(stripeConnections.livemode, status.livemode),
        isNull(stripeConnections.disconnected_at),
        eq(
          stripeConnections.authorization_revision,
          status.expectedAuthorizationRevision,
        ),
        lte(stripeConnections.stripe_status_at, observedAt),
        sql`EXISTS (
          SELECT 1 FROM ${stripeConnectionOperations}
          WHERE ${stripeConnectionOperations.id} = ${status.operationId}
            AND ${stripeConnectionOperations.user_id} = ${status.userId}
            AND ${stripeConnectionOperations.kind} = 'connect'
            AND ${stripeConnectionOperations.phase} = 'authorized'
            AND ${stripeConnectionOperations.stripe_account_id} = ${status.stripe_account_id}
        )`,
      ),
    );

  if (result.meta.changes) return { outcome: "applied" };
  return getIgnoredObservationResult(db, {
    stripeAccountId: status.stripe_account_id,
    livemode: status.livemode,
    expectedAuthorizationRevision: status.expectedAuthorizationRevision,
  });
}

export async function completeAuthorizedConnection(
  db: Database,
  input: CompleteAuthorizedConnectionInput,
  now = new Date(),
): Promise<boolean> {
  const completedAt = now.toISOString();
  const visibleConnection = sql`EXISTS (
    SELECT 1 FROM ${stripeConnections}
    WHERE ${stripeConnections.id} = ${input.connectionId}
      AND ${stripeConnections.user_id} = ${input.userId}
      AND ${stripeConnections.authorization_revision} = ${input.expectedAuthorizationRevision}
      AND ${stripeConnections.disconnected_at} IS NULL
      AND ${stripeConnections.stripe_account_id} = ${stripeConnectionOperations.stripe_account_id}
  )`;
  const [states, operation] = await db.batch([
    db
      .update(stripeConnectStates)
      .set({ completed_at: completedAt })
      .where(
        and(
          eq(stripeConnectStates.user_id, input.userId),
          eq(stripeConnectStates.operation_id, input.operationId),
          isNotNull(stripeConnectStates.consumed_at),
          isNull(stripeConnectStates.completed_at),
          sql`EXISTS (
            SELECT 1 FROM ${stripeConnectionOperations}
            WHERE ${stripeConnectionOperations.id} = ${input.operationId}
              AND ${stripeConnectionOperations.user_id} = ${input.userId}
              AND ${stripeConnectionOperations.kind} = 'connect'
              AND ${stripeConnectionOperations.phase} = 'authorized'
              AND ${visibleConnection}
          )`,
        ),
      )
      .returning({ state_hash: stripeConnectStates.state_hash }),
    db
      .delete(stripeConnectionOperations)
      .where(
        and(
          eq(stripeConnectionOperations.id, input.operationId),
          eq(stripeConnectionOperations.user_id, input.userId),
          eq(stripeConnectionOperations.kind, "connect"),
          eq(stripeConnectionOperations.phase, "authorized"),
          visibleConnection,
          sql`NOT EXISTS (
            SELECT 1 FROM ${stripeConnectStates}
            WHERE ${stripeConnectStates.operation_id} = ${input.operationId}
              AND ${stripeConnectStates.user_id} = ${input.userId}
              AND ${stripeConnectStates.completed_at} IS NULL
          )`,
        ),
      )
      .returning({ id: stripeConnectionOperations.id }),
  ]);

  return states.length === 1 && operation.length === 1;
}

export async function completeAuthorizedConnectionConflict(
  db: Database,
  input: Pick<CompleteAuthorizedConnectionInput, "userId" | "operationId">,
  now = new Date(),
): Promise<boolean> {
  const completedAt = now.toISOString();
  const ownedByAnotherUser = sql`EXISTS (
    SELECT 1 FROM ${stripeConnections}
    WHERE ${stripeConnections.stripe_account_id} = ${stripeConnectionOperations.stripe_account_id}
      AND ${stripeConnections.user_id} != ${input.userId}
  )`;
  const [states, operation] = await db.batch([
    db
      .update(stripeConnectStates)
      .set({ completed_at: completedAt })
      .where(
        and(
          eq(stripeConnectStates.user_id, input.userId),
          eq(stripeConnectStates.operation_id, input.operationId),
          isNotNull(stripeConnectStates.consumed_at),
          isNull(stripeConnectStates.completed_at),
          sql`EXISTS (
            SELECT 1 FROM ${stripeConnectionOperations}
            WHERE ${stripeConnectionOperations.id} = ${input.operationId}
              AND ${stripeConnectionOperations.user_id} = ${input.userId}
              AND ${stripeConnectionOperations.kind} = 'connect'
              AND ${stripeConnectionOperations.phase} = 'authorized'
              AND ${ownedByAnotherUser}
          )`,
        ),
      )
      .returning({ state_hash: stripeConnectStates.state_hash }),
    db
      .delete(stripeConnectionOperations)
      .where(
        and(
          eq(stripeConnectionOperations.id, input.operationId),
          eq(stripeConnectionOperations.user_id, input.userId),
          eq(stripeConnectionOperations.kind, "connect"),
          eq(stripeConnectionOperations.phase, "authorized"),
          ownedByAnotherUser,
          sql`NOT EXISTS (
            SELECT 1 FROM ${stripeConnectStates}
            WHERE ${stripeConnectStates.operation_id} = ${input.operationId}
              AND ${stripeConnectStates.user_id} = ${input.userId}
              AND ${stripeConnectStates.completed_at} IS NULL
          )`,
        ),
      )
      .returning({ id: stripeConnectionOperations.id }),
  ]);

  return states.length === 1 && operation.length === 1;
}

export async function completeDeauthorizedConnectOperation(
  db: Database,
  input: CompleteDeauthorizedConnectOperationInput,
  now = new Date(),
): Promise<boolean> {
  const completedAt = now.toISOString();
  const exactOperation = sql`EXISTS (
    SELECT 1 FROM ${stripeConnectionOperations}
    WHERE ${stripeConnectionOperations.id} = ${input.operationId}
      AND ${stripeConnectionOperations.user_id} = ${input.userId}
      AND ${stripeConnectionOperations.kind} = 'connect'
      AND ${stripeConnectionOperations.phase} = 'authorized'
      AND ${stripeConnectionOperations.stripe_account_id} = ${input.stripeAccountId}
  )`;
  const [states, operation] = await db.batch([
    db
      .update(stripeConnectStates)
      .set({ completed_at: completedAt })
      .where(
        and(
          eq(stripeConnectStates.user_id, input.userId),
          eq(stripeConnectStates.operation_id, input.operationId),
          isNotNull(stripeConnectStates.consumed_at),
          isNull(stripeConnectStates.completed_at),
          exactOperation,
        ),
      )
      .returning({ state_hash: stripeConnectStates.state_hash }),
    db
      .delete(stripeConnectionOperations)
      .where(
        and(
          eq(stripeConnectionOperations.id, input.operationId),
          eq(stripeConnectionOperations.user_id, input.userId),
          eq(stripeConnectionOperations.kind, "connect"),
          eq(stripeConnectionOperations.phase, "authorized"),
          eq(
            stripeConnectionOperations.stripe_account_id,
            input.stripeAccountId,
          ),
          sql`NOT EXISTS (
            SELECT 1 FROM ${stripeConnectStates}
            WHERE ${stripeConnectStates.operation_id} = ${input.operationId}
              AND ${stripeConnectStates.user_id} = ${input.userId}
              AND ${stripeConnectStates.completed_at} IS NULL
          )`,
        ),
      )
      .returning({ id: stripeConnectionOperations.id }),
  ]);

  return states.length === 1 && operation.length === 1;
}

export async function completeUnconfirmedConnectOperation(
  _db: Database,
  _input: CompleteUnconfirmedConnectOperationInput,
  _now = new Date(),
): Promise<boolean> {
  // Compatibility entry point: no user assertion can prove revocation of an unknown account.
  return false;
}

export type ConnectionEventInput = {
  eventId: string;
  eventType: "account.updated" | "account.application.deauthorized";
  stripeAccountId: string;
  livemode: boolean;
  expectedAuthorizationRevision: string;
  expectedDisconnectOperationId?: string | null;
  observedAt: Date;
  /** Trusted server API observation, never the signed event's stale data.object. */
  observation: { kind: "authorized"; account: StripeAccountStatus } | { kind: "deauthorized" };
};

export async function processConnectionEvent(db: Database, input: ConnectionEventInput, now = new Date()): Promise<{
  kind: "processed" | "duplicate"; result: "applied" | "ignored";
}> {
  if (!input.eventId || !input.stripeAccountId.startsWith("acct_")
    || !["account.updated", "account.application.deauthorized"].includes(input.eventType)
    || (input.observation.kind === "authorized" && (input.observation.account.stripe_account_id !== input.stripeAccountId
      || input.observation.account.livemode !== input.livemode))) {
    throw new ValidationError("Stripe connection event binding is invalid");
  }
  const eventKey = JSON.stringify(["connection_lifecycle", "connected", input.livemode, input.stripeAccountId, input.eventId]);
  const receiptId = crypto.randomUUID();
  const observedAt = input.observedAt.toISOString();
  const authorized = input.observation.kind === "authorized";
  const eligible = and(eq(stripeConnections.stripe_account_id, input.stripeAccountId), eq(stripeConnections.livemode, input.livemode),
    eq(stripeConnections.authorization_revision, input.expectedAuthorizationRevision), lte(stripeConnections.stripe_status_at, observedAt),
    input.expectedDisconnectOperationId === undefined ? sql`1` : input.expectedDisconnectOperationId === null
      ? isNull(stripeConnections.disconnect_operation_id) : eq(stripeConnections.disconnect_operation_id, input.expectedDisconnectOperationId),
    authorized ? isNull(stripeConnections.disconnected_at)
      : or(isNull(stripeConnections.disconnected_at), isNotNull(stripeConnections.disconnect_operation_id)))!;
  const freshReceipt = sql`EXISTS (SELECT 1 FROM stripe_webhook_events e
    WHERE e.event_key = ${eventKey} AND e.receipt_id = ${receiptId} AND e.result = 'applied')`;
  const account = input.observation.kind === "authorized" ? input.observation.account : null;
  const [inserted] = await db.batch([
    db.insert(stripeWebhookEvents).values({
      event_key: eventKey, event_id: input.eventId, event_type: input.eventType,
      stripe_account_id: input.stripeAccountId, charge_scope: "connected", livemode: input.livemode,
      processed_at: now.toISOString(), receipt_id: receiptId,
      result: sql`CASE WHEN EXISTS (SELECT 1 FROM ${stripeConnections} WHERE ${eligible}) THEN 'applied' ELSE 'ignored' END`,
    }).onConflictDoNothing().returning({ result: stripeWebhookEvents.result }),
    db.update(stripeConnections).set({
      ...(account ? { charges_enabled: account.charges_enabled, payouts_enabled: account.payouts_enabled, details_submitted: account.details_submitted,
        requirements: account.requirements ?? null }
        : { disconnected_at: sql`COALESCE(${stripeConnections.disconnected_at}, ${observedAt})`, disconnect_operation_id: null, disconnect_started_at: null }),
      stripe_status_at: observedAt, updated_at: now.toISOString(),
    }).where(and(eligible, freshReceipt)),
    db.delete(stripeConnectionOperations).where(and(eq(stripeConnectionOperations.kind, "disconnect"),
      authorized ? sql`0` : freshReceipt,
      sql`EXISTS (SELECT 1 FROM stripe_connections c WHERE c.id = ${stripeConnectionOperations.connection_id}
        AND c.user_id = ${stripeConnectionOperations.user_id} AND c.stripe_account_id = ${input.stripeAccountId}
        AND c.livemode = ${input.livemode} AND c.authorization_revision = ${input.expectedAuthorizationRevision}
        AND c.disconnected_at IS NOT NULL AND c.disconnect_operation_id IS NULL)`,
    )),
  ]);
  if (inserted[0]) return { kind: "processed", result: inserted[0].result as "applied" | "ignored" };
  const [existing] = await db.select({ result: stripeWebhookEvents.result }).from(stripeWebhookEvents).where(eq(stripeWebhookEvents.event_key, eventKey));
  if (!existing) throw new ConflictError("Stripe connection event confirmation is pending");
  return { kind: "duplicate", result: existing.result as "applied" | "ignored" };
}

export async function markExternalDeauthorization(
  db: Database,
  input: ExternalDeauthorizationObservationInput,
  now = new Date(),
): Promise<StripeObservationResult> {
  const current = await getConnectionByAccountId(db, input.stripeAccountId);
  if (
    current?.livemode === input.livemode &&
    current.authorization_revision === input.expectedAuthorizationRevision &&
    current.stripe_status_at <= now.toISOString() &&
    current.disconnect_operation_id !== null
  ) {
    const [rows] = await db.batch([
      db
        .update(stripeConnections)
        .set({
          disconnect_operation_id: null,
          disconnect_started_at: null,
          stripe_status_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .where(
          and(
            eq(stripeConnections.id, current.id),
            eq(
              stripeConnections.authorization_revision,
              input.expectedAuthorizationRevision,
            ),
            eq(
              stripeConnections.disconnect_operation_id,
              current.disconnect_operation_id,
            ),
            eq(stripeConnections.livemode, input.livemode),
            isNotNull(stripeConnections.disconnected_at),
            lte(stripeConnections.stripe_status_at, now.toISOString()),
          ),
        )
        .returning({ id: stripeConnections.id }),
      db
        .delete(stripeConnectionOperations)
        .where(
          and(
            eq(stripeConnectionOperations.id, current.disconnect_operation_id),
            sql`NOT EXISTS (
              SELECT 1 FROM ${stripeConnections}
              WHERE ${stripeConnections.id} = ${current.id}
                AND ${stripeConnections.disconnect_operation_id} = ${current.disconnect_operation_id}
            )`,
          ),
        ),
    ]);
    if (rows.length === 1) return { outcome: "applied" };
  }

  const observedAt = now.toISOString();
  const result = await db
    .update(stripeConnections)
    .set({
      disconnected_at: observedAt,
      stripe_status_at: observedAt,
      updated_at: observedAt,
    })
    .where(
      and(
        eq(stripeConnections.stripe_account_id, input.stripeAccountId),
        eq(stripeConnections.livemode, input.livemode),
        isNull(stripeConnections.disconnected_at),
        eq(
          stripeConnections.authorization_revision,
          input.expectedAuthorizationRevision,
        ),
        lte(stripeConnections.stripe_status_at, observedAt),
      ),
    );

  if (result.meta.changes) return { outcome: "applied" };
  return getIgnoredObservationResult(db, input);
}

export async function disconnectAccount(
  db: Database,
  connectionId: string,
  userId: string,
  now = new Date(),
): Promise<StripeConnection> {
  const existing = await getConnectionById(db, connectionId);
  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError("Stripe connection", connectionId);
  }
  if (existing.disconnect_operation_id !== null) {
    const operation = await getCurrentOperation(db, userId);
    if (
      operation?.id === existing.disconnect_operation_id &&
      operation.kind === "disconnect" &&
      operation.connection_id === connectionId
    ) {
      return existing;
    }
    throw new StripeConnectionOperationConflictError("pending_disconnect");
  }
  if (existing.disconnected_at !== null) {
    throw new ConflictError("Stripe connection is not active");
  }

  const disconnectedAt = now.toISOString();
  const disconnectOperationId = crypto.randomUUID();
  let reserved: typeof stripeConnections.$inferSelect | undefined;
  try {
    const results = await db.batch([
      db
        .delete(stripeConnectStates)
        .where(
          or(
            isNotNull(stripeConnectStates.completed_at),
            and(
              lte(stripeConnectStates.expires_at, disconnectedAt),
              isNull(stripeConnectStates.consumed_at),
              sql`NOT EXISTS (
                SELECT 1 FROM ${stripeConnectionOperations}
                WHERE ${stripeConnectionOperations.id} = ${stripeConnectStates.operation_id}
                  AND ${stripeConnectionOperations.kind} = 'connect'
                  AND ${stripeConnectionOperations.phase} = 'authorized'
                  AND ${stripeConnectionOperations.stripe_account_id} IS NOT NULL
              )`,
            ),
          ),
        ),
      db
        .delete(stripeConnectionOperations)
        .where(
          and(
            eq(stripeConnectionOperations.kind, "connect"),
            eq(stripeConnectionOperations.phase, "authorizing"),
            isNotNull(stripeConnectionOperations.expires_at),
            lte(stripeConnectionOperations.expires_at, disconnectedAt),
            sql`NOT EXISTS (
              SELECT 1 FROM ${stripeConnectStates}
              WHERE ${stripeConnectStates.operation_id} = ${stripeConnectionOperations.id}
                AND ${stripeConnectStates.consumed_at} IS NOT NULL
                AND ${stripeConnectStates.completed_at} IS NULL
            )`,
          ),
        ),
      db.insert(stripeConnectionOperations).select(sql`
        SELECT
          ${disconnectOperationId},
          ${userId},
          'disconnect',
          ${connectionId},
          NULL,
          'disconnecting',
          NULL,
          NULL,
          NULL,
          ${disconnectedAt}
        WHERE EXISTS (
          SELECT 1 FROM ${stripeConnections}
          WHERE ${stripeConnections.id} = ${connectionId}
            AND ${stripeConnections.user_id} = ${userId}
            AND ${stripeConnections.authorization_revision} = ${existing.authorization_revision}
            AND ${stripeConnections.disconnected_at} IS NULL
            AND ${stripeConnections.disconnect_operation_id} IS NULL
            AND ${stripePaymentWorkResolved(userId)}
        )
          AND NOT EXISTS (
            SELECT 1 FROM ${stripeConnectionOperations}
            WHERE ${stripeConnectionOperations.user_id} = ${userId}
          )
      `),
      db
        .update(stripeConnections)
        .set({
          disconnected_at: disconnectedAt,
          disconnect_operation_id: disconnectOperationId,
          disconnect_started_at: disconnectedAt,
          updated_at: disconnectedAt,
        })
        .where(
          and(
            eq(stripeConnections.id, connectionId),
            eq(stripeConnections.user_id, userId),
            isNull(stripeConnections.disconnected_at),
            isNull(stripeConnections.disconnect_operation_id),
            eq(
              stripeConnections.authorization_revision,
              existing.authorization_revision,
            ),
            stripePaymentWorkResolved(userId),
            sql`EXISTS (
              SELECT 1 FROM ${stripeConnectionOperations}
              WHERE ${stripeConnectionOperations.id} = ${disconnectOperationId}
                AND ${stripeConnectionOperations.user_id} = ${userId}
                AND ${stripeConnectionOperations.kind} = 'disconnect'
                AND ${stripeConnectionOperations.phase} = 'disconnecting'
                AND ${stripeConnectionOperations.connection_id} = ${connectionId}
            )`,
          ),
        )
        .returning(),
    ]);
    reserved = results[3][0];
  } catch (error) {
    const latest = await getConnectionById(db, connectionId);
    const operation = await getCurrentOperation(db, userId);
    if (
      latest &&
      operation &&
      latest.disconnect_operation_id !== null &&
      latest.disconnect_operation_id === operation.id &&
      operation.kind === "disconnect" &&
      operation.connection_id === connectionId
    ) {
      return latest;
    }
    if (operation) {
      throw new StripeConnectionOperationConflictError(
        operation.kind === "disconnect"
          ? "pending_disconnect"
          : "operation_in_progress",
      );
    }
    throw error;
  }

  if (!reserved) {
    await releaseOperation(db, disconnectOperationId, userId);
    const latest = await getConnectionById(db, connectionId);
    if (latest && latest.disconnect_operation_id !== null) {
      const operation = await getCurrentOperation(db, userId);
      if (
        latest.disconnect_operation_id === operation?.id &&
        operation.kind === "disconnect" &&
        operation.connection_id === connectionId
      ) {
        return latest;
      }
      throw new StripeConnectionOperationConflictError("pending_disconnect");
    }
    if (latest && latest.disconnected_at !== null) {
      throw new ConflictError("Stripe connection is not active");
    }
    const operation = await getCurrentOperation(db, userId);
    if (operation) {
      throw new StripeConnectionOperationConflictError(
        operation.kind === "disconnect"
          ? "pending_disconnect"
          : "operation_in_progress",
      );
    }

    throw new ConflictError(
      "Resolve sent invoices and pending Stripe payments before disconnecting",
    );
  }

  return asConnection(reserved);
}

export async function claimDisconnectAttempt(
  db: Database,
  input: DisconnectAttemptInput,
  now = new Date(),
): Promise<DisconnectAttempt> {
  const claimedAt = now.toISOString();
  const attemptId = crypto.randomUUID();
  const attemptExpiresAt = new Date(
    now.getTime() + DISCONNECT_ATTEMPT_TTL_MS,
  ).toISOString();
  const [operation] = await db
    .update(stripeConnectionOperations)
    .set({ attempt_id: attemptId, attempt_expires_at: attemptExpiresAt })
    .where(
      and(
        eq(stripeConnectionOperations.id, input.disconnectOperationId),
        eq(stripeConnectionOperations.user_id, input.userId),
        eq(stripeConnectionOperations.kind, "disconnect"),
        eq(stripeConnectionOperations.phase, "disconnecting"),
        eq(stripeConnectionOperations.connection_id, input.connectionId),
        or(
          isNull(stripeConnectionOperations.attempt_id),
          lte(stripeConnectionOperations.attempt_expires_at, claimedAt),
        ),
        sql`EXISTS (
          SELECT 1 FROM ${stripeConnections}
          WHERE ${stripeConnections.id} = ${input.connectionId}
            AND ${stripeConnections.user_id} = ${input.userId}
            AND ${stripeConnections.authorization_revision} = ${input.expectedAuthorizationRevision}
            AND ${stripeConnections.disconnect_operation_id} = ${input.disconnectOperationId}
            AND ${stripeConnections.disconnected_at} IS NOT NULL
        )`,
      ),
    )
    .returning();
  if (!operation) {
    throw new StripeConnectionOperationConflictError("operation_in_progress");
  }

  const connection = await getConnectionById(db, input.connectionId);
  if (!connection) {
    throw new NotFoundError("Stripe connection", input.connectionId);
  }
  return { connection, attemptId };
}

export async function releaseDisconnectAttempt(
  db: Database,
  input: FinalizeDisconnectedAccountInput,
): Promise<boolean> {
  const result = await db
    .update(stripeConnectionOperations)
    .set({ attempt_id: null, attempt_expires_at: null })
    .where(
      and(
        eq(stripeConnectionOperations.id, input.disconnectOperationId),
        eq(stripeConnectionOperations.user_id, input.userId),
        eq(stripeConnectionOperations.kind, "disconnect"),
        eq(stripeConnectionOperations.phase, "disconnecting"),
        eq(stripeConnectionOperations.connection_id, input.connectionId),
        eq(stripeConnectionOperations.attempt_id, input.attemptId),
      ),
    );
  return result.meta.changes === 1;
}

export async function finalizeDisconnectedAccount(
  db: Database,
  input: FinalizeDisconnectedAccountInput,
  now = new Date(),
): Promise<boolean> {
  const [rows] = await db.batch([
    db
      .update(stripeConnections)
      .set({
        disconnect_operation_id: null,
        disconnect_started_at: null,
        updated_at: now.toISOString(),
      })
      .where(
        and(
          eq(stripeConnections.id, input.connectionId),
          eq(stripeConnections.user_id, input.userId),
          eq(
            stripeConnections.authorization_revision,
            input.expectedAuthorizationRevision,
          ),
          eq(
            stripeConnections.disconnect_operation_id,
            input.disconnectOperationId,
          ),
          isNotNull(stripeConnections.disconnected_at),
          sql`EXISTS (
            SELECT 1 FROM ${stripeConnectionOperations}
            WHERE ${stripeConnectionOperations.id} = ${input.disconnectOperationId}
              AND ${stripeConnectionOperations.user_id} = ${input.userId}
              AND ${stripeConnectionOperations.kind} = 'disconnect'
              AND ${stripeConnectionOperations.phase} = 'disconnecting'
              AND ${stripeConnectionOperations.connection_id} = ${input.connectionId}
              AND ${stripeConnectionOperations.attempt_id} = ${input.attemptId}
              AND ${stripeConnectionOperations.attempt_expires_at} > ${now.toISOString()}
          )`,
        ),
      )
      .returning({ id: stripeConnections.id }),
    db
      .delete(stripeConnectionOperations)
      .where(
        and(
          eq(stripeConnectionOperations.id, input.disconnectOperationId),
          eq(stripeConnectionOperations.user_id, input.userId),
          eq(stripeConnectionOperations.kind, "disconnect"),
          eq(stripeConnectionOperations.phase, "disconnecting"),
          eq(stripeConnectionOperations.connection_id, input.connectionId),
          eq(stripeConnectionOperations.attempt_id, input.attemptId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${stripeConnections}
            WHERE ${stripeConnections.id} = ${input.connectionId}
              AND ${stripeConnections.disconnect_operation_id} = ${input.disconnectOperationId}
          )`,
        ),
      ),
  ]);

  return rows.length === 1;
}

export async function restoreDisconnectedAccount(
  db: Database,
  input: RestoreDisconnectedAccountInput,
  now = new Date(),
): Promise<boolean> {
  const restoredAt = now.toISOString();
  const observation = input.observation;
  const [rows] = await db.batch([
    db
      .update(stripeConnections)
      .set({
        disconnected_at: null,
        disconnect_operation_id: null,
        disconnect_started_at: null,
        updated_at: restoredAt,
        ...(observation ? { charges_enabled: observation.account.charges_enabled,
          payouts_enabled: observation.account.payouts_enabled, details_submitted: observation.account.details_submitted,
          requirements: observation.account.requirements ?? null,
          stripe_status_at: observation.observedAt.toISOString() } : {}),
      })
      .where(
        and(
          eq(stripeConnections.id, input.connectionId),
          eq(stripeConnections.user_id, input.userId),
          eq(
            stripeConnections.authorization_revision,
            input.expectedAuthorizationRevision,
          ),
          eq(
            stripeConnections.disconnect_operation_id,
            input.disconnectOperationId,
          ),
          isNotNull(stripeConnections.disconnected_at),
          ...(observation ? [eq(stripeConnections.stripe_account_id, observation.account.stripe_account_id),
            eq(stripeConnections.livemode, observation.account.livemode),
            lte(stripeConnections.stripe_status_at, observation.observedAt.toISOString())] : []),
          sql`EXISTS (
            SELECT 1 FROM ${stripeConnectionOperations}
            WHERE ${stripeConnectionOperations.id} = ${input.disconnectOperationId}
              AND ${stripeConnectionOperations.user_id} = ${input.userId}
              AND ${stripeConnectionOperations.kind} = 'disconnect'
              AND ${stripeConnectionOperations.phase} = 'disconnecting'
              AND ${stripeConnectionOperations.connection_id} = ${input.connectionId}
              AND ${stripeConnectionOperations.attempt_id} = ${input.attemptId}
              AND ${stripeConnectionOperations.attempt_expires_at} > ${restoredAt}
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${stripeConnections} AS active_connection
            WHERE active_connection.user_id = ${input.userId}
              AND active_connection.disconnected_at IS NULL
              AND active_connection.id != ${input.connectionId}
          )`,
        ),
      )
      .returning({ id: stripeConnections.id }),
    db
      .delete(stripeConnectionOperations)
      .where(
        and(
          eq(stripeConnectionOperations.id, input.disconnectOperationId),
          eq(stripeConnectionOperations.user_id, input.userId),
          eq(stripeConnectionOperations.kind, "disconnect"),
          eq(stripeConnectionOperations.phase, "disconnecting"),
          eq(stripeConnectionOperations.connection_id, input.connectionId),
          eq(stripeConnectionOperations.attempt_id, input.attemptId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${stripeConnections}
            WHERE ${stripeConnections.id} = ${input.connectionId}
              AND ${stripeConnections.disconnect_operation_id} = ${input.disconnectOperationId}
          )`,
        ),
      ),
  ]);

  return rows.length === 1;
}
