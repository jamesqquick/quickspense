import Stripe from "stripe";

/**
 * Construct a Stripe client with safety guards. Refuses to use a live-mode
 * Stripe key (`sk_live_...`) when the runtime looks like local development.
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
export function createStripeClient(env: {
  STRIPE_SECRET_KEY?: string;
  ENVIRONMENT?: string;
  STRIPE_ALLOW_LIVE_KEY?: string;
}): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const isLiveKey = env.STRIPE_SECRET_KEY.startsWith("sk_live_");
  const isProductionEnv = env.ENVIRONMENT === "production";
  // import.meta.env.DEV is replaced at build time. In production builds this
  // becomes `false` and is tree-shaken; in `astro dev` it's `true`.
  const isDevServer = import.meta.env.DEV === true;
  const allowOverride = env.STRIPE_ALLOW_LIVE_KEY === "1";

  if (isLiveKey && (isDevServer || !isProductionEnv) && !allowOverride) {
    throw new Error(
      "Refusing to use a live-mode Stripe key (sk_live_...) outside production. " +
        "Use a test key (sk_test_...) or set ENVIRONMENT=production for the runtime " +
        "(or STRIPE_ALLOW_LIVE_KEY=1 if you really know what you're doing).",
    );
  }

  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-04-22.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}
