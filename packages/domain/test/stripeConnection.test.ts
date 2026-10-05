import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { createDb, type Database } from "../src/db/index.js";
import {
  apikeys,
  invoices,
  stripeConnectionOperations,
  stripeConnections,
  stripeConnectStates,
  users,
} from "../src/db/schema.js";
import { ConflictError, InvalidStripeConnectStateError } from "../src/errors.js";
import { deleteUser } from "../src/services/auth.js";
import * as stripeConnectionService from "../src/services/stripeConnection.js";
import type { StripeAccountStatus, StripeConnection } from "../src/types.js";
import { PAYMENT_GUARD_TABLES_SQL } from "./helpers/migrations.js";

const SCHEMA_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE apikeys (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE expenses (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_key TEXT
);
CREATE TABLE stripe_connections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_account_id TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  details_submitted INTEGER NOT NULL DEFAULT 0,
  requirements TEXT,
  disconnected_at TEXT,
  disconnect_operation_id TEXT,
  disconnect_started_at TEXT,
  authorization_revision TEXT NOT NULL,
  stripe_status_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_stripe_connections_account
  ON stripe_connections(stripe_account_id);
CREATE UNIQUE INDEX idx_stripe_connections_active_user
  ON stripe_connections(user_id) WHERE disconnected_at IS NULL;
CREATE TABLE stripe_connection_operations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('connect', 'disconnect')),
  connection_id TEXT REFERENCES stripe_connections(id),
  expires_at TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('authorizing', 'authorized', 'disconnecting')),
  stripe_account_id TEXT,
  attempt_id TEXT,
  attempt_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'connect' AND connection_id IS NULL AND expires_at IS NOT NULL)
    OR
    (kind = 'disconnect' AND connection_id IS NOT NULL AND expires_at IS NULL)
  ),
  CHECK (
    (kind = 'connect' AND ((phase = 'authorizing' AND stripe_account_id IS NULL) OR (phase = 'authorized' AND stripe_account_id IS NOT NULL)) AND attempt_id IS NULL AND attempt_expires_at IS NULL)
    OR
    (kind = 'disconnect' AND phase = 'disconnecting' AND stripe_account_id IS NULL AND ((attempt_id IS NULL AND attempt_expires_at IS NULL) OR (attempt_id IS NOT NULL AND attempt_expires_at IS NOT NULL)))
  )
);
CREATE TABLE stripe_connect_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  livemode INTEGER NOT NULL,
  operation_id TEXT REFERENCES stripe_connection_operations(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE invoices (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  pay_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_address TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT,
  due_date TEXT NOT NULL,
  issued_at TEXT,
  paid_at TEXT,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_connection_id TEXT REFERENCES stripe_connections(id),
  stripe_account_id TEXT,
  stripe_livemode INTEGER,
  stripe_charge_scope TEXT CHECK (stripe_charge_scope IN ('platform', 'connected')),
  stripe_checkout_attempt INTEGER NOT NULL DEFAULT 0,
  stripe_void_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const readyStatus = (stripeAccountId: string): StripeAccountStatus => ({
  stripe_account_id: stripeAccountId,
  livemode: false,
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
});

const rawState = (name: string) => `${name}-${"state".repeat(12)}`;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function resetDb() {
  await env.DB.prepare("DROP TABLE IF EXISTS invoice_checkout_attempts").run();
  await env.DB.prepare("DROP TABLE IF EXISTS stripe_webhook_events").run();
  await env.DB.prepare("DROP TABLE IF EXISTS invoice_legacy_session_evidence").run();
  await env.DB.prepare("DROP TABLE IF EXISTS invoices").run();
  await env.DB.prepare("DROP TABLE IF EXISTS stripe_connect_states").run();
  await env.DB.prepare("DROP TABLE IF EXISTS stripe_connection_operations").run();
  await env.DB.prepare("DROP TABLE IF EXISTS stripe_connections").run();
  await env.DB.prepare("DROP TABLE IF EXISTS expenses").run();
  await env.DB.prepare("DROP TABLE IF EXISTS apikeys").run();
  await env.DB.prepare("DROP TABLE IF EXISTS users").run();

  for (const statement of (SCHEMA_SQL + PAYMENT_GUARD_TABLES_SQL).split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
}

async function connectTestAccount(
  db: Database,
  input: Omit<stripeConnectionService.ConnectAccountInput, "operationId">,
  now = new Date(),
) {
  const stateInput = {
    state: rawState(`connect-${crypto.randomUUID()}`),
    userId: input.userId,
    livemode: input.livemode,
  };
  await stripeConnectionService.createOAuthState(db, stateInput, now);
  const state = await stripeConnectionService.consumeOAuthState(
    db,
    stateInput,
    now,
  );

  try {
    return await stripeConnectionService.connectAccount(
      db,
      { ...input, operationId: state.operation_id! },
      now,
    );
  } finally {
    await stripeConnectionService.completeOAuthState(
      db,
      {
        stateHash: state.state_hash,
        userId: input.userId,
        operationId: state.operation_id!,
      },
      now,
    );
  }
}

async function createAuthorizedOperation(
  db: Database,
  userId: string,
  stripeAccountId: string,
  livemode = false,
) {
  const stateInput = {
    state: rawState(`authorized-${crypto.randomUUID()}`),
    userId,
    livemode,
  };
  const state = await stripeConnectionService.createOAuthState(db, stateInput);
  await stripeConnectionService.consumeOAuthState(db, stateInput);
  await stripeConnectionService.recordAuthorizedAccount(db, {
    userId,
    operationId: state.operation_id!,
    stripeAccountId,
  });
  return state;
}

const stripeConnection = {
  ...stripeConnectionService,
  connectAccount: connectTestAccount,
};

async function createTestUser(email: string) {
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id,
    name: email.split("@")[0],
    email,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createInvoice(
  userId: string,
  connectionId: string,
  status: "draft" | "sent",
) {
  const db = createDb(env.DB);
  await db.insert(invoices).values({
    id: crypto.randomUUID(),
    user_id: userId,
    invoice_number: `INV-${crypto.randomUUID()}`,
    pay_token: crypto.randomUUID(),
    status,
    client_name: "Acme",
    client_email: "billing@acme.test",
    due_date: "2099-12-31",
    stripe_connection_id: connectionId,
  });
}

async function claimDisconnect(
  db: Database,
  connection: StripeConnection,
  reserved: StripeConnection,
  now = new Date(),
) {
  const input = {
    connectionId: connection.id,
    userId: connection.user_id,
    disconnectOperationId: reserved.disconnect_operation_id!,
    expectedAuthorizationRevision: connection.authorization_revision,
  };
  const attempt = await stripeConnectionService.claimDisconnectAttempt(
    db,
    input,
    now,
  );
  return { ...input, attemptId: attempt.attemptId };
}

describe("stripe connections", () => {
  beforeEach(resetDb);

  it("stores only a lowercase SHA-256 digest with an exact 10-minute expiry", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("state@test.com");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const stateValue = rawState("plaintext-oauth-state");

    const state = await stripeConnection.createOAuthState(
      db,
      { state: stateValue, userId, livemode: false },
      now,
    );

    const stored = await env.DB.prepare(
      "SELECT * FROM stripe_connect_states WHERE user_id = ?",
    )
      .bind(userId)
      .first<Record<string, unknown>>();
    const expectedDigest = await sha256(stateValue);

    expect(state.state_hash).toBe(expectedDigest);
    expect(stored?.state_hash).toBe(expectedDigest);
    expect(stored?.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(stateValue);
    expect(state.expires_at).toBe("2026-01-01T00:10:00.000Z");
    expect(state).not.toHaveProperty("state");
  });

  it("purges expired states without deleting an incomplete callback", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("state-retention@test.com");
    const expiredHash = await sha256(rawState("expired-retention"));
    const consumedHash = await sha256(rawState("consumed-retention"));
    const validHash = await sha256(rawState("valid-retention"));
    await db.insert(stripeConnectStates).values([
      {
        state_hash: expiredHash,
        user_id: userId,
        livemode: false,
        expires_at: "2026-01-01T00:09:59.999Z",
        consumed_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        state_hash: consumedHash,
        user_id: userId,
        livemode: false,
        expires_at: "2026-01-01T00:20:00.000Z",
        consumed_at: "2026-01-01T00:01:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        state_hash: validHash,
        user_id: userId,
        livemode: false,
        expires_at: "2026-01-01T00:20:00.000Z",
        consumed_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const created = await stripeConnection.createOAuthState(
      db,
      { state: rawState("new-retention"), userId, livemode: false },
      new Date("2026-01-01T00:10:00.000Z"),
    );

    const rows = await db
      .select({ state_hash: stripeConnectStates.state_hash })
      .from(stripeConnectStates);
    expect(rows.map((row) => row.state_hash).sort()).toEqual(
      [consumedHash, created.state_hash, validHash].sort(),
    );
  });

  it("atomically consumes a valid OAuth state exactly once", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("replay@test.com");
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const consumedAt = new Date("2026-01-01T00:01:00.000Z");
    const input = { state: rawState("replay"), userId, livemode: false };
    await stripeConnection.createOAuthState(db, input, createdAt);

    const consumed = await stripeConnection.consumeOAuthState(db, input, consumedAt);
    expect(consumed.consumed_at).toBe(consumedAt.toISOString());

    await expect(
      stripeConnection.consumeOAuthState(db, input, consumedAt),
    ).rejects.toBeInstanceOf(InvalidStripeConnectStateError);
  });

  it("rejects expired OAuth states, including at the expiry boundary", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("expired@test.com");
    const input = { state: rawState("expired"), userId, livemode: true };
    await stripeConnection.createOAuthState(
      db,
      input,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    await expect(
      stripeConnection.consumeOAuthState(
        db,
        input,
        new Date("2026-01-01T00:10:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(InvalidStripeConnectStateError);
  });

  it("binds OAuth state to both user and livemode without consuming on mismatch", async () => {
    const db = createDb(env.DB);
    const ownerId = await createTestUser("owner@test.com");
    const otherId = await createTestUser("other@test.com");
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const consumedAt = new Date("2026-01-01T00:01:00.000Z");
    const input = {
      state: rawState("bound"),
      userId: ownerId,
      livemode: true,
    };
    await stripeConnection.createOAuthState(db, input, createdAt);

    await expect(
      stripeConnection.consumeOAuthState(
        db,
        { ...input, userId: otherId },
        consumedAt,
      ),
    ).rejects.toBeInstanceOf(InvalidStripeConnectStateError);
    await expect(
      stripeConnection.consumeOAuthState(
        db,
        { ...input, livemode: false },
        consumedAt,
      ),
    ).rejects.toBeInstanceOf(InvalidStripeConnectStateError);

    await expect(
      stripeConnection.consumeOAuthState(db, input, consumedAt),
    ).resolves.toMatchObject({ user_id: ownerId, livemode: true });
  });

  it("allows exactly one concurrent consume for a single OAuth state", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("concurrent-state@test.com");
    const input = {
      state: rawState("concurrent-consume"),
      userId,
      livemode: false,
    };
    await stripeConnection.createOAuthState(
      db,
      input,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    const results = await Promise.allSettled([
      stripeConnection.consumeOAuthState(
        db,
        input,
        new Date("2026-01-01T00:01:00.000Z"),
      ),
      stripeConnection.consumeOAuthState(
        db,
        input,
        new Date("2026-01-01T00:01:00.000Z"),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.any(InvalidStripeConnectStateError),
    });
  });

  it("allows only one concurrent per-user operation acquisition", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("concurrent-operation@test.com");
    const now = new Date("2026-01-01T00:00:00.000Z");

    const results = await Promise.allSettled([
      stripeConnection.createOAuthState(
        db,
        { state: rawState("operation-a"), userId, livemode: false },
        now,
      ),
      stripeConnection.createOAuthState(
        db,
        { state: rawState("operation-b"), userId, livemode: false },
        now,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toMatchObject({
      kind: "connect",
      user_id: userId,
    });
    const states = await db
      .select()
      .from(stripeConnectStates)
      .where(eq(stripeConnectStates.user_id, userId));
    expect(states).toHaveLength(1);
  });

  it("expires an abandoned connect lock at the OAuth state boundary", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("expired-operation@test.com");
    const firstInput = {
      state: rawState("expired-operation-first"),
      userId,
      livemode: false,
    };
    const first = await stripeConnection.createOAuthState(
      db,
      firstInput,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const second = await stripeConnection.createOAuthState(
      db,
      {
        state: rawState("expired-operation-second"),
        userId,
        livemode: false,
      },
      new Date("2026-01-01T00:10:00.000Z"),
    );

    expect(second.operation_id).not.toBe(first.operation_id);
    await expect(
      stripeConnection.consumeOAuthState(
        db,
        firstInput,
        new Date("2026-01-01T00:10:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(InvalidStripeConnectStateError);
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toMatchObject({
      id: second.operation_id,
    });
  });

  it("validates and completes only the exact callback operation", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("complete-operation@test.com");
    const input = {
      state: rawState("complete-operation"),
      userId,
      livemode: false,
    };
    await stripeConnection.createOAuthState(
      db,
      input,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const consumed = await stripeConnection.consumeOAuthState(
      db,
      input,
      new Date("2026-01-01T00:01:00.000Z"),
    );

    await expect(
      stripeConnection.completeOAuthState(db, {
        stateHash: consumed.state_hash,
        userId,
        operationId: "wrong-operation",
      }),
    ).resolves.toBe(false);
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toMatchObject({
      id: consumed.operation_id,
      expires_at: "2026-01-01T00:11:00.000Z",
    });
    await expect(
      stripeConnection.completeOAuthState(
        db,
        {
          stateHash: consumed.state_hash,
          userId,
          operationId: consumed.operation_id!,
        },
        new Date("2026-01-01T00:02:00.000Z"),
      ),
    ).resolves.toBe(true);
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toBeNull();
    await expect(
      db
        .select()
        .from(stripeConnectStates)
        .where(eq(stripeConnectStates.state_hash, consumed.state_hash)),
    ).resolves.toEqual([
      expect.objectContaining({
        operation_id: null,
        completed_at: "2026-01-01T00:02:00.000Z",
      }),
    ]);
  });

  it("does not touch another operation when callback lock validation fails", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("invalid-callback-operation@test.com");
    const otherUserId = await createTestUser("other-callback-operation@test.com");
    const input = {
      state: rawState("invalid-callback-operation"),
      userId,
      livemode: false,
    };
    const state = await stripeConnection.createOAuthState(db, input);
    await db
      .delete(stripeConnectionOperations)
      .where(eq(stripeConnectionOperations.id, state.operation_id!));
    const otherState = await stripeConnection.createOAuthState(db, {
      state: rawState("other-callback-operation"),
      userId: otherUserId,
      livemode: false,
    });

    await expect(
      stripeConnection.consumeOAuthState(db, input),
    ).rejects.toBeInstanceOf(InvalidStripeConnectStateError);
    await expect(
      stripeConnection.getCurrentOperation(db, otherUserId),
    ).resolves.toMatchObject({ id: otherState.operation_id });
  });

  it("does not create a connection after its callback operation is released", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("released-callback-operation@test.com");
    const stateInput = {
      state: rawState("released-callback-operation"),
      userId,
      livemode: false,
    };
    await stripeConnectionService.createOAuthState(
      db,
      stateInput,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const state = await stripeConnectionService.consumeOAuthState(
      db,
      stateInput,
      new Date("2026-01-01T00:01:00.000Z"),
    );

    const connection = stripeConnectionService.connectAccount(
      db,
      {
        userId,
        operationId: state.operation_id!,
        ...readyStatus("acct_released_callback"),
      },
      new Date("2026-01-01T00:02:00.000Z"),
    );
    await db
      .delete(stripeConnectionOperations)
      .where(eq(stripeConnectionOperations.id, state.operation_id!));

    await expect(connection).rejects.toMatchObject({
      reason: "operation_in_progress",
    });
    await expect(stripeConnection.getActiveConnection(db, userId)).resolves.toBeNull();
  });

  it("persists authorization before account retrieval and allows callback recovery", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("recoverable-callback@test.com");
    const input = {
      state: rawState("recoverable-callback"),
      userId,
      livemode: false,
    };
    const state = await stripeConnectionService.createOAuthState(
      db,
      input,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await stripeConnectionService.consumeOAuthState(
      db,
      input,
      new Date("2026-01-01T00:01:00.000Z"),
    );
    await stripeConnectionService.recordAuthorizedAccount(
      db,
      {
        userId,
        operationId: state.operation_id!,
        stripeAccountId: "acct_recoverable_callback",
      },
    );

    await expect(
      stripeConnectionService.getCurrentOperation(db, userId),
    ).resolves.toMatchObject({
      id: state.operation_id,
      phase: "authorized",
      stripe_account_id: "acct_recoverable_callback",
    });
    await expect(
      stripeConnectionService.consumeOAuthState(
        db,
        input,
        new Date("2026-01-01T00:20:00.000Z"),
      ),
    ).resolves.toMatchObject({ operation_id: state.operation_id });

    const persisted = await stripeConnectionService.persistAuthorizedConnection(
      db,
      {
        userId,
        operationId: state.operation_id!,
        livemode: false,
      },
      new Date("2026-01-01T00:20:00.000Z"),
    );
    expect(persisted).toMatchObject({
      outcome: "persisted",
      connection: {
        stripe_account_id: "acct_recoverable_callback",
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      },
    });
  });

  it("retains an authorized operation when local connection persistence fails", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("persistence-failure@test.com");
    const input = {
      state: rawState("persistence-failure"),
      userId,
      livemode: false,
    };
    const state = await stripeConnectionService.createOAuthState(db, input);
    await stripeConnectionService.consumeOAuthState(db, input);
    await stripeConnectionService.recordAuthorizedAccount(db, {
      userId,
      operationId: state.operation_id!,
      stripeAccountId: "acct_unpersisted_authorization",
    });
    await db.insert(stripeConnections).values({
      id: crypto.randomUUID(),
      user_id: userId,
      stripe_account_id: "acct_raced_active_connection",
      livemode: false,
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      authorization_revision: crypto.randomUUID(),
      stripe_status_at: new Date().toISOString(),
    });

    await expect(
      stripeConnectionService.persistAuthorizedConnection(db, {
        userId,
        operationId: state.operation_id!,
        livemode: false,
      }),
    ).rejects.toMatchObject({ reason: "active_connection" });
    await expect(
      stripeConnectionService.getCurrentOperation(db, userId),
    ).resolves.toMatchObject({
      phase: "authorized",
      stripe_account_id: "acct_unpersisted_authorization",
    });
  });

  it("finds only the exact user's unresolved authorized operation", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("authorized-query@test.com");
    const otherUserId = await createTestUser("authorized-query-other@test.com");
    const state = await createAuthorizedOperation(
      db,
      userId,
      "acct_authorized_query",
    );

    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, userId),
    ).resolves.toEqual({
      operationId: state.operation_id,
      stripeAccountId: "acct_authorized_query",
      livemode: false,
      phase: "authorized",
    });
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, otherUserId),
    ).resolves.toBeNull();
  });

  it("finds a consumed incomplete connect operation before its account ID is recorded", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("authorizing-query@test.com");
    const input = {
      state: rawState("authorizing-query"),
      userId,
      livemode: false,
    };
    const state = await stripeConnectionService.createOAuthState(db, input);
    await stripeConnectionService.consumeOAuthState(db, input);

    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, userId),
    ).resolves.toEqual({
      operationId: state.operation_id,
      stripeAccountId: null,
      livemode: false,
      phase: "authorizing",
    });
  });

  it("never clears an unknown account authorization from a user assertion", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("resolve-authorizing@test.com");
    const otherUserId = await createTestUser(
      "resolve-authorizing-other@test.com",
    );
    const input = {
      state: rawState("resolve-authorizing"),
      userId,
      livemode: false,
    };
    const state = await stripeConnectionService.createOAuthState(db, input);
    await stripeConnectionService.consumeOAuthState(db, input);

    await expect(
      stripeConnectionService.completeUnconfirmedConnectOperation(db, {
        userId: otherUserId,
        operationId: state.operation_id!,
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnectionService.completeUnconfirmedConnectOperation(db, {
        userId,
        operationId: "wrong-operation",
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnectionService.getAccountDeletionBlock(db, userId),
    ).resolves.toBe("authorized_connection");

    const authorizedState = await createAuthorizedOperation(
      db,
      otherUserId,
      "acct_resolve_authorized",
    );
    await expect(
      stripeConnectionService.completeUnconfirmedConnectOperation(db, {
        userId: otherUserId,
        operationId: authorizedState.operation_id!,
      }),
    ).resolves.toBe(false);

    const unconsumedUserId = await createTestUser(
      "resolve-authorizing-unconsumed@test.com",
    );
    const unconsumedState =
      await stripeConnectionService.createOAuthState(db, {
        state: rawState("resolve-authorizing-unconsumed"),
        userId: unconsumedUserId,
        livemode: false,
      });
    await expect(
      stripeConnectionService.completeUnconfirmedConnectOperation(db, {
        userId: unconsumedUserId,
        operationId: unconsumedState.operation_id!,
      }),
    ).resolves.toBe(false);

    await expect(
      stripeConnectionService.completeUnconfirmedConnectOperation(db, {
        userId,
        operationId: state.operation_id!,
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, userId),
    ).resolves.toMatchObject({ operationId: state.operation_id, phase: "authorizing", stripeAccountId: null });
    await expect(
      stripeConnectionService.getAccountDeletionBlock(db, userId),
    ).resolves.toBe("authorized_connection");
    await expect(
      db
        .select({ completedAt: stripeConnectStates.completed_at })
        .from(stripeConnectStates)
        .where(eq(stripeConnectStates.state_hash, state.state_hash)),
    ).resolves.toEqual([{ completedAt: null }]);
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, otherUserId),
    ).resolves.toMatchObject({ phase: "authorized" });
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(
        db,
        unconsumedUserId,
      ),
    ).resolves.toBeNull();
  });

  it("completes only the exact deauthorized connect operation and retains the active connection", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("deauthorized-operation@test.com");
    const state = await createAuthorizedOperation(
      db,
      userId,
      "acct_extra_authorization",
    );
    const activeConnectionId = crypto.randomUUID();
    await db.insert(stripeConnections).values({
      id: activeConnectionId,
      user_id: userId,
      stripe_account_id: "acct_legitimate_active",
      livemode: false,
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      authorization_revision: crypto.randomUUID(),
      stripe_status_at: new Date().toISOString(),
    });

    await expect(
      stripeConnectionService.completeDeauthorizedConnectOperation(db, {
        userId,
        operationId: "wrong-operation",
        stripeAccountId: "acct_extra_authorization",
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnectionService.completeDeauthorizedConnectOperation(db, {
        userId,
        operationId: state.operation_id!,
        stripeAccountId: "acct_wrong_authorization",
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, userId),
    ).resolves.toMatchObject({ operationId: state.operation_id });

    await expect(
      stripeConnectionService.completeDeauthorizedConnectOperation(db, {
        userId,
        operationId: state.operation_id!,
        stripeAccountId: "acct_extra_authorization",
      }),
    ).resolves.toBe(true);
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, userId),
    ).resolves.toBeNull();
    await expect(
      stripeConnectionService.getActiveConnection(db, userId),
    ).resolves.toMatchObject({
      id: activeConnectionId,
      stripe_account_id: "acct_legitimate_active",
    });
  });

  it("retains a persisted authorized operation after a transient failure and completes it on retry", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("authorized-retry@test.com");
    const state = await createAuthorizedOperation(
      db,
      userId,
      "acct_authorized_retry",
    );
    const persisted = await stripeConnectionService.persistAuthorizedConnection(
      db,
      {
        userId,
        operationId: state.operation_id!,
        livemode: false,
      },
      new Date("2026-01-01T00:01:00.000Z"),
    );
    if (persisted.outcome !== "persisted") {
      throw new Error("Expected the authorized connection to persist");
    }

    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, userId),
    ).resolves.toMatchObject({ operationId: state.operation_id });
    await expect(
      stripeConnectionService.getCurrentUiConnection(db, userId),
    ).resolves.toMatchObject({
      id: persisted.connection.id,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
    });

    const retryPersisted =
      await stripeConnectionService.persistAuthorizedConnection(db, {
        userId,
        operationId: state.operation_id!,
        livemode: false,
      });
    expect(retryPersisted).toMatchObject({
      outcome: "persisted",
      connection: { id: persisted.connection.id },
    });

    const observedAt = new Date("2026-01-01T00:02:00.000Z");
    await expect(
      stripeConnectionService.updateAuthorizedAccountStatus(db, {
        userId,
        operationId: state.operation_id!,
        ...readyStatus("acct_authorized_retry"),
        expectedAuthorizationRevision:
          persisted.connection.authorization_revision,
        observedAt,
      }),
    ).resolves.toEqual({ outcome: "applied" });
    await expect(
      stripeConnectionService.completeAuthorizedConnection(
        db,
        {
          userId,
          operationId: state.operation_id!,
          connectionId: persisted.connection.id,
          expectedAuthorizationRevision:
            persisted.connection.authorization_revision,
        },
        observedAt,
      ),
    ).resolves.toBe(true);
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, userId),
    ).resolves.toBeNull();
    await expect(
      stripeConnectionService.getCurrentUiConnection(db, userId),
    ).resolves.toMatchObject({
      id: persisted.connection.id,
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
  });

  it("finishes an ownership conflict without changing the owner's connection", async () => {
    const db = createDb(env.DB);
    const ownerId = await createTestUser("authorized-owner@test.com");
    const otherUserId = await createTestUser("authorized-conflict@test.com");
    const owner = await stripeConnection.connectAccount(db, {
      userId: ownerId,
      ...readyStatus("acct_authorized_owner"),
    });
    const state = await createAuthorizedOperation(
      db,
      otherUserId,
      "acct_authorized_owner",
    );

    await expect(
      stripeConnectionService.persistAuthorizedConnection(db, {
        userId: otherUserId,
        operationId: state.operation_id!,
        livemode: false,
      }),
    ).resolves.toEqual({ outcome: "owner_conflict" });
    await expect(
      stripeConnectionService.completeAuthorizedConnectionConflict(db, {
        userId: otherUserId,
        operationId: state.operation_id!,
      }),
    ).resolves.toBe(true);
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, otherUserId),
    ).resolves.toBeNull();
    await expect(
      stripeConnectionService.getConnectionById(db, owner.id),
    ).resolves.toEqual(owner);
  });

  it("requires the exact user, operation, and authorization revision to refresh and complete recovery", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("authorized-lock@test.com");
    const otherUserId = await createTestUser("authorized-lock-other@test.com");
    const state = await createAuthorizedOperation(
      db,
      userId,
      "acct_authorized_lock",
    );
    const persisted = await stripeConnectionService.persistAuthorizedConnection(
      db,
      {
        userId,
        operationId: state.operation_id!,
        livemode: false,
      },
    );
    if (persisted.outcome !== "persisted") {
      throw new Error("Expected the authorized connection to persist");
    }
    const status = {
      ...readyStatus("acct_authorized_lock"),
      expectedAuthorizationRevision:
        persisted.connection.authorization_revision,
      observedAt: new Date("2026-01-01T00:03:00.000Z"),
    };

    await expect(
      stripeConnectionService.updateAuthorizedAccountStatus(db, {
        ...status,
        userId: otherUserId,
        operationId: state.operation_id!,
      }),
    ).resolves.toMatchObject({ outcome: "ignored" });
    await expect(
      stripeConnectionService.completeAuthorizedConnection(db, {
        userId: otherUserId,
        operationId: state.operation_id!,
        connectionId: persisted.connection.id,
        expectedAuthorizationRevision:
          persisted.connection.authorization_revision,
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnectionService.completeAuthorizedConnection(db, {
        userId,
        operationId: state.operation_id!,
        connectionId: persisted.connection.id,
        expectedAuthorizationRevision: "wrong-revision",
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnectionService.getCurrentAuthorizedOperation(db, userId),
    ).resolves.toMatchObject({ operationId: state.operation_id });
  });

  it("rejects a cross-user account claim without changing active bindings", async () => {
    const db = createDb(env.DB);
    const ownerId = await createTestUser("claim-owner@test.com");
    const otherId = await createTestUser("claim-other@test.com");
    const owner = await stripeConnection.connectAccount(db, {
      userId: ownerId,
      ...readyStatus("acct_owned"),
    });
    const other = await stripeConnection.connectAccount(db, {
      userId: otherId,
      ...readyStatus("acct_other"),
    });

    await expect(
      stripeConnection.connectAccount(db, {
        userId: otherId,
        ...readyStatus("acct_owned"),
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(stripeConnection.getActiveConnection(db, ownerId)).resolves.toMatchObject({
      id: owner.id,
    });
    await expect(stripeConnection.getActiveConnection(db, otherId)).resolves.toMatchObject({
      id: other.id,
    });
  });

  it("allows exactly one concurrent account owner", async () => {
    const db = createDb(env.DB);
    const firstUserId = await createTestUser("race-first@test.com");
    const secondUserId = await createTestUser("race-second@test.com");
    const inputs = [
      { userId: firstUserId, ...readyStatus("acct_competing") },
      { userId: secondUserId, ...readyStatus("acct_competing") },
    ] as const;

    const results = await Promise.allSettled(
      inputs.map((input) => stripeConnection.connectAccount(db, input)),
    );

    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const loserIndex = results.findIndex((result) => result.status === "rejected");
    expect(winnerIndex).not.toBe(-1);
    expect(loserIndex).not.toBe(-1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results[loserIndex]).toMatchObject({
      reason: expect.any(ConflictError),
    });

    const winnerUserId = inputs[winnerIndex].userId;
    const loserUserId = inputs[loserIndex].userId;
    await expect(
      stripeConnection.getConnectionByAccountId(db, "acct_competing"),
    ).resolves.toMatchObject({ user_id: winnerUserId });
    await expect(
      stripeConnection.getActiveConnection(db, loserUserId),
    ).resolves.toBeNull();
  });

  it("preserves global account ownership after external deauthorization", async () => {
    const db = createDb(env.DB);
    const ownerId = await createTestUser("history-owner@test.com");
    const otherId = await createTestUser("history-other@test.com");
    const owner = await stripeConnection.connectAccount(
      db,
      { userId: ownerId, ...readyStatus("acct_historical_owner") },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: owner.stripe_account_id,
        livemode: false,
        expectedAuthorizationRevision: owner.authorization_revision,
      },
      new Date("2026-01-01T01:00:00.000Z"),
    );

    await expect(
      stripeConnection.connectAccount(db, {
        userId: otherId,
        ...readyStatus(owner.stripe_account_id),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      stripeConnection.getConnectionByAccountId(db, owner.stripe_account_id),
    ).resolves.toMatchObject({ id: owner.id, user_id: ownerId });
  });

  it("reactivates the same account row and refreshes its status", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("reactivate@test.com");
    const first = await stripeConnection.connectAccount(
      db,
      { userId, ...readyStatus("acct_same") },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: "acct_same",
        livemode: false,
        expectedAuthorizationRevision: first.authorization_revision,
      },
      new Date("2026-01-01T01:00:00.000Z"),
    );

    const reactivated = await stripeConnection.connectAccount(
      db,
      {
        userId,
        ...readyStatus("acct_same"),
        payouts_enabled: false,
      },
      new Date("2026-01-01T02:00:00.000Z"),
    );

    expect(reactivated.id).toBe(first.id);
    expect(reactivated.created_at).toBe(first.created_at);
    expect(first.authorization_revision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(reactivated.authorization_revision).not.toBe(
      first.authorization_revision,
    );
    expect(reactivated.disconnected_at).toBeNull();
    expect(reactivated.payouts_enabled).toBe(false);
    const rows = await db.select().from(stripeConnections);
    expect(rows).toHaveLength(1);
  });

  it("rejects OAuth start while an account is active and releases the lock", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("switch@test.com");
    const first = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_first"),
    });

    await expect(
      stripeConnection.createOAuthState(db, {
        state: rawState("active-switch"),
        userId,
        livemode: false,
      }),
    ).rejects.toMatchObject({ reason: "active_connection" });
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toBeNull();
    await expect(stripeConnection.getActiveConnection(db, userId)).resolves.toMatchObject({
      id: first.id,
    });
  });

  it("rejects concurrent account switches without changing the active row", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("same-user-race@test.com");
    const initial = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_race_initial"),
    });

    const results = await Promise.allSettled([
      stripeConnection.connectAccount(db, {
        userId,
        ...readyStatus("acct_race_a"),
      }),
      stripeConnection.connectAccount(db, {
        userId,
        ...readyStatus("acct_race_b"),
      }),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const rows = (await db.select().from(stripeConnections)).filter(
      (row) => row.user_id === userId,
    );
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => row.disconnected_at === null)).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: initial.id,
      stripe_account_id: "acct_race_initial",
    });
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toBeNull();
  });

  it("requires active authorization and matching mode, with capability checks only for live payments", async () => {
    const base: StripeConnection = {
      id: "connection",
      user_id: "user",
      ...readyStatus("acct_ready"),
      disconnected_at: null,
      disconnect_operation_id: null,
      disconnect_started_at: null,
      authorization_revision: "revision",
      stripe_status_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    expect(stripeConnection.isConnectionReady(base, false)).toBe(true);
    expect(stripeConnection.isConnectionReady(base, true)).toBe(false);
    expect(stripeConnection.getConnectionStatus(base, null)).toMatchObject({
      mode_matches: false,
      disconnect_pending: false,
      ready: false,
    });
    expect(
      stripeConnection.getConnectionStatus(
        {
          ...base,
          disconnected_at: "now",
          disconnect_operation_id: "operation",
          disconnect_started_at: "now",
        },
        false,
      ),
    ).toMatchObject({
      active: false,
      disconnect_pending: true,
      ready: false,
    });
    expect(
      stripeConnection.isConnectionReady({ ...base, disconnected_at: "now" }, false),
    ).toBe(false);
    expect(
      stripeConnection.isConnectionReady({ ...base, disconnect_started_at: "now" }, false),
    ).toBe(false);
    expect(stripeConnection.isConnectionReady({ ...base, charges_enabled: false,
      payouts_enabled: false, details_submitted: false }, false)).toBe(true);
    expect(
      stripeConnection.isConnectionReady({ ...base, livemode: true, details_submitted: false }, true),
    ).toBe(false);
    expect(
      stripeConnection.isConnectionReady({ ...base, livemode: true, charges_enabled: false }, true),
    ).toBe(false);
    expect(
      stripeConnection.isConnectionReady({ ...base, livemode: true, payouts_enabled: false }, true),
    ).toBe(false);
  });

  it("applies in-order account status and deauthorization observations", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("status@test.com");
    const connection = await stripeConnection.connectAccount(
      db,
      {
        userId,
        ...readyStatus("acct_status"),
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );

    const updated = await stripeConnection.updateAccountStatus(db, {
      ...readyStatus("acct_status"),
      expectedAuthorizationRevision: connection.authorization_revision,
      observedAt: new Date("2026-01-01T00:01:00.000Z"),
    });

    expect(updated).toEqual({ outcome: "applied" });
    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      id: connection.id,
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      stripe_status_at: "2026-01-01T00:01:00.000Z",
    });

    const deauthorized = await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: "acct_status",
        livemode: false,
        expectedAuthorizationRevision: connection.authorization_revision,
      },
      new Date("2026-01-01T00:02:00.000Z"),
    );

    expect(deauthorized).toEqual({ outcome: "applied" });
    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      disconnected_at: "2026-01-01T00:02:00.000Z",
      stripe_status_at: "2026-01-01T00:02:00.000Z",
    });
  });

  it("ignores mode-mismatched account observations", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("status-mode@test.com");
    const connection = await stripeConnection.connectAccount(
      db,
      { userId, ...readyStatus("acct_status_mode") },
      new Date("2026-01-01T00:00:00.000Z"),
    );

    const statusResult = await stripeConnection.updateAccountStatus(db, {
      ...readyStatus("acct_status_mode"),
      livemode: true,
      charges_enabled: false,
      expectedAuthorizationRevision: connection.authorization_revision,
      observedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    const deauthorizationResult =
      await stripeConnection.markExternalDeauthorization(
        db,
        {
          stripeAccountId: "acct_status_mode",
          livemode: true,
          expectedAuthorizationRevision: connection.authorization_revision,
        },
        new Date("2026-01-01T00:02:00.000Z"),
      );

    expect(statusResult).toEqual({ outcome: "ignored", reason: "mode_mismatch" });
    expect(deauthorizationResult).toEqual({
      outcome: "ignored",
      reason: "mode_mismatch",
    });
    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      livemode: false,
      charges_enabled: true,
      disconnected_at: null,
      stripe_status_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("ignores an old-generation deauthorization after a same-second reconnect", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("delayed-deauth@test.com");
    const account = readyStatus("acct_delayed_deauth");
    const initial = await stripeConnection.connectAccount(
      db,
      { userId, ...account },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: account.stripe_account_id,
        livemode: false,
        expectedAuthorizationRevision: initial.authorization_revision,
      },
      new Date("2026-01-01T00:00:00.400Z"),
    );
    const reconnected = await stripeConnection.connectAccount(
      db,
      { userId, ...account },
      new Date("2026-01-01T00:00:00.700Z"),
    );

    const delayed = await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: account.stripe_account_id,
        livemode: false,
        expectedAuthorizationRevision: initial.authorization_revision,
      },
      new Date("2026-01-01T00:00:00.900Z"),
    );

    expect(delayed).toEqual({
      outcome: "ignored",
      reason: "authorization_revision_mismatch",
    });
    await expect(
      stripeConnection.getConnectionById(db, reconnected.id),
    ).resolves.toMatchObject({
      disconnected_at: null,
      authorization_revision: reconnected.authorization_revision,
      stripe_status_at: "2026-01-01T00:00:00.700Z",
    });
  });

  it("ignores an old-generation status lookup after a same-second reconnect", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("old-generation-status@test.com");
    const account = readyStatus("acct_old_generation_status");
    const initial = await stripeConnection.connectAccount(
      db,
      { userId, ...account, charges_enabled: false },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: account.stripe_account_id,
        livemode: false,
        expectedAuthorizationRevision: initial.authorization_revision,
      },
      new Date("2026-01-01T00:00:00.200Z"),
    );
    const reconnected = await stripeConnection.connectAccount(
      db,
      { userId, ...account },
      new Date("2026-01-01T00:00:00.400Z"),
    );

    const oldGeneration = await stripeConnection.updateAccountStatus(db, {
      ...account,
      charges_enabled: false,
      expectedAuthorizationRevision: initial.authorization_revision,
      observedAt: new Date("2026-01-01T00:00:00.800Z"),
    });

    expect(oldGeneration).toEqual({
      outcome: "ignored",
      reason: "authorization_revision_mismatch",
    });
    await expect(
      stripeConnection.getConnectionById(db, reconnected.id),
    ).resolves.toMatchObject({
      charges_enabled: true,
      authorization_revision: reconnected.authorization_revision,
      stripe_status_at: "2026-01-01T00:00:00.400Z",
    });
  });

  it("orders same-generation account lookups at millisecond precision", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("stale-status@test.com");
    const account = readyStatus("acct_stale_status");
    const connection = await stripeConnection.connectAccount(
      db,
      { userId, ...account, charges_enabled: false },
      new Date("2026-01-01T00:00:00.100Z"),
    );

    const newer = await stripeConnection.updateAccountStatus(db, {
      ...account,
      requirements: { disabled_reason: null, currently_due: [], past_due: [], pending_verification: [], errors: [] },
      expectedAuthorizationRevision: connection.authorization_revision,
      observedAt: new Date("2026-01-01T00:00:00.900Z"),
    });
    const staleAfterNewer = await stripeConnection.updateAccountStatus(db, {
      ...account,
      charges_enabled: false,
      requirements: { disabled_reason: "requirements.past_due", currently_due: ["individual.verification.document"],
        past_due: ["individual.verification.document"], pending_verification: [], errors: [] },
      expectedAuthorizationRevision: connection.authorization_revision,
      observedAt: new Date("2026-01-01T00:00:00.899Z"),
    });

    expect(newer).toEqual({ outcome: "applied" });
    expect(staleAfterNewer).toEqual({ outcome: "ignored", reason: "stale" });
    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      charges_enabled: true,
      stripe_status_at: "2026-01-01T00:00:00.900Z",
      requirements: { disabled_reason: null, currently_due: [], past_due: [], pending_verification: [], errors: [] },
    });
  });

  it("persists requirements and clears them when a fresh observation has none", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("requirements@test.com");
    const account = { ...readyStatus("acct_requirements"), requirements: {
      disabled_reason: "requirements.past_due", currently_due: ["individual.verification.document"],
      past_due: ["individual.verification.document"], pending_verification: [],
      errors: [{ code: "verification_failed_keyed_identity", requirement: "individual.verification.document" }],
    } };
    const connection = await stripeConnection.connectAccount(db, { userId, ...account }, new Date("2026-01-01T00:00:00.000Z"));
    expect(connection.requirements).toEqual(account.requirements);
    const observation = { ...readyStatus(account.stripe_account_id), requirements: null,
      expectedAuthorizationRevision: connection.authorization_revision, observedAt: new Date("2026-01-01T00:01:00.000Z") };
    await stripeConnection.updateAccountStatus(db, { ...observation, expectedAuthorizationRevision: "old_revision" });
    expect((await stripeConnection.getConnectionById(db, connection.id))?.requirements).toEqual(account.requirements);
    await stripeConnection.updateAccountStatus(db, observation);
    expect((await stripeConnection.getConnectionById(db, connection.id))?.requirements).toBeNull();
  });

  it("keeps the newest concurrent account status observation", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("concurrent-status@test.com");
    const connection = await stripeConnection.connectAccount(
      db,
      {
        userId,
        ...readyStatus("acct_concurrent_status"),
        charges_enabled: false,
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );

    const results = await Promise.all([
      stripeConnection.updateAccountStatus(db, {
        ...readyStatus("acct_concurrent_status"),
        charges_enabled: false,
        expectedAuthorizationRevision: connection.authorization_revision,
        observedAt: new Date("2026-01-01T00:01:00.000Z"),
      }),
      stripeConnection.updateAccountStatus(db, {
        ...readyStatus("acct_concurrent_status"),
        expectedAuthorizationRevision: connection.authorization_revision,
        observedAt: new Date("2026-01-01T00:02:00.000Z"),
      }),
    ]);

    expect(results[1]).toEqual({ outcome: "applied" });
    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      charges_enabled: true,
      stripe_status_at: "2026-01-01T00:02:00.000Z",
    });
  });

  it("blocks manual disconnect while a sent invoice references the binding", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("guard@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_guard"),
    });
    await createInvoice(userId, connection.id, "sent");

    await expect(
      stripeConnection.disconnectAccount(db, connection.id, userId),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(stripeConnection.getActiveConnection(db, userId)).resolves.toMatchObject({
      id: connection.id,
    });
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toBeNull();
  });

  it("reserves a manual disconnect when only draft invoices reference the binding", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("draft@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_draft"),
    });
    await createInvoice(userId, connection.id, "draft");

    const reserved = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
      new Date("2026-01-01T00:01:00.000Z"),
    );

    expect(reserved).toMatchObject({
      disconnected_at: "2026-01-01T00:01:00.000Z",
      disconnect_started_at: "2026-01-01T00:01:00.000Z",
      disconnect_operation_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    await expect(stripeConnection.getActiveConnection(db, userId)).resolves.toBeNull();
    await expect(
      stripeConnection.getCurrentUiConnection(db, userId),
    ).resolves.toMatchObject({ id: connection.id });
  });

  it("allows only one disconnect network attempt until its lease expires", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("disconnect-lease@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_disconnect_lease"),
    });
    const reserved = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
      new Date("2026-01-01T00:01:00.000Z"),
    );
    const input = {
      connectionId: connection.id,
      userId,
      disconnectOperationId: reserved.disconnect_operation_id!,
      expectedAuthorizationRevision: connection.authorization_revision,
    };
    const attempts = await Promise.allSettled([
      stripeConnection.claimDisconnectAttempt(
        db,
        input,
        new Date("2026-01-01T00:01:01.000Z"),
      ),
      stripeConnection.claimDisconnectAttempt(
        db,
        input,
        new Date("2026-01-01T00:01:01.000Z"),
      ),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(
      stripeConnection.claimDisconnectAttempt(
        db,
        input,
        new Date("2026-01-01T00:02:00.999Z"),
      ),
    ).rejects.toMatchObject({ reason: "operation_in_progress" });

    const first = attempts.find(
      (result): result is PromiseFulfilledResult<
        stripeConnectionService.DisconnectAttempt
      > => result.status === "fulfilled",
    )!.value;
    const recovered = await stripeConnection.claimDisconnectAttempt(
      db,
      input,
      new Date("2026-01-01T00:02:01.000Z"),
    );
    await expect(
      stripeConnection.finalizeDisconnectedAccount(
        db,
        { ...input, attemptId: first.attemptId },
        new Date("2026-01-01T00:02:01.000Z"),
      ),
    ).resolves.toBe(false);
    await expect(
      stripeConnection.finalizeDisconnectedAccount(
        db,
        { ...input, attemptId: recovered.attemptId },
        new Date("2026-01-01T00:02:01.001Z"),
      ),
    ).resolves.toBe(true);
  });

  it("releases only the attempt lease after an ambiguous disconnect", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("disconnect-release@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_disconnect_release"),
    });
    const reserved = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
    );
    const operation = await claimDisconnect(db, connection, reserved);

    await expect(
      stripeConnection.releaseDisconnectAttempt(db, operation),
    ).resolves.toBe(true);
    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      disconnected_at: expect.any(String),
      disconnect_operation_id: reserved.disconnect_operation_id,
    });
    await expect(
      stripeConnection.getCurrentOperation(db, userId),
    ).resolves.toMatchObject({
      id: reserved.disconnect_operation_id,
      attempt_id: null,
      attempt_expires_at: null,
    });
  });

  it("blocks account deletion for unresolved Stripe state but not history", async () => {
    const db = createDb(env.DB);
    const activeUserId = await createTestUser("delete-active@test.com");
    const active = await stripeConnection.connectAccount(db, {
      userId: activeUserId,
      ...readyStatus("acct_delete_active"),
    });
    await expect(
      stripeConnection.getAccountDeletionBlock(db, activeUserId),
    ).resolves.toBe("active_connection");

    const pending = await stripeConnection.disconnectAccount(
      db,
      active.id,
      activeUserId,
    );
    await expect(
      stripeConnection.getAccountDeletionBlock(db, activeUserId),
    ).resolves.toBe("pending_disconnect");

    const operation = await claimDisconnect(db, active, pending);
    await stripeConnection.finalizeDisconnectedAccount(db, operation);
    await expect(
      stripeConnection.getAccountDeletionBlock(db, activeUserId),
    ).resolves.toBeNull();

    const authorizedUserId = await createTestUser("delete-authorized@test.com");
    const stateInput = {
      state: rawState("delete-authorized"),
      userId: authorizedUserId,
      livemode: false,
    };
    const state = await stripeConnection.createOAuthState(db, stateInput);
    await stripeConnection.consumeOAuthState(db, stateInput);
    await stripeConnection.recordAuthorizedAccount(db, {
      userId: authorizedUserId,
      operationId: state.operation_id!,
      stripeAccountId: "acct_delete_authorized",
    });
    await expect(
      stripeConnection.getAccountDeletionBlock(db, authorizedUserId),
    ).resolves.toBe("authorized_connection");

    const authorizingUserId = await createTestUser(
      "delete-authorizing@test.com",
    );
    const authorizingInput = {
      state: rawState("delete-authorizing"),
      userId: authorizingUserId,
      livemode: false,
    };
    await stripeConnection.createOAuthState(db, authorizingInput);
    await stripeConnection.consumeOAuthState(db, authorizingInput);
    await expect(
      stripeConnection.getAccountDeletionBlock(db, authorizingUserId),
    ).resolves.toBe("authorized_connection");
    await expect(deleteUser(db, authorizingUserId)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("atomically preserves the user and API keys when Stripe blocks deletion", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("delete-race@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_delete_race"),
    });
    const now = new Date();
    const apiKeyId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO apikeys (id, key, reference_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(apiKeyId, "hashed-test-key", userId, now.getTime(), now.getTime())
      .run();

    await expect(deleteUser(db, userId)).rejects.toBeInstanceOf(ConflictError);
    await expect(
      db.select({ id: users.id }).from(users).where(eq(users.id, userId)),
    ).resolves.toEqual([{ id: userId }]);
    await expect(
      db
        .select({ id: apikeys.id })
        .from(apikeys)
        .where(eq(apikeys.id, apiKeyId)),
    ).resolves.toEqual([{ id: apiKeyId }]);

    const pending = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
    );
    const operation = await claimDisconnect(db, connection, pending);
    await stripeConnection.finalizeDisconnectedAccount(db, operation);
    await expect(deleteUser(db, userId)).resolves.toEqual({ fileKeys: [] });
  });

  it("finalizes only the matching disconnect operation and retains history", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("finalize@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_finalize"),
    });
    const reserved = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
    );
    const operation = await claimDisconnect(db, connection, reserved);

    await expect(
      stripeConnection.finalizeDisconnectedAccount(db, {
        ...operation,
        disconnectOperationId: "wrong-operation",
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnection.finalizeDisconnectedAccount(db, operation),
    ).resolves.toBe(true);

    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      disconnected_at: expect.any(String),
      disconnect_operation_id: null,
      disconnect_started_at: null,
    });
    await expect(
      stripeConnection.getCurrentUiConnection(db, userId),
    ).resolves.toBeNull();
  });

  it("restores only the exact disconnect operation and authorization revision", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("restore@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_restore"),
    });
    const reserved = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
    );
    const operation = await claimDisconnect(db, connection, reserved);

    await expect(
      stripeConnection.restoreDisconnectedAccount(db, {
        ...operation,
        disconnectOperationId: "wrong-operation",
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnection.restoreDisconnectedAccount(db, {
        ...operation,
        expectedAuthorizationRevision: "wrong-revision",
      }),
    ).resolves.toBe(false);
    await expect(
      stripeConnection.restoreDisconnectedAccount(db, operation),
    ).resolves.toBe(true);

    await expect(stripeConnection.getActiveConnection(db, userId)).resolves.toMatchObject({
      id: connection.id,
      disconnected_at: null,
      disconnect_operation_id: null,
      disconnect_started_at: null,
    });
  });

  it("blocks reauthorizing the same account while disconnect is pending", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("pending-reauthorize@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_pending_reauthorize"),
    });
    const reserved = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
    );

    await expect(
      stripeConnection.connectAccount(db, {
        userId,
        ...readyStatus("acct_pending_reauthorize"),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      disconnect_operation_id: reserved.disconnect_operation_id,
      authorization_revision: connection.authorization_revision,
    });
  });

  it("blocks disconnect while a consumed callback still holds the connect lock", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("reserve-reauthorize-race@test.com");
    const input = {
      state: rawState("callback-lock"),
      userId,
      livemode: false,
    };
    await stripeConnection.createOAuthState(db, input);
    const state = await stripeConnection.consumeOAuthState(db, input);
    const connection = await stripeConnectionService.connectAccount(db, {
      userId,
      operationId: state.operation_id!,
      ...readyStatus("acct_callback_lock"),
    });

    await expect(
      stripeConnection.disconnectAccount(db, connection.id, userId),
    ).rejects.toMatchObject({ reason: "operation_in_progress" });
    await expect(stripeConnection.getConnectionById(db, connection.id)).resolves.toMatchObject({
      disconnected_at: null,
      disconnect_operation_id: null,
    });

    await stripeConnection.completeOAuthState(db, {
      stateHash: state.state_hash,
      userId,
      operationId: state.operation_id!,
    });
    await expect(
      stripeConnection.disconnectAccount(db, connection.id, userId),
    ).resolves.toMatchObject({ disconnect_operation_id: expect.any(String) });
  });

  it("resumes the exact pending disconnect operation", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("restore-active@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_restore_old"),
    });
    const reserved = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
    );
    const resumed = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
    );

    expect(resumed).toMatchObject({
      id: connection.id,
      disconnect_operation_id: reserved.disconnect_operation_id,
      disconnect_started_at: reserved.disconnect_started_at,
    });
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toMatchObject({
      id: reserved.disconnect_operation_id,
      kind: "disconnect",
      connection_id: connection.id,
      expires_at: null,
    });
  });

  it("concurrent disconnect requests converge on one resumable operation", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("disconnect-race@test.com");
    const connection = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_disconnect_race"),
    });

    const reservations = await Promise.allSettled([
      stripeConnection.disconnectAccount(db, connection.id, userId),
      stripeConnection.disconnectAccount(db, connection.id, userId),
    ]);

    expect(reservations.every((result) => result.status === "fulfilled")).toBe(true);
    const reserved = (reservations[0] as PromiseFulfilledResult<StripeConnection>).value;
    const resumed = (reservations[1] as PromiseFulfilledResult<StripeConnection>).value;
    expect(resumed.disconnect_operation_id).toBe(reserved.disconnect_operation_id);

    const operation = await claimDisconnect(db, connection, reserved);
    const restorations = await Promise.all([
      stripeConnection.restoreDisconnectedAccount(db, operation),
      stripeConnection.restoreDisconnectedAccount(db, operation),
    ]);

    expect(restorations.sort()).toEqual([false, true]);
  });

  it("shows a pending disconnect until exact finalization, then omits history", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("ui-precedence@test.com");
    const first = await stripeConnection.connectAccount(db, {
      userId,
      ...readyStatus("acct_ui_first"),
    });
    const pending = await stripeConnection.disconnectAccount(
      db,
      first.id,
      userId,
      new Date("2026-01-01T00:01:00.000Z"),
    );
    const operation = await claimDisconnect(
      db,
      first,
      pending,
      new Date("2026-01-01T00:01:01.000Z"),
    );

    await expect(
      stripeConnection.getCurrentUiConnection(db, userId),
    ).resolves.toMatchObject({ id: first.id, disconnect_operation_id: pending.disconnect_operation_id });

    await stripeConnection.finalizeDisconnectedAccount(
      db,
      operation,
      new Date("2026-01-01T00:01:02.000Z"),
    );
    await expect(
      stripeConnection.getCurrentUiConnection(db, userId),
    ).resolves.toBeNull();
  });

  it("marks external deauthorization idempotently without deleting history", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("deauth@test.com");
    const connection = await stripeConnection.connectAccount(
      db,
      { userId, ...readyStatus("acct_deauth") },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const firstTime = new Date("2026-01-01T01:00:00.000Z");

    const first = await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: "acct_deauth",
        livemode: false,
        expectedAuthorizationRevision: connection.authorization_revision,
      },
      firstTime,
    );
    const second = await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: "acct_deauth",
        livemode: false,
        expectedAuthorizationRevision: connection.authorization_revision,
      },
      new Date("2026-01-01T02:00:00.000Z"),
    );

    expect(first).toEqual({ outcome: "applied" });
    expect(second).toEqual({ outcome: "ignored", reason: "inactive" });
    await expect(
      stripeConnection.getConnectionByAccountId(db, "acct_deauth"),
    ).resolves.toMatchObject({
      id: connection.id,
      disconnected_at: firstTime.toISOString(),
      stripe_status_at: firstTime.toISOString(),
    });
  });

  it("finalizes the exact pending disconnect from a deauthorization webhook", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("pending-deauth@test.com");
    const connection = await stripeConnection.connectAccount(
      db,
      { userId, ...readyStatus("acct_pending_deauth") },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const pending = await stripeConnection.disconnectAccount(
      db,
      connection.id,
      userId,
      new Date("2026-01-01T00:01:00.000Z"),
    );

    await expect(
      stripeConnection.markExternalDeauthorization(
        db,
        {
          stripeAccountId: connection.stripe_account_id,
          livemode: false,
          expectedAuthorizationRevision: connection.authorization_revision,
        },
        new Date("2026-01-01T00:02:00.000Z"),
      ),
    ).resolves.toEqual({ outcome: "applied" });
    await expect(
      stripeConnection.getConnectionById(db, connection.id),
    ).resolves.toMatchObject({
      disconnected_at: pending.disconnected_at,
      disconnect_operation_id: null,
      disconnect_started_at: null,
    });
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toBeNull();
  });

  it("ignores a stale deauthorization event during a newer pending disconnect", async () => {
    const db = createDb(env.DB);
    const userId = await createTestUser("stale-pending-deauth@test.com");
    const first = await stripeConnection.connectAccount(
      db,
      { userId, ...readyStatus("acct_stale_pending") },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await stripeConnection.markExternalDeauthorization(
      db,
      {
        stripeAccountId: first.stripe_account_id,
        livemode: false,
        expectedAuthorizationRevision: first.authorization_revision,
      },
      new Date("2026-01-01T00:01:00.000Z"),
    );
    const reconnected = await stripeConnection.connectAccount(
      db,
      { userId, ...readyStatus("acct_stale_pending") },
      new Date("2026-01-01T00:02:00.000Z"),
    );
    const pending = await stripeConnection.disconnectAccount(
      db,
      reconnected.id,
      userId,
      new Date("2026-01-01T00:03:00.000Z"),
    );

    await expect(
      stripeConnection.markExternalDeauthorization(
        db,
        {
          stripeAccountId: reconnected.stripe_account_id,
          livemode: false,
          expectedAuthorizationRevision: reconnected.authorization_revision,
        },
        new Date("2026-01-01T00:01:00.000Z"),
      ),
    ).resolves.toEqual({ outcome: "ignored", reason: "inactive" });
    await expect(
      stripeConnection.getConnectionById(db, reconnected.id),
    ).resolves.toMatchObject({
      disconnect_operation_id: pending.disconnect_operation_id,
    });
    await expect(stripeConnection.getCurrentOperation(db, userId)).resolves.toMatchObject({
      id: pending.disconnect_operation_id,
    });
  });
});
