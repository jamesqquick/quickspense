/// <reference types="astro/client" />

type D1Database = import("@cloudflare/workers-types").D1Database;
type R2Bucket = import("@cloudflare/workers-types").R2Bucket;
type Fetcher = import("@cloudflare/workers-types").Fetcher;
type Logger = import("@quickspense/domain").Logger;

type SendEmail = {
  send(message: {
    to: string | string[];
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string | { email: string; name?: string };
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
};

type Runtime = import("@astrojs/cloudflare").Runtime<{
  DB: D1Database;
  BUCKET: R2Bucket;
  WORKER: Fetcher;
  /**
   * Cloudflare Browser Rendering binding. Used by `@cloudflare/puppeteer`
   * to launch a headless browser for PDF generation. Not proxied by
   * `getPlatformProxy` so it is undefined under `astro dev`; PDF endpoints
   * gate on `import.meta.env.DEV` and return an HTML preview instead.
   */
  BROWSER: Fetcher;
  EMAIL: SendEmail;
  APP_URL: string;
  EMAIL_FROM_ADDRESS: string;
  EMAIL_FROM_NAME: string;
  WORKER_DEV_URL?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** "production" gates Stripe live-mode key usage. Set in wrangler.jsonc. */
  ENVIRONMENT?: string;
  /** Local override to allow `sk_live_...` outside production. Use sparingly. */
  STRIPE_ALLOW_LIVE_KEY?: string;
}>;

declare namespace App {
  interface Locals extends Runtime {
    user?: {
      id: string;
      email: string;
    };
    requestId: string;
    logger: Logger;
  }
}
