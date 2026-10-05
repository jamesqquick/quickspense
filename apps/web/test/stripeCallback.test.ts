import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeOAuthState: vi.fn(),
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
    consumeOAuthState: mocks.consumeOAuthState,
    getCurrentOperation: mocks.getCurrentOperation,
    persistAuthorizedConnection: mocks.persistAuthorizedConnection,
    recordAuthorizedAccount: mocks.recordAuthorizedAccount,
  },
}));

vi.mock("@/lib/stripe", () => ({
  createStripeClient: mocks.createStripeClient,
  createStripeOAuthClient: mocks.createStripeOAuthClient,
}));

import { GET } from "@/pages/api/integrations/stripe/callback";

describe("Stripe OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
