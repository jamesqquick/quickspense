import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeOAuthState: vi.fn(),
  completeRejectedOAuthState: vi.fn(),
  consumeOAuthState: vi.fn(),
  createDb: vi.fn(() => ({ kind: "db" })),
  createStripeClient: vi.fn(),
  createStripeOAuthClient: vi.fn(),
  deauthorize: vi.fn(),
  getCurrentOperation: vi.fn(),
  persistAuthorizedConnection: vi.fn(),
  recordAuthorizedAccount: vi.fn(),
  retrieveAccount: vi.fn(),
  token: vi.fn(),
}));

vi.mock("@quickspense/domain", () => ({
  ConflictError: class ConflictError extends Error {},
  createDb: mocks.createDb,
  stripeConnections: {
    completeOAuthState: mocks.completeOAuthState,
    completeRejectedOAuthState: mocks.completeRejectedOAuthState,
    consumeOAuthState: mocks.consumeOAuthState,
    getCurrentOperation: mocks.getCurrentOperation,
    persistAuthorizedConnection: mocks.persistAuthorizedConnection,
    recordAuthorizedAccount: mocks.recordAuthorizedAccount,
  },
}));

vi.mock("@/lib/stripe", async (original) => ({
  ...await original<typeof import("@/lib/stripe")>(),
  createStripeClient: mocks.createStripeClient,
  createStripeOAuthClient: mocks.createStripeOAuthClient,
}));

import { GET } from "@/pages/api/integrations/stripe/callback";

function callbackContext() {
  return {
    locals: {
      logger: { error: vi.fn() },
      runtime: {
        env: {
          APP_URL: "https://quickspense.test",
          DB: { kind: "binding" },
          ENVIRONMENT: "development",
          STRIPE_CONNECT_CLIENT_ID: "ca_callback",
          STRIPE_SECRET_KEY: "sk_test_callback",
        },
      },
      user: { id: "user_callback" },
    },
    request: new Request(
      "https://quickspense.test/api/integrations/stripe/callback?state=state_callback&code=code_callback&scope=read_write",
    ),
  };
}

async function useOAuthResponse(body: object, status = 400) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Request-Id": "req_callback" },
  }));
  vi.stubGlobal("fetch", fetch);
  const { createStripeOAuthClient } = await vi.importActual<typeof import("@/lib/stripe")>("@/lib/stripe");
  mocks.createStripeOAuthClient.mockReturnValue(createStripeOAuthClient(callbackContext().locals.runtime.env));
  return fetch;
}

describe("Stripe OAuth callback", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.completeRejectedOAuthState.mockResolvedValue(true);
    mocks.createStripeClient.mockReturnValue({
      accounts: { retrieve: mocks.retrieveAccount },
    });
    mocks.createStripeOAuthClient.mockReturnValue({
      oauth: {
        deauthorize: mocks.deauthorize,
        token: mocks.token,
      },
    });
    mocks.consumeOAuthState.mockResolvedValue({
      operation_id: "operation_callback",
      state_hash: "state_hash_callback",
    });
    mocks.getCurrentOperation.mockResolvedValue({
      id: "operation_callback",
      kind: "connect",
      phase: "authorizing",
      stripe_account_id: null,
    });
    mocks.token.mockResolvedValue({
      livemode: false,
      scope: "read_write",
      stripe_user_id: "acct_callback",
    });
    mocks.recordAuthorizedAccount.mockRejectedValue(
      new Error("D1 write unavailable"),
    );
  });

  it("keeps an authorization unresolved when both account-ID writes fail", async () => {
    let operationResolved = false;
    mocks.completeOAuthState.mockImplementation(async () => {
      operationResolved = true;
    });
    const logger = { error: vi.fn() };
    const request = new Request(
      "https://quickspense.test/api/integrations/stripe/callback?state=state_callback&code=code_callback&scope=read_write",
    );

    const response = await GET({
      locals: {
        logger,
        runtime: {
          env: {
            APP_URL: "https://quickspense.test",
            DB: { kind: "binding" },
            ENVIRONMENT: "development",
            STRIPE_CONNECT_CLIENT_ID: "ca_callback",
            STRIPE_SECRET_KEY: "sk_test_callback",
          },
        },
        user: { id: "user_callback" },
      },
      request,
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://quickspense.test/settings?stripe=authorization_unconfirmed",
    );
    expect(mocks.token).toHaveBeenCalledOnce();
    expect(mocks.recordAuthorizedAccount).toHaveBeenCalledTimes(2);
    expect(mocks.recordAuthorizedAccount).toHaveBeenNthCalledWith(
      1,
      { kind: "db" },
      {
        operationId: "operation_callback",
        stripeAccountId: "acct_callback",
        userId: "user_callback",
      },
    );
    expect(mocks.completeOAuthState).not.toHaveBeenCalled();
    expect(mocks.persistAuthorizedConnection).not.toHaveBeenCalled();
    expect(mocks.deauthorize).not.toHaveBeenCalled();
    expect(operationResolved).toBe(false);
  });

  it.each([
    ["invalid_client", "configuration"],
    ["invalid_grant", "oauth_invalid"],
    ["invalid_scope", "oauth_invalid"],
    ["invalid_request", "oauth_invalid"],
  ])("releases a confirmed %s rejection so the user can start again", async (error, result) => {
    const fetch = await useOAuthResponse({ error, error_description: "OAuth request rejected." });
    const context = callbackContext();
    const response = await GET(context as never);

    expect(response.headers.get("location")).toBe(`https://quickspense.test/settings?stripe=${result}`);
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.completeRejectedOAuthState).toHaveBeenCalledWith({ kind: "db" }, {
      stateHash: "state_hash_callback", userId: "user_callback", operationId: "operation_callback",
    });
    expect(mocks.recordAuthorizedAccount).not.toHaveBeenCalled();
    expect(mocks.completeOAuthState).not.toHaveBeenCalled();
    expect(context.locals.logger.error).toHaveBeenCalledWith("Stripe OAuth token exchange failed", expect.objectContaining({
      outcome: "rejected", stripeErrorCode: error, stripeStatusCode: 400, stripeRequestId: "req_callback",
    }));
  });

  it("redacts credentials, authorization codes and state from diagnostic messages", async () => {
    await useOAuthResponse({ error: "invalid_client",
      error_description: "Invalid sk_test_callback and rk_live_masked*** for code_callback, state_callback and ac_other_code.",
    });
    const context = callbackContext();
    await GET(context as never);

    const logs = JSON.stringify(context.locals.logger.error.mock.calls);
    for (const secret of ["sk_test_callback", "rk_live_masked", "code_callback", "state_callback", "ac_other_code"]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).toContain("[redacted]");
    expect(logs).toContain("invalid_client");
  });

  it.each([
    ["authentication_error", 401],
    ["permission_error", 403],
  ])("releases a confirmed %s response", async (type, status) => {
    await useOAuthResponse({ error: { type, message: "Credentials rejected." } }, status);
    const response = await GET(callbackContext() as never);
    expect(response.headers.get("location")).toBe("https://quickspense.test/settings?stripe=configuration");
    expect(mocks.completeRejectedOAuthState).toHaveBeenCalledOnce();
  });

  it.each([
    [{ error: "server_error" }, 503],
    [{ error: "invalid_client" }, 500],
    [{ error: { type: "api_error", message: "Service unavailable" } }, 500],
  ])("preserves an uncertain server error %j", async (body, status) => {
    const fetch = await useOAuthResponse(body, status);
    await GET(callbackContext() as never);
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.completeRejectedOAuthState).not.toHaveBeenCalled();
    expect(mocks.completeOAuthState).not.toHaveBeenCalled();
  });

  it("preserves a lost response without resubmitting the authorization code", async () => {
    const fetch = vi.fn().mockRejectedValue(Object.assign(new TypeError("Connection lost"), { code: "ECONNRESET" }));
    vi.stubGlobal("fetch", fetch);
    const { createStripeOAuthClient } = await vi.importActual<typeof import("@/lib/stripe")>("@/lib/stripe");
    mocks.createStripeOAuthClient.mockReturnValue(createStripeOAuthClient(callbackContext().locals.runtime.env));
    const context = callbackContext();
    await GET(context as never);

    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.completeRejectedOAuthState).not.toHaveBeenCalled();
    expect(mocks.completeOAuthState).not.toHaveBeenCalled();
    expect(context.locals.logger.error).toHaveBeenCalledWith("Stripe OAuth token exchange failed", expect.objectContaining({
      outcome: "unknown",
    }));
  });

  it.each([false, new Error("D1 write unavailable")])("does not claim recovery if rejection cleanup fails: %s", async (failure) => {
    await useOAuthResponse({ error: "invalid_client" });
    if (failure instanceof Error) mocks.completeRejectedOAuthState.mockRejectedValue(failure);
    else mocks.completeRejectedOAuthState.mockResolvedValue(failure);

    const response = await GET(callbackContext() as never);
    expect(response.headers.get("location")).toBe("https://quickspense.test/settings?stripe=authorization_unconfirmed");
    expect(mocks.recordAuthorizedAccount).not.toHaveBeenCalled();
  });

  it("does not clear an authorization after a successful but invalid token response", async () => {
    mocks.token.mockResolvedValue({ scope: "read_only", livemode: false, stripe_user_id: "acct_callback" });
    const response = await GET(callbackContext() as never);
    expect(response.headers.get("location")).toBe("https://quickspense.test/settings?stripe=oauth_invalid");
    expect(mocks.completeRejectedOAuthState).not.toHaveBeenCalled();
  });
});
