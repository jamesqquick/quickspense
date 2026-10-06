import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import {
  STRIPE_OAUTH_MAX_NETWORK_RETRIES,
  STRIPE_OAUTH_TIMEOUT_MS,
  createStripeClient,
  createStripeOAuthClient,
  getGuardedStripeLivemode,
} from "@/lib/stripe";
import {
  StripeConnectAccountError,
  StripeConnectConfigurationError,
  StripeConnectModeMismatchError,
  buildStripeAuthorizeUrl,
  classifyStripeConnectError,
  classifyStripeDeauthorizationError,
  createAuthorizedAccountObservation,
  deriveStripeLivemode,
  generateStripeConnectState,
  getStripeDeauthorizationRecovery,
  getStripeConnectRedirectUri,
  normalizeStripeAccount,
  normalizeStripeOAuthToken,
  retrieveStripeAccountObservation,
  retrieveStripeConnectionObservation,
} from "@/lib/stripeConnect";

describe("Stripe Connect helpers", () => {
  it("configures zero network retries and a bounded timeout for the single-use OAuth client", () => {
    const stripe = createStripeOAuthClient({
      STRIPE_SECRET_KEY: "sk_test_example",
      ENVIRONMENT: "development",
    });

    expect(STRIPE_OAUTH_MAX_NETWORK_RETRIES).toBe(0);
    expect(STRIPE_OAUTH_TIMEOUT_MS).toBe(20_000);
    expect(stripe.getMaxNetworkRetries()).toBe(0);
    expect(
      createStripeClient({ STRIPE_SECRET_KEY: "sk_test_example" })
        .getMaxNetworkRetries(),
    ).toBeGreaterThan(0);
  });

  it("refuses restricted live keys outside production", () => {
    expect(() =>
      createStripeClient({
        STRIPE_SECRET_KEY: "rk_live_example",
        ENVIRONMENT: "development",
      }),
    ).toThrow("Refusing to use a live-mode Stripe key outside production");
  });

  it("derives mode only after applying the Stripe client configuration guards", () => {
    expect(
      getGuardedStripeLivemode({
        STRIPE_SECRET_KEY: "rk_test_example",
        ENVIRONMENT: "development",
      }),
    ).toBe(false);
    expect(() => getGuardedStripeLivemode({})).toThrow(
      StripeConnectConfigurationError,
    );
    expect(() =>
      getGuardedStripeLivemode({
        STRIPE_SECRET_KEY: "malformed-key",
        ENVIRONMENT: "development",
      }),
    ).toThrow(StripeConnectConfigurationError);
    expect(() =>
      getGuardedStripeLivemode({
        STRIPE_SECRET_KEY: "sk_live_example",
        ENVIRONMENT: "development",
      }),
    ).toThrow(StripeConnectConfigurationError);
  });

  it("generates 32 random bytes encoded as unpadded base64url", () => {
    const first = generateStripeConnectState();
    const second = generateStripeConnectState();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it("derives mode from Stripe platform keys and rejects unknown keys", () => {
    expect(deriveStripeLivemode("sk_test_example")).toBe(false);
    expect(deriveStripeLivemode("rk_test_example")).toBe(false);
    expect(deriveStripeLivemode("sk_live_example")).toBe(true);
    expect(deriveStripeLivemode("rk_live_example")).toBe(true);
    expect(() => deriveStripeLivemode("not-a-stripe-key")).toThrow(
      "Stripe secret key mode could not be determined",
    );
  });

  it("builds the exact callback URL from APP_URL", () => {
    expect(getStripeConnectRedirectUri("https://quickspense.com///")).toBe(
      "https://quickspense.com/api/integrations/stripe/callback",
    );
    expect(getStripeConnectRedirectUri("http://localhost:4321/")).toBe(
      "http://localhost:4321/api/integrations/stripe/callback",
    );
  });

  it.each(["http://quickspense.com", "http://localhost.evil.test", "http://192.168.1.5", "https://example.com/path"])("rejects unsafe callback base %s", (url) => {
    expect(() => getStripeConnectRedirectUri(url, false)).toThrow(StripeConnectConfigurationError);
  });

  it.each(["http://localhost:4321", "http://127.0.0.1:4321", "http://[::1]:4321"])("allows HTTP only for loopback test callbacks %s", (url) => {
    expect(getStripeConnectRedirectUri(url, false)).toContain("/api/integrations/stripe/callback");
    expect(() => getStripeConnectRedirectUri(url, true)).toThrow(StripeConnectConfigurationError);
  });

  it.each([{ type: "StripePermissionError", statusCode: 403 }, { type: "StripeAuthenticationError", statusCode: 401 }, { code: "account_not_connected" }, { code: "already_deauthorized" }])("does not invent missing authorization evidence from %j", (error) => {
    expect(classifyStripeDeauthorizationError(error)).not.toBe("already_disconnected");
  });

  it("builds the Stripe authorize URL with only the required exact values", () => {
    const redirectUri =
      "https://quickspense.com/api/integrations/stripe/callback";
    const authorizeUrl = new URL(
      buildStripeAuthorizeUrl({
        clientId: "ca_example",
        redirectUri,
        state: "state_example",
        email: "owner@example.com",
      }),
    );

    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://connect.stripe.com/oauth/authorize",
    );
    expect(Object.fromEntries(authorizeUrl.searchParams)).toEqual({
      response_type: "code",
      client_id: "ca_example",
      scope: "read_write",
      redirect_uri: redirectUri,
      state: "state_example",
      "stripe_user[email]": "owner@example.com",
    });
  });

  it("extracts only safe OAuth fields and rejects scope or mode mismatches", () => {
    const normalized = normalizeStripeOAuthToken(
      {
        stripe_user_id: "acct_example",
        livemode: false,
        scope: "read_write",
        access_token: "secret-access-token",
        refresh_token: "secret-refresh-token",
        stripe_publishable_key: "pk_test_example",
      },
      false,
    );

    expect(normalized).toEqual({
      stripeAccountId: "acct_example",
      livemode: false,
    });
    expect(JSON.stringify(normalized)).not.toContain("token");
    expect(() =>
      normalizeStripeOAuthToken(
        {
          stripe_user_id: "acct_example",
          livemode: false,
          scope: "read_only",
        },
        false,
      ),
    ).toThrow("Stripe did not grant read-write access");
    expect(() =>
      normalizeStripeOAuthToken(
        {
          stripe_user_id: "acct_example",
          livemode: true,
          scope: "read_write",
        },
        false,
      ),
    ).toThrow(StripeConnectModeMismatchError);
  });

  it("normalizes account facts and rejects deleted or mismatched accounts", () => {
    expect(
      normalizeStripeAccount(
        {
          object: "account",
          id: "acct_example",
          charges_enabled: true,
          payouts_enabled: false,
          details_submitted: true,
        },
        "acct_example",
        false,
      ),
    ).toEqual({
      stripe_account_id: "acct_example",
      livemode: false,
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements: null,
    });

    expect(() =>
      normalizeStripeAccount(
        { object: "account", id: "acct_example", deleted: true },
        "acct_example",
        false,
      ),
    ).toThrow(StripeConnectAccountError);
    expect(() =>
      normalizeStripeAccount(
        {
          object: "account",
          id: "acct_other",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        },
        "acct_example",
        false,
      ),
    ).toThrow("Stripe returned an unexpected account");
  });

  it("keeps only requirement identifiers and error codes from Stripe account details", () => {
    const normalized = normalizeStripeAccount({ object: "account", id: "acct_requirements",
      charges_enabled: false, payouts_enabled: false, details_submitted: true,
      individual: { first_name: "Private name" },
      requirements: { disabled_reason: "requirements.past_due", currently_due: ["individual.verification.document"],
        past_due: ["individual.verification.document"], pending_verification: [],
        errors: [{ code: "verification_failed_keyed_identity", requirement: "individual.verification.document", reason: "Private explanation" }] },
    }, "acct_requirements", false);
    expect(normalized).toMatchObject({ requirements: { disabled_reason: "requirements.past_due",
      currently_due: ["individual.verification.document"], past_due: ["individual.verification.document"], pending_verification: [],
      errors: [{ code: "verification_failed_keyed_identity", requirement: "individual.verification.document" }] } });
    expect(JSON.stringify(normalized)).not.toMatch(/Private name|Private explanation/);
  });

  it("preserves case-sensitive person IDs in requirement paths and handles nullable Stripe lists", () => {
    const account = normalizeStripeAccount({ object: "account", id: "acct_requirements", charges_enabled: false,
      payouts_enabled: false, details_submitted: true, requirements: { disabled_reason: null,
        currently_due: ["person_1ABCdEf.verification.document", "private text with spaces"], past_due: null,
        pending_verification: null, errors: null } }, "acct_requirements", false);
    expect(account.requirements).toEqual({ disabled_reason: null, currently_due: ["person_1ABCdEf.verification.document"],
      past_due: [], pending_verification: [], errors: [] });
  });

  it("builds an operation-aware callback observation with a concrete timestamp", () => {
    const observedAt = new Date("2026-01-01T00:02:00.000Z");

    expect(
      createAuthorizedAccountObservation(
        {
          userId: "user_callback",
          operationId: "operation_callback",
          expectedAuthorizationRevision: "revision_callback",
          stripe_account_id: "acct_callback",
          livemode: false,
          charges_enabled: true,
          payouts_enabled: false,
          details_submitted: true,
        },
        observedAt,
      ),
    ).toEqual({
      userId: "user_callback",
      operationId: "operation_callback",
      expectedAuthorizationRevision: "revision_callback",
      stripe_account_id: "acct_callback",
      livemode: false,
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      observedAt,
    });
  });

  it("captures the observation timestamp before retrieving the Stripe account", async () => {
    const events: string[] = [];
    const observedAt = new Date("2026-01-01T00:02:00.000Z");

    const observation = await retrieveStripeAccountObservation(
      async () => {
        events.push("retrieve");
        return {
          object: "account",
          id: "acct_observed",
          charges_enabled: true,
          payouts_enabled: false,
          details_submitted: true,
        };
      },
      "acct_observed",
      false,
      () => {
        events.push("timestamp");
        return observedAt;
      },
    );

    expect(events).toEqual(["timestamp", "retrieve"]);
    expect(observation).toEqual({
      account: {
        stripe_account_id: "acct_observed",
        livemode: false,
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
        requirements: null,
      },
      observedAt,
    });
  });

  it("classifies Stripe and local errors without exposing raw messages", () => {
    expect(classifyStripeConnectError({ type: "StripeInvalidClientError" })).toBe(
      "configuration",
    );
    expect(classifyStripeConnectError({ type: "StripeInvalidGrantError" })).toBe(
      "oauth_invalid",
    );
    expect(classifyStripeConnectError({ type: "StripeRateLimitError" })).toBe(
      "unavailable",
    );
    expect(
      classifyStripeConnectError(new StripeConnectModeMismatchError()),
    ).toBe("mode_mismatch");
    expect(classifyStripeConnectError(new StripeConnectAccountError())).toBe(
      "account_invalid",
    );
    expect(classifyStripeConnectError(new Error("raw secret response"))).toBe(
      "unknown",
    );
  });

  it("classifies deauthorization outcomes for persistence recovery", () => {
    expect(
      classifyStripeDeauthorizationError(
        new StripeConnectConfigurationError(),
      ),
    ).toBe("rejected");
    expect(
      classifyStripeDeauthorizationError({
        type: "StripeInvalidClientError",
        raw: {
          type: "invalid_client",
          message:
            "The Stripe account is not connected to your application.",
        },
      }),
    ).toBe("already_disconnected");
    expect(
      classifyStripeDeauthorizationError({
        type: "StripeInvalidClientError",
        raw: { type: "invalid_client" },
      }),
    ).toBe("rejected");
    expect(
      classifyStripeDeauthorizationError({ type: "StripeInvalidRequestError" }),
    ).toBe("rejected");
    expect(
      classifyStripeDeauthorizationError({ type: "StripeConnectionError" }),
    ).toBe("ambiguous");
    expect(
      classifyStripeDeauthorizationError({ type: "StripeRateLimitError" }),
    ).toBe("ambiguous");
    expect(
      classifyStripeDeauthorizationError({ type: "StripeAPIError" }),
    ).toBe("ambiguous");
    expect(
      classifyStripeDeauthorizationError(new Error("unknown")),
    ).toBe("ambiguous");

    expect(getStripeDeauthorizationRecovery("rejected")).toBe("restore");
    expect(getStripeDeauthorizationRecovery("already_disconnected")).toBe(
      "finalize",
    );
    expect(getStripeDeauthorizationRecovery("ambiguous")).toBe(
      "leave_pending",
    );
  });
});

describe("Stripe SDK OAuth deauthorization errors", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["ECONNRESET", "EPIPE"])("never resubmits a consumed authorization code after %s", async (code) => {
    const fetch = vi.fn().mockRejectedValueOnce(Object.assign(new TypeError("Mock lost token response"), { code }))
      .mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    const stripe = createStripeOAuthClient({ STRIPE_SECRET_KEY: "sk_test_example", ENVIRONMENT: "development" });

    await expect(stripe.oauth.token({ grant_type: "authorization_code", code: "ac_single_use" }))
      .rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://connect.stripe.com/oauth/token", expect.objectContaining({ method: "POST" }));
  });

  it("does not resubmit an authorization code when Stripe requests a retry", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: "server_error" }), {
      status: 503, headers: { "Content-Type": "application/json", "stripe-should-retry": "true" },
    }));
    vi.stubGlobal("fetch", fetch);
    const stripe = createStripeOAuthClient({ STRIPE_SECRET_KEY: "sk_test_example", ENVIRONMENT: "development" });
    await expect(stripe.oauth.token({ grant_type: "authorization_code", code: "ac_single_use" })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("aborts a held OAuth request after 20 seconds without treating timeout as revocation", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetch);
    const stripe = createStripeOAuthClient({ STRIPE_SECRET_KEY: "sk_test_example", ENVIRONMENT: "development" });
    let error: unknown;
    let settled = false;
    const pending = stripe.oauth.deauthorize({ client_id: "ca_example", stripe_user_id: "acct_example" })
      .catch((caught: unknown) => { error = caught; })
      .finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(true);
    await pending;
    expect(error).toBeInstanceOf(Stripe.errors.StripeConnectionError);
    expect(error).toMatchObject({
      message: "Request aborted due to timeout being reached (20000ms)",
      raw: { detail: { code: "ETIMEDOUT" } },
    });
    expect(classifyStripeDeauthorizationError(error)).toBe("ambiguous");
    expect(getStripeDeauthorizationRecovery(classifyStripeDeauthorizationError(error))).toBe("leave_pending");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds the SDK's forced connection-reset retry within the disconnect lease", async () => {
    vi.useFakeTimers();
    let retrySignal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      if (fetch.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new TypeError("Mock connection reset"), {
            code: "ECONNRESET",
          })), 19_999);
        });
      }
      retrySignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        retrySignal?.addEventListener("abort", () => reject(retrySignal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetch);
    const stripe = createStripeOAuthClient({ STRIPE_SECRET_KEY: "sk_test_example", ENVIRONMENT: "development" });
    expect(stripe.getMaxNetworkRetries()).toBe(0);
    let error: unknown;
    let settled = false;
    const pending = stripe.oauth.deauthorize({ client_id: "ca_example", stripe_user_id: "acct_example" })
      .catch((caught: unknown) => { error = caught; })
      .finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retrySignal).toBeInstanceOf(AbortSignal);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(retrySignal?.aborted).toBe(true);
    expect(settled).toBe(true);
    await pending;
    expect(error).toBeInstanceOf(Stripe.errors.StripeConnectionError);
    expect(classifyStripeDeauthorizationError(error)).toBe("ambiguous");
    expect(getStripeDeauthorizationRecovery(classifyStripeDeauthorizationError(error))).toBe("leave_pending");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    "The Stripe account is not connected to your application.",
    "This account is not connected to your application.",
  ])("recognizes the SDK-normalized not-connected response: %s", async (message) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_client", error_description: message,
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const stripe = createStripeOAuthClient({ STRIPE_SECRET_KEY: "sk_test_example", ENVIRONMENT: "development" });
    const error = await stripe.oauth.deauthorize({ client_id: "ca_example", stripe_user_id: "acct_example" })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Stripe.errors.StripeInvalidClientError);
    expect(error).toMatchObject({ raw: { type: "invalid_client", message } });
    expect(error).not.toHaveProperty("raw.error");
    expect(error).not.toHaveProperty("raw.error_description");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://connect.stripe.com/oauth/deauthorize", expect.objectContaining({ method: "POST" }));
    expect(classifyStripeDeauthorizationError(error)).toBe("already_disconnected");
    expect(getStripeDeauthorizationRecovery(classifyStripeDeauthorizationError(error))).toBe("finalize");
  });

  it.each([
    { status: 400, body: { error: "invalid_client" } },
    { status: 400, body: { error: "invalid_client", error_description: "The client_id does not belong to you." } },
    { status: 400, body: { error: "invalid_client", error_description: "The API key mode does not match the client_id mode." } },
    { status: 400, body: { error: "invalid_client", error_description: "Cannot verify whether the Stripe account is not connected to your application." } },
    { status: 400, body: { error: "invalid_client", error_description: "The Stripe account is not connected to your application. Check API key permissions." } },
    { status: 401, body: { error: { type: "authentication_error", message: "The Stripe account is not connected to your application." } } },
    { status: 403, body: { error: { type: "permission_error", message: "The Stripe account is not connected to your application." } } },
  ])("does not treat a generic or ambiguous SDK HTTP failure as revocation: %j", async ({ status, body }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    })));
    const stripe = createStripeOAuthClient({ STRIPE_SECRET_KEY: "sk_test_example", ENVIRONMENT: "development" });
    const error = await stripe.oauth.deauthorize({ client_id: "ca_example", stripe_user_id: "acct_example" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Stripe.errors.StripeError);
    expect(classifyStripeDeauthorizationError(error)).not.toBe("already_disconnected");
    expect(getStripeDeauthorizationRecovery(classifyStripeDeauthorizationError(error))).not.toBe("finalize");
  });

  it.each(["StripeAuthenticationError", "StripePermissionError", "StripeConnectionError"])(
    "does not trust a not-connected message carried by %s", (type) => {
      expect(classifyStripeDeauthorizationError({ type, raw: {
        type: "invalid_client", message: "The Stripe account is not connected to your application.",
      } })).not.toBe("already_disconnected");
    },
  );

  it("keeps an SDK network failure ambiguous without automatic OAuth retries", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Mock network failure"));
    vi.stubGlobal("fetch", fetch);
    const stripe = createStripeOAuthClient({ STRIPE_SECRET_KEY: "sk_test_example", ENVIRONMENT: "development" });
    const error = await stripe.oauth.deauthorize({ client_id: "ca_example", stripe_user_id: "acct_example" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Stripe.errors.StripeConnectionError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(classifyStripeDeauthorizationError(error)).toBe("ambiguous");
    expect(getStripeDeauthorizationRecovery(classifyStripeDeauthorizationError(error))).toBe("leave_pending");
  });
});

describe("Stripe SDK connected-account inventory reconciliation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("checks every account page after a REST account_invalid error, present=%s", async (present) => {
    const account = { object: "account", id: "acct_expected", charges_enabled: true, payouts_enabled: true, details_submitted: true };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "account_invalid" } }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [{ ...account, id: "acct_other" }], has_more: true }), {
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: present ? [account] : [], has_more: false }), {
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    const stripe = createStripeClient({ STRIPE_SECRET_KEY: "sk_test_example" });

    const result = await retrieveStripeConnectionObservation(
      () => stripe.accounts.retrieve(account.id), account.id, false, () => stripe.accounts.list({ limit: 100 }),
    );
    expect(result.observation.kind).toBe(present ? "authorized" : "deauthorized");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new URL(fetch.mock.calls[2][0]).searchParams.get("starting_after")).toBe("acct_other");
  });

  it("does not treat a failed later inventory page as evidence of revocation", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "account_invalid" } }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [{ object: "account", id: "acct_other" }], has_more: true }), {
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "permission_error" } }), {
        status: 403, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    const stripe = createStripeClient({ STRIPE_SECRET_KEY: "sk_test_example" });
    await expect(retrieveStripeConnectionObservation(
      () => stripe.accounts.retrieve("acct_expected"), "acct_expected", false, () => stripe.accounts.list({ limit: 100 }),
    )).rejects.toBeInstanceOf(Stripe.errors.StripePermissionError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
