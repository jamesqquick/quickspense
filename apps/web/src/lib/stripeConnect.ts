import type { StripeAccountRequirements, StripeAccountStatus } from "@quickspense/domain";

const STRIPE_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
const STRIPE_CALLBACK_PATH = "/api/integrations/stripe/callback";

export type StripeConnectErrorCategory =
  | "configuration"
  | "oauth_invalid"
  | "mode_mismatch"
  | "account_invalid"
  | "unavailable"
  | "unknown";

export type StripeDeauthorizationErrorOutcome =
  | "rejected"
  | "already_disconnected"
  | "ambiguous";

export type StripeDeauthorizationRecovery =
  | "restore"
  | "finalize"
  | "leave_pending";

export type AuthorizedAccountObservationInput = StripeAccountStatus & {
  userId: string;
  operationId: string;
  expectedAuthorizationRevision: string;
};

export class StripeConnectConfigurationError extends Error {
  constructor(message = "Stripe Connect is not configured") {
    super(message);
    this.name = "StripeConnectConfigurationError";
  }
}

export class StripeConnectOAuthResponseError extends Error {
  constructor(message = "Stripe returned an invalid OAuth response") {
    super(message);
    this.name = "StripeConnectOAuthResponseError";
  }
}

export class StripeConnectModeMismatchError extends Error {
  constructor() {
    super("Stripe OAuth mode does not match the platform key");
    this.name = "StripeConnectModeMismatchError";
  }
}

export class StripeConnectAccountError extends Error {
  constructor(message = "Stripe returned an invalid account") {
    super(message);
    this.name = "StripeConnectAccountError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function deriveStripeLivemode(secretKey: string): boolean {
  if (/^[sr]k_test_/.test(secretKey)) return false;
  if (/^[sr]k_live_/.test(secretKey)) return true;
  throw new StripeConnectConfigurationError(
    "Stripe secret key mode could not be determined",
  );
}

export function getStripeConnectRedirectUri(appUrl: string, livemode = false): string {
  const baseUrl = appUrl.replace(/\/+$/, "");

  try {
    const parsed = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/" ||
      (parsed.protocol === "http:" && (livemode || !["localhost", "[::1]"].includes(parsed.hostname)
        && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname)))
    ) {
      throw new StripeConnectConfigurationError("APP_URL is invalid");
    }
  } catch {
    throw new StripeConnectConfigurationError("APP_URL is invalid");
  }

  return `${baseUrl}${STRIPE_CALLBACK_PATH}`;
}

export function generateStripeConnectState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildStripeAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  email: string;
}): string {
  if (!input.clientId || !input.state || !input.email) {
    throw new StripeConnectConfigurationError();
  }

  const url = new URL(STRIPE_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("stripe_user[email]", input.email);
  return url.toString();
}

export function normalizeStripeOAuthToken(
  response: unknown,
  expectedLivemode: boolean,
): { stripeAccountId: string; livemode: boolean } {
  if (!isRecord(response) || response.scope !== "read_write") {
    throw new StripeConnectOAuthResponseError(
      "Stripe did not grant read-write access",
    );
  }
  if (response.livemode !== expectedLivemode) {
    throw new StripeConnectModeMismatchError();
  }
  if (
    typeof response.stripe_user_id !== "string" ||
    !response.stripe_user_id.startsWith("acct_")
  ) {
    throw new StripeConnectOAuthResponseError();
  }

  return {
    stripeAccountId: response.stripe_user_id,
    livemode: expectedLivemode,
  };
}

function normalizeStripeRequirements(value: unknown): StripeAccountRequirements | null {
  if (!isRecord(value)) return null;
  const isIdentifier = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z0-9_.]+$/i.test(value);
  const identifiers = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter(isIdentifier) : [];

  return {
    disabled_reason: isIdentifier(value.disabled_reason) ? value.disabled_reason : null,
    currently_due: identifiers(value.currently_due),
    past_due: identifiers(value.past_due),
    pending_verification: identifiers(value.pending_verification),
    errors: Array.isArray(value.errors) ? value.errors.flatMap((error) =>
      isRecord(error) && isIdentifier(error.code) && isIdentifier(error.requirement)
        ? [{ code: error.code, requirement: error.requirement }] : [],
    ) : [],
  };
}

export function normalizeStripeAccount(
  account: unknown,
  expectedAccountId: string,
  livemode: boolean,
): StripeAccountStatus {
  if (
    !isRecord(account) ||
    account.object !== "account" ||
    account.deleted === true
  ) {
    throw new StripeConnectAccountError();
  }
  if (account.id !== expectedAccountId) {
    throw new StripeConnectAccountError("Stripe returned an unexpected account");
  }
  if (
    typeof account.charges_enabled !== "boolean" ||
    typeof account.payouts_enabled !== "boolean" ||
    typeof account.details_submitted !== "boolean"
  ) {
    throw new StripeConnectAccountError();
  }

  return {
    stripe_account_id: expectedAccountId,
    livemode,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    details_submitted: account.details_submitted,
    requirements: normalizeStripeRequirements(account.requirements),
  };
}

export async function retrieveStripeAccountObservation(
  retrieve: () => Promise<unknown>,
  expectedAccountId: string,
  livemode: boolean,
  now: () => Date = () => new Date(),
): Promise<{ account: StripeAccountStatus; observedAt: Date }> {
  const observedAt = now();
  const account = normalizeStripeAccount(
    await retrieve(),
    expectedAccountId,
    livemode,
  );
  return { account, observedAt };
}

export function createAuthorizedAccountObservation(
  input: AuthorizedAccountObservationInput,
  observedAt: Date,
): AuthorizedAccountObservationInput & { observedAt: Date } {
  return { ...input, observedAt };
}

export function classifyStripeConnectError(
  error: unknown,
): StripeConnectErrorCategory {
  if (error instanceof StripeConnectConfigurationError) return "configuration";
  if (error instanceof StripeConnectModeMismatchError) return "mode_mismatch";
  if (error instanceof StripeConnectAccountError) return "account_invalid";
  if (error instanceof StripeConnectOAuthResponseError) return "oauth_invalid";
  if (!isRecord(error)) return "unknown";

  const raw = isRecord(error.raw) ? error.raw : undefined;
  const type =
    typeof error.type === "string"
      ? error.type
      : typeof raw?.type === "string"
        ? raw.type
        : typeof error.code === "string"
          ? error.code
          : "";

  if (
    [
      "StripeInvalidClientError",
      "StripeAuthenticationError",
      "invalid_client",
      "authentication_error",
    ].includes(type)
  ) {
    return "configuration";
  }
  if (
    [
      "StripeInvalidGrantError",
      "StripeOAuthInvalidRequestError",
      "StripeInvalidScopeError",
      "StripeUnsupportedGrantTypeError",
      "StripeUnsupportedResponseTypeError",
      "invalid_grant",
      "invalid_request",
      "invalid_scope",
      "unsupported_grant_type",
      "unsupported_response_type",
    ].includes(type)
  ) {
    return "oauth_invalid";
  }
  if (
    [
      "StripeRateLimitError",
      "StripeConnectionError",
      "StripeAPIError",
      "rate_limit_error",
      "api_error",
    ].includes(type)
  ) {
    return "unavailable";
  }

  return "unknown";
}

export function classifyStripeDeauthorizationError(
  error: unknown,
): StripeDeauthorizationErrorOutcome {
  if (error instanceof StripeConnectConfigurationError) return "rejected";
  if (!isRecord(error)) return "ambiguous";

  const raw = isRecord(error.raw) ? error.raw : undefined;
  const markers = [
    stringValue(error, "type"),
    stringValue(error, "code"),
    stringValue(raw, "type"),
    stringValue(raw, "code"),
    stringValue(raw, "error"),
  ].filter((value): value is string => Boolean(value));
  if (
    error.type === "StripeInvalidClientError" &&
      raw?.type === "invalid_client" &&
      /^(?:The Stripe account|This account) is not connected to your application\.$/.test(stringValue(raw, "message") ?? "") &&
      !markers.some((marker) => ["StripePermissionError", "StripeAuthenticationError", "StripeConnectionError"].includes(marker))
  ) {
    return "already_disconnected";
  }

  if (
    markers.some((marker) =>
      [
        "StripeInvalidClientError",
        "StripeAuthenticationError",
        "StripePermissionError",
        "StripeInvalidRequestError",
        "StripeOAuthInvalidRequestError",
        "invalid_client",
        "invalid_request",
        "authentication_error",
        "permission_error",
      ].includes(marker),
    )
  ) {
    return "rejected";
  }

  return "ambiguous";
}

export async function retrieveStripeConnectionObservation(
  retrieve: () => Promise<unknown>, expectedAccountId: string, livemode: boolean,
  listAccounts: () => AsyncIterable<unknown>,
): Promise<{ observedAt: Date; observation: { kind: "authorized"; account: StripeAccountStatus } | { kind: "deauthorized" } }> {
  const observedAt = new Date();
  try {
    const account = normalizeStripeAccount(await retrieve(), expectedAccountId, livemode);
    return { observedAt, observation: { kind: "authorized", account } };
  } catch (error) {
    if (error instanceof StripeConnectAccountError) throw error;
    // A failed account retrieval does not prove revocation. Require a successful, fully paginated inventory.
    for await (const account of listAccounts()) {
      if (!isRecord(account) || account.object !== "account" || typeof account.id !== "string") {
        throw new StripeConnectAccountError();
      }
      if (account.id === expectedAccountId) {
        return { observedAt, observation: { kind: "authorized", account: normalizeStripeAccount(account, expectedAccountId, livemode) } };
      }
    }
    return { observedAt, observation: { kind: "deauthorized" } };
  }
}

export function getStripeDeauthorizationRecovery(
  outcome: StripeDeauthorizationErrorOutcome,
): StripeDeauthorizationRecovery {
  if (outcome === "rejected") return "restore";
  if (outcome === "already_disconnected") return "finalize";
  return "leave_pending";
}
