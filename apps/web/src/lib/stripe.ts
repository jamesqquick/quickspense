import Stripe from "stripe";
import {
  StripeConnectConfigurationError,
  deriveStripeLivemode,
} from "@/lib/stripeConnect";

/**
 * Construct a Stripe client with safety guards. Refuses to use a live-mode
 * Stripe key (`sk_live_...` or `rk_live_...`) when the runtime looks like
 * local development.
 *
 * Why: `getPlatformProxy` under `astro dev` can connect to *production*
 * Cloudflare bindings (D1, R2) when `remoteBindings: true`. If a developer
 * also pastes a live Stripe key into `.dev.vars`, a stray click during
 * testing can charge real cards, send real emails, and pollute prod data.
 *
 * Treat any of the following as "not production":
 * - `import.meta.env.DEV` is true (Astro dev server)
 * - `env.ENVIRONMENT` is set to anything other than "production"
 *
 * If you genuinely need to test against live mode locally (e.g. reproducing
 * a prod-only bug), set `STRIPE_ALLOW_LIVE_KEY=1` in `.dev.vars` and
 * understand the blast radius first.
 */
type StripeClientEnv = {
  STRIPE_SECRET_KEY?: string;
  ENVIRONMENT?: string;
  STRIPE_ALLOW_LIVE_KEY?: string;
};

export const STRIPE_OAUTH_MAX_NETWORK_RETRIES = 0;
// Leave margin within the 60-second disconnect lease, including Stripe's forced connection-reset retry.
export const STRIPE_OAUTH_TIMEOUT_MS = 20 * 1000;

class StripeOAuthTokenTransportError extends Error {
  constructor(cause: unknown) {
    super("Stripe OAuth token exchange outcome is unknown", { cause });
    this.name = "StripeOAuthTokenTransportError";
  }
}

class StripeOAuthHttpClient extends Stripe.HttpClient {
  private readonly client = Stripe.createFetchHttpClient();

  getClientName(): string {
    return this.client.getClientName();
  }

  async makeRequest(...args: Parameters<typeof this.client.makeRequest>) {
    try {
      return await this.client.makeRequest(...args);
    } catch (error) {
      // The SDK forcibly retries ECONNRESET/EPIPE even with zero retries. OAuth codes must be submitted once.
      if (args[2] === "/oauth/token") throw new StripeOAuthTokenTransportError(error);
      throw error;
    }
  }
}

function createClient(
  env: StripeClientEnv,
  maxNetworkRetries?: number,
  timeout?: number,
  httpClient = Stripe.createFetchHttpClient(),
): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new StripeConnectConfigurationError(
      "STRIPE_SECRET_KEY is not configured",
    );
  }

  const isLiveKey = /^[sr]k_live_/.test(env.STRIPE_SECRET_KEY);
  const isProductionEnv = env.ENVIRONMENT === "production";
  // import.meta.env.DEV is replaced at build time. In production builds this
  // becomes `false` and is tree-shaken; in `astro dev` it's `true`.
  const isDevServer = import.meta.env.DEV === true;
  const allowOverride = env.STRIPE_ALLOW_LIVE_KEY === "1";

  if (isLiveKey && (isDevServer || !isProductionEnv) && !allowOverride) {
    throw new StripeConnectConfigurationError(
      "Refusing to use a live-mode Stripe key outside production. " +
        "Use a test key (sk_test_...) or set ENVIRONMENT=production for the runtime " +
        "(or STRIPE_ALLOW_LIVE_KEY=1 if you really know what you're doing).",
    );
  }

  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-04-22.dahlia",
    httpClient,
    ...(maxNetworkRetries === undefined ? {} : { maxNetworkRetries }),
    ...(timeout === undefined ? {} : { timeout }),
  });
}

export function createStripeClient(env: StripeClientEnv): Stripe {
  return createClient(env);
}

export function createStripeOAuthClient(env: StripeClientEnv): Stripe {
  return createClient(env, STRIPE_OAUTH_MAX_NETWORK_RETRIES, STRIPE_OAUTH_TIMEOUT_MS, new StripeOAuthHttpClient());
}

export function getGuardedStripeLivemode(env: StripeClientEnv): boolean {
  createStripeClient(env);
  return deriveStripeLivemode(env.STRIPE_SECRET_KEY!);
}
