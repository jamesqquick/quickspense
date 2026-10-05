import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripeConnectionOperationConflictError } from "@quickspense/domain";
import { connectionFixture } from "./helpers/invoicePayment";

const mocks = vi.hoisted(() => ({
  completeAuthorizedConnectionConflict: vi.fn(),
  completeDeauthorizedConnectOperation: vi.fn(),
  completeUnconfirmedConnectOperation: vi.fn(),
  createDb: vi.fn(() => ({ kind: "db" })),
  createStripeClient: vi.fn(),
  createStripeOAuthClient: vi.fn(),
  currentOperation: null as null | {
    livemode: boolean;
    operationId: string;
    phase: "authorizing" | "authorized";
    stripeAccountId: string | null;
  },
  deauthorize: vi.fn(),
  getActiveConnection: vi.fn(),
  getConnectionByAccountId: vi.fn(),
  getConnectionById: vi.fn(),
  updateAccountStatus: vi.fn(),
  getCurrentAuthorizedOperation: vi.fn(),
  persistAuthorizedConnection: vi.fn(),
  disconnectAccount: vi.fn(), claimDisconnectAttempt: vi.fn(), restoreDisconnectedAccount: vi.fn(),
  finalizeDisconnectedAccount: vi.fn(), releaseDisconnectAttempt: vi.fn(), retrieve: vi.fn(),
}));

vi.mock("astro:actions", () => {
  class TestActionError extends Error {
    readonly code: string;

    constructor(input: { code: string; message: string }) {
      super(input.message);
      this.name = "ActionError";
      this.code = input.code;
    }
  }

  return {
    ActionError: TestActionError,
    defineAction: (definition: {
      input: { safeParse: (input: unknown) => { success: boolean; data?: unknown } };
      handler: (input: unknown, context: unknown) => Promise<unknown>;
    }) => ({
      ...definition,
      handler: async (input: unknown, context: unknown) => {
        const parsed = definition.input.safeParse(input);
        if (!parsed.success) {
          throw new TestActionError({
            code: "BAD_REQUEST",
            message: "Invalid action input.",
          });
        }
        return definition.handler(parsed.data, context);
      },
    }),
    isActionError: (error: unknown) => error instanceof TestActionError,
  };
});

vi.mock("astro:schema", async () => {
  const { z } = await import("astro/zod");
  return { z };
});

vi.mock("@quickspense/domain", async (original) => {
  class ConflictError extends Error {}
  class StripeConnectionOperationConflictError extends ConflictError {
    readonly reason: string;

    constructor(reason: string) {
      super(reason);
      this.reason = reason;
    }
  }

  return {
    ...await original<typeof import("@quickspense/domain")>(),
    ConflictError,
    StripeConnectionOperationConflictError,
    createDb: mocks.createDb,
    stripeConnections: {
      completeAuthorizedConnectionConflict:
        mocks.completeAuthorizedConnectionConflict,
      completeDeauthorizedConnectOperation:
        mocks.completeDeauthorizedConnectOperation,
      completeUnconfirmedConnectOperation:
        mocks.completeUnconfirmedConnectOperation,
      getActiveConnection: mocks.getActiveConnection,
      getConnectionByAccountId: mocks.getConnectionByAccountId,
      getConnectionById: mocks.getConnectionById,
      updateAccountStatus: mocks.updateAccountStatus,
      getCurrentAuthorizedOperation: mocks.getCurrentAuthorizedOperation,
      persistAuthorizedConnection: mocks.persistAuthorizedConnection,
      disconnectAccount: mocks.disconnectAccount, claimDisconnectAttempt: mocks.claimDisconnectAttempt,
      restoreDisconnectedAccount: mocks.restoreDisconnectedAccount, finalizeDisconnectedAccount: mocks.finalizeDisconnectedAccount,
      releaseDisconnectAttempt: mocks.releaseDisconnectAttempt,
    },
  };
});

vi.mock("@/lib/stripe", () => ({
  createStripeClient: mocks.createStripeClient,
  createStripeOAuthClient: mocks.createStripeOAuthClient,
}));

import { server } from "@/actions/index";

type TestAction = {
  handler(input: unknown, context: unknown): Promise<unknown>;
};

const resolveUnconfirmedAuthorization = server.stripe
  .resolveUnconfirmedAuthorization as unknown as TestAction;
const recoverConnection = server.stripe.recoverConnection as unknown as TestAction;
const disconnect = server.stripe.disconnect as unknown as TestAction;
const refreshStatus = server.stripe.refreshStatus as unknown as TestAction;
const refreshConnectionId = "c74a7a38-50fd-4cfa-82a7-0a87819d0511";

function createContext(userId = "user_current") {
  return {
    locals: {
      logger: { error: vi.fn() },
      runtime: {
        env: {
          DB: { kind: "binding" },
          ENVIRONMENT: "development",
          STRIPE_CONNECT_CLIENT_ID: "ca_actions",
          STRIPE_SECRET_KEY: "sk_test_actions",
        },
      },
      user: { id: userId },
    },
  };
}

async function useOAuthHttpResponse(body: object, status = 400) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  const { createStripeOAuthClient } = await vi.importActual<typeof import("@/lib/stripe")>("@/lib/stripe");
  mocks.createStripeOAuthClient.mockReturnValue(createStripeOAuthClient(createContext().locals.runtime.env));
  return fetch;
}

describe("Stripe recovery Actions", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentOperation = null;
    mocks.getCurrentAuthorizedOperation.mockImplementation(
      async () => mocks.currentOperation,
    );
    mocks.completeUnconfirmedConnectOperation.mockImplementation(
      async (_db, input: { operationId: string; userId: string }) => {
        if (
          mocks.currentOperation?.operationId !== input.operationId ||
          input.userId !== "user_current"
        ) {
          return false;
        }
        mocks.currentOperation = null;
        return true;
      },
    );
    mocks.completeDeauthorizedConnectOperation.mockImplementation(async () => {
      mocks.currentOperation = null;
      return true;
    });
    mocks.getConnectionByAccountId.mockResolvedValue(null);
    mocks.createStripeOAuthClient.mockReturnValue({
      oauth: { deauthorize: mocks.deauthorize },
    });
    mocks.createStripeClient.mockReturnValue({ accounts: { retrieve: mocks.retrieve } });
  });

  it("refreshes an authenticated user's sandbox account even with disabled flags", async () => {
    const connection = connectionFixture({ id: refreshConnectionId, user_id: "user_current", charges_enabled: false });
    mocks.getConnectionById.mockResolvedValue(connection);
    mocks.updateAccountStatus.mockResolvedValue({ outcome: "applied" });
    const requirements = { disabled_reason: "requirements.past_due", currently_due: ["individual.verification.document"],
      past_due: ["individual.verification.document"], pending_verification: [],
      errors: [{ code: "verification_failed_keyed_identity", requirement: "individual.verification.document" }] };
    mocks.retrieve.mockResolvedValue({ id: connection.stripe_account_id, object: "account", charges_enabled: false,
      payouts_enabled: false, details_submitted: true, requirements });

    expect(await refreshStatus.handler({ connectionId: refreshConnectionId }, createContext())).toEqual({ refreshed: true });
    expect(mocks.retrieve).toHaveBeenCalledWith(connection.stripe_account_id);
    expect(mocks.updateAccountStatus).toHaveBeenCalledWith({ kind: "db" }, expect.objectContaining({
      stripe_account_id: connection.stripe_account_id, livemode: false, requirements,
      expectedAuthorizationRevision: connection.authorization_revision, observedAt: expect.any(Date),
    }));
    expect(mocks.getConnectionById).toHaveBeenCalledTimes(2);
    expect(mocks.deauthorize).not.toHaveBeenCalled();
  });

  it("requires authentication before refreshing Stripe status", async () => {
    const context = createContext();
    await expect(refreshStatus.handler({ connectionId: refreshConnectionId }, {
      ...context, locals: { ...context.locals, user: null },
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.createDb).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("rejects client-supplied account and environment fields", async () => {
    await expect(refreshStatus.handler({ connectionId: refreshConnectionId, stripeAccountId: "acct_foreign", livemode: true },
      createContext())).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    { user_id: "other_user" }, { disconnected_at: "2026-01-01" }, { disconnect_operation_id: "pending" },
    { disconnect_started_at: "2026-01-01" }, { livemode: true },
  ])("refuses to refresh a foreign, inactive, pending or mismatched connection: %j", async (overrides) => {
    mocks.getConnectionById.mockResolvedValue(connectionFixture({ user_id: "user_current", ...overrides }));
    await expect(refreshStatus.handler({ connectionId: refreshConnectionId }, createContext())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.updateAccountStatus).not.toHaveBeenCalled();
  });

  it.each(["stale", "authorization_revision_mismatch"])("does not confirm a %s refresh", async (reason) => {
    const connection = connectionFixture({ user_id: "user_current" });
    mocks.getConnectionById.mockResolvedValue(connection);
    mocks.retrieve.mockResolvedValue({ object: "account", id: connection.stripe_account_id,
      charges_enabled: true, payouts_enabled: true, details_submitted: true });
    mocks.updateAccountStatus.mockResolvedValue({ outcome: "ignored", reason });
    await expect(refreshStatus.handler({ connectionId: refreshConnectionId }, createContext())).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each([{ authorization_revision: "new_revision" }, { disconnected_at: "2026-01-01" }, { disconnect_started_at: "2026-01-01" }])
    ("rechecks the connection after applying a refresh: %j", async (overrides) => {
      const connection = connectionFixture({ user_id: "user_current" });
      mocks.getConnectionById.mockResolvedValueOnce(connection).mockResolvedValueOnce({ ...connection, ...overrides });
      mocks.retrieve.mockResolvedValue({ object: "account", id: connection.stripe_account_id,
        charges_enabled: true, payouts_enabled: true, details_submitted: true });
      mocks.updateAccountStatus.mockResolvedValue({ outcome: "applied" });
      await expect(refreshStatus.handler({ connectionId: refreshConnectionId }, createContext())).rejects.toMatchObject({ code: "CONFLICT" });
    });

  it("does not persist failed Stripe lookups or expose their raw error messages", async () => {
    mocks.getConnectionById.mockResolvedValue(connectionFixture({ user_id: "user_current" }));
    mocks.retrieve.mockRejectedValue({ type: "StripePermissionError", message: "private API details" });
    const context = createContext();
    await expect(refreshStatus.handler({ connectionId: refreshConnectionId }, context)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE", message: "Stripe status could not be refreshed. Please try again.",
    });
    expect(mocks.updateAccountStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(context.locals.logger.error.mock.calls)).not.toContain("private API details");
    expect(mocks.deauthorize).not.toHaveBeenCalled();
  });

  it("requires explicit revocation confirmation", async () => {
    mocks.currentOperation = {
      livemode: false,
      operationId: "operation_unconfirmed",
      phase: "authorizing",
      stripeAccountId: null,
    };

    await expect(
      resolveUnconfirmedAuthorization.handler(
        { confirmedRevoked: false },
        createContext(),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.completeUnconfirmedConnectOperation).not.toHaveBeenCalled();
    expect(mocks.currentOperation?.operationId).toBe("operation_unconfirmed");
  });

  it("rejects a user's revocation assertion and preserves the unknown authorization", async () => {
    mocks.currentOperation = {
      livemode: false,
      operationId: "operation_unconfirmed",
      phase: "authorizing",
      stripeAccountId: null,
    };

    await expect(
      resolveUnconfirmedAuthorization.handler(
        { confirmedRevoked: true },
        createContext(),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.completeUnconfirmedConnectOperation).not.toHaveBeenCalled();
    expect(mocks.currentOperation?.operationId).toBe("operation_unconfirmed");
  });

  it.each([
    ["confirmed success", null],
    [
      "already disconnected",
      {
        raw: {
          type: "invalid_client",
          message:
            "The Stripe account is not connected to your application.",
        },
        type: "StripeInvalidClientError",
      },
    ],
  ])(
    "deauthorizes only the extra account after %s",
    async (_label, deauthorizationError) => {
      const activeConnection = {
        id: "connection_active",
        stripe_account_id: "acct_active",
      };
      mocks.currentOperation = {
        livemode: false,
        operationId: "operation_extra",
        phase: "authorized",
        stripeAccountId: "acct_extra",
      };
      mocks.getActiveConnection.mockResolvedValue(activeConnection);
      if (deauthorizationError) {
        mocks.deauthorize.mockRejectedValue(deauthorizationError);
      } else {
        mocks.deauthorize.mockResolvedValue({ stripe_user_id: "acct_extra" });
      }

      await expect(
        recoverConnection.handler({}, createContext()),
      ).resolves.toEqual({ recovered: true });

      expect(mocks.deauthorize).toHaveBeenCalledOnce();
      expect(mocks.deauthorize).toHaveBeenCalledWith({
        client_id: "ca_actions",
        stripe_user_id: "acct_extra",
      });
      expect(mocks.completeDeauthorizedConnectOperation).toHaveBeenCalledWith(
        { kind: "db" },
        {
          operationId: "operation_extra",
          stripeAccountId: "acct_extra",
          userId: "user_current",
        },
      );
      expect(mocks.persistAuthorizedConnection).not.toHaveBeenCalled();
      expect(activeConnection).toEqual({
        id: "connection_active",
        stripe_account_id: "acct_active",
      });
      expect(mocks.currentOperation).toBeNull();
    },
  );

  it("keeps an ambiguous extra-account cleanup retryable", async () => {
    mocks.currentOperation = {
      livemode: false,
      operationId: "operation_extra",
      phase: "authorized",
      stripeAccountId: "acct_extra",
    };
    mocks.getActiveConnection.mockResolvedValue({
      id: "connection_active",
      stripe_account_id: "acct_active",
    });
    mocks.deauthorize.mockRejectedValue({ type: "StripeConnectionError" });

    await expect(
      recoverConnection.handler({}, createContext()),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message:
        "Stripe is still confirming authorization cleanup. Retry resolution in Settings.",
    });

    expect(mocks.deauthorize).toHaveBeenCalledWith({
      client_id: "ca_actions",
      stripe_user_id: "acct_extra",
    });
    expect(mocks.completeDeauthorizedConnectOperation).not.toHaveBeenCalled();
    expect(mocks.currentOperation).toMatchObject({
      operationId: "operation_extra",
      stripeAccountId: "acct_extra",
    });
  });
  it.each([{ type: "StripePermissionError", statusCode: 403 }, { type: "StripeAuthenticationError", statusCode: 401 }, { type: "StripeConnectionError" }])(
    "keeps a disconnect pending when rejected deauthorization cannot verify current authorization %j", async (error) => {
      const connection = connectionFixture({ id: "11111111-1111-4111-8111-111111111111", user_id: "user_current",
        disconnected_at: "2026-10-02", disconnect_operation_id: "disconnect_1" });
      mocks.disconnectAccount.mockResolvedValue(connection);
      mocks.claimDisconnectAttempt.mockResolvedValue({ connection, attemptId: "attempt_1" });
      mocks.deauthorize.mockRejectedValue({ type: "StripeInvalidClientError", raw: { type: "invalid_client" } });
      mocks.retrieve.mockRejectedValue(error);
      await expect(disconnect.handler({ connectionId: connection.id }, createContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(mocks.restoreDisconnectedAccount).not.toHaveBeenCalled();
      expect(mocks.finalizeDisconnectedAccount).not.toHaveBeenCalled();
      expect(mocks.releaseDisconnectAttempt).toHaveBeenCalledOnce();
    },
  );
  it("restores a rejected disconnect only with a fresh verified account observation", async () => {
    const connection = connectionFixture({ id: "11111111-1111-4111-8111-111111111111", user_id: "user_current",
      disconnected_at: "2026-10-02", disconnect_operation_id: "disconnect_1" });
    mocks.disconnectAccount.mockResolvedValue(connection);
    mocks.claimDisconnectAttempt.mockResolvedValue({ connection, attemptId: "attempt_1" });
    mocks.deauthorize.mockRejectedValue({ type: "StripePermissionError" });
    mocks.retrieve.mockResolvedValue({ object: "account", id: connection.stripe_account_id,
      charges_enabled: false, payouts_enabled: false, details_submitted: true });
    mocks.restoreDisconnectedAccount.mockResolvedValue(true);
    await expect(disconnect.handler({ connectionId: connection.id }, createContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(mocks.restoreDisconnectedAccount).toHaveBeenCalledWith({ kind: "db" }, expect.objectContaining({
      expectedAuthorizationRevision: connection.authorization_revision,
      observation: { observedAt: expect.any(Date), account: expect.objectContaining({ stripe_account_id: connection.stripe_account_id, charges_enabled: false }) },
    }));
    expect(mocks.releaseDisconnectAttempt).not.toHaveBeenCalled();
  });

  it("finalizes a pending disconnect retry after the SDK reports the account is already disconnected", async () => {
    const connection = connectionFixture({ id: "11111111-1111-4111-8111-111111111111", user_id: "user_current",
      disconnected_at: "2026-10-02", disconnect_operation_id: "disconnect_1" });
    mocks.disconnectAccount.mockResolvedValue(connection);
    mocks.claimDisconnectAttempt.mockResolvedValueOnce({ connection, attemptId: "attempt_1" })
      .mockResolvedValueOnce({ connection, attemptId: "attempt_2" });
    mocks.finalizeDisconnectedAccount.mockResolvedValue(true);
    const fetch = await useOAuthHttpResponse({ error: "invalid_client",
      error_description: "The Stripe account is not connected to your application." });
    fetch.mockRejectedValueOnce(new TypeError("Mock network failure"));

    await expect(disconnect.handler({ connectionId: connection.id }, createContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(mocks.finalizeDisconnectedAccount).not.toHaveBeenCalled();
    expect(mocks.restoreDisconnectedAccount).not.toHaveBeenCalled();
    expect(mocks.releaseDisconnectAttempt).toHaveBeenCalledOnce();
    await expect(disconnect.handler({ connectionId: connection.id }, createContext())).resolves.toEqual({ disconnected: true });
    expect(mocks.finalizeDisconnectedAccount).toHaveBeenCalledExactlyOnceWith({ kind: "db" }, {
      connectionId: connection.id, userId: "user_current", disconnectOperationId: "disconnect_1",
      expectedAuthorizationRevision: connection.authorization_revision, attemptId: "attempt_2",
    });
    expect(mocks.restoreDisconnectedAccount).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("completes extra-account recovery after an SDK already-disconnected response", async () => {
    const activeConnection = { id: "connection_active", stripe_account_id: "acct_active" };
    mocks.currentOperation = { livemode: false, operationId: "operation_extra", phase: "authorized", stripeAccountId: "acct_extra" };
    mocks.getActiveConnection.mockResolvedValue(activeConnection);
    const fetch = await useOAuthHttpResponse({ error: "invalid_client",
      error_description: "This account is not connected to your application." });

    await expect(recoverConnection.handler({}, createContext())).resolves.toEqual({ recovered: true });
    expect(mocks.completeDeauthorizedConnectOperation).toHaveBeenCalledExactlyOnceWith({ kind: "db" }, {
      operationId: "operation_extra", stripeAccountId: "acct_extra", userId: "user_current",
    });
    expect(mocks.currentOperation).toBeNull();
    expect(mocks.persistAuthorizedConnection).not.toHaveBeenCalled();
    expect(activeConnection).toEqual({ id: "connection_active", stripe_account_id: "acct_active" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://connect.stripe.com/oauth/deauthorize", expect.objectContaining({
      body: expect.stringContaining("stripe_user_id=acct_extra"),
    }));
  });

  it("ends a held client request before lease-expiry recovery can start another deauthorization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
    const connection = connectionFixture({ id: "11111111-1111-4111-8111-111111111111", user_id: "user_current",
      disconnected_at: new Date().toISOString(), disconnect_operation_id: "disconnect_1" });
    mocks.disconnectAccount.mockResolvedValue(connection);
    let lease: { attemptId: string; expiresAt: number } | null = null;
    let attemptCount = 0;
    mocks.claimDisconnectAttempt.mockImplementation(async () => {
      if (lease && lease.expiresAt > Date.now()) {
        throw new StripeConnectionOperationConflictError("operation_in_progress");
      }
      // Model the domain's 60-second lease, including a failed release after timeout.
      lease = { attemptId: `attempt_${++attemptCount}`, expiresAt: Date.now() + 60_000 };
      return { connection, attemptId: lease.attemptId };
    });
    mocks.releaseDisconnectAttempt.mockResolvedValue(false);
    mocks.finalizeDisconnectedAccount.mockResolvedValue(true);
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let firstSignal: AbortSignal | undefined;
    const fetch = await useOAuthHttpResponse({ stripe_user_id: connection.stripe_account_id }, 200);
    fetch.mockImplementation((_url, init: RequestInit) => {
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      if (fetch.mock.calls.length === 1) {
        firstSignal = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          firstSignal?.addEventListener("abort", () => {
            activeRequests--;
            reject(firstSignal?.reason);
          }, { once: true });
        });
      }
      activeRequests--;
      return Promise.resolve(new Response(JSON.stringify({ stripe_user_id: connection.stripe_account_id }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    });

    let firstError: unknown;
    let firstSettled = false;
    const first = disconnect.handler({ connectionId: connection.id }, createContext())
      .catch((error: unknown) => { firstError = error; })
      .finally(() => { firstSettled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(activeRequests).toBe(1);
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(firstSettled).toBe(false);
    await expect(disconnect.handler({ connectionId: connection.id }, createContext())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fetch).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(40_000);
    await expect(disconnect.handler({ connectionId: connection.id }, createContext())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.finalizeDisconnectedAccount).not.toHaveBeenCalled();
    expect(mocks.restoreDisconnectedAccount).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(disconnect.handler({ connectionId: connection.id }, createContext())).resolves.toEqual({ disconnected: true });
    expect(maxActiveRequests).toBe(1);
    expect(activeRequests).toBe(0);
    expect(firstSignal?.aborted).toBe(true);
    expect(firstSettled).toBe(true);
    await first;
    expect(firstError).toMatchObject({ code: "SERVICE_UNAVAILABLE",
      message: "Stripe is still confirming the disconnect. Use Retry disconnect in Settings." });
    expect(mocks.releaseDisconnectAttempt).toHaveBeenCalledExactlyOnceWith({ kind: "db" }, expect.objectContaining({ attemptId: "attempt_1" }));
    expect(mocks.finalizeDisconnectedAccount).toHaveBeenCalledExactlyOnceWith({ kind: "db" }, expect.objectContaining({ attemptId: "attempt_2" }));
    expect(mocks.restoreDisconnectedAccount).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(maxActiveRequests).toBe(1);
  });

  it("preserves an extra-account authorization operation when the SDK deauthorization times out", async () => {
    vi.useFakeTimers();
    mocks.currentOperation = { livemode: false, operationId: "operation_extra", phase: "authorized", stripeAccountId: "acct_extra" };
    mocks.getActiveConnection.mockResolvedValue({ id: "connection_active", stripe_account_id: "acct_active" });
    const fetch = await useOAuthHttpResponse({});
    fetch.mockImplementation((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    let error: unknown;
    let settled = false;
    const pending = recoverConnection.handler({}, createContext())
      .catch((caught: unknown) => { error = caught; })
      .finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(true);
    await pending;
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(mocks.currentOperation).toEqual({ livemode: false, operationId: "operation_extra", phase: "authorized", stripeAccountId: "acct_extra" });
    expect(mocks.completeDeauthorizedConnectOperation).not.toHaveBeenCalled();
    expect(mocks.completeUnconfirmedConnectOperation).not.toHaveBeenCalled();
    expect(mocks.persistAuthorizedConnection).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "generic invalid_client", status: 400, body: { error: "invalid_client" } },
    { label: "wrong client", status: 400, body: { error: "invalid_client", error_description: "The client_id does not belong to you." } },
    { label: "wrong mode", status: 400, body: { error: "invalid_client", error_description: "The API key mode does not match the client_id mode." } },
    { label: "authentication", status: 401, body: { error: { type: "authentication_error", message: "The Stripe account is not connected to your application." } } },
    { label: "permission", status: 403, body: { error: { type: "permission_error", message: "The Stripe account is not connected to your application." } } },
    { label: "network", status: 400, body: { error: "invalid_client" } },
  ])("keeps disconnect and extra-account recovery blocked after SDK $label failure", async ({ label, status, body }) => {
    const connection = connectionFixture({ id: "11111111-1111-4111-8111-111111111111", user_id: "user_current",
      disconnected_at: "2026-10-02", disconnect_operation_id: "disconnect_1" });
    mocks.disconnectAccount.mockResolvedValue(connection);
    mocks.claimDisconnectAttempt.mockResolvedValue({ connection, attemptId: "attempt_1" });
    mocks.retrieve.mockRejectedValue({ type: "StripePermissionError" });
    const fetch = await useOAuthHttpResponse(body, status);
    if (label === "network") fetch.mockRejectedValue(new TypeError("Mock network failure"));
    await expect(disconnect.handler({ connectionId: connection.id }, createContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(mocks.finalizeDisconnectedAccount).not.toHaveBeenCalled();
    expect(mocks.restoreDisconnectedAccount).not.toHaveBeenCalled();
    expect(mocks.releaseDisconnectAttempt).toHaveBeenCalledOnce();

    mocks.currentOperation = { livemode: false, operationId: "operation_extra", phase: "authorized", stripeAccountId: "acct_extra" };
    mocks.getActiveConnection.mockResolvedValue({ id: "connection_active", stripe_account_id: "acct_active" });
    await expect(recoverConnection.handler({}, createContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(mocks.completeDeauthorizedConnectOperation).not.toHaveBeenCalled();
    expect(mocks.currentOperation).toEqual({ livemode: false, operationId: "operation_extra", phase: "authorized", stripeAccountId: "acct_extra" });
    expect(mocks.persistAuthorizedConnection).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
