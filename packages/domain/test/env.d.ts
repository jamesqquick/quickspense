declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PAYMENT_DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
