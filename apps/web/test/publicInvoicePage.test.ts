import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { experimental_AstroContainer } from "astro/container";
import { getViteConfig } from "astro/config";
import react from "@astrojs/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { payToken } from "./helpers/invoicePayment";

let page: Parameters<experimental_AstroContainer["renderToResponse"]>[0];
let container: experimental_AstroContainer;
let closeServer: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const require = createRequire(createRequire(import.meta.url).resolve("astro/package.json"));
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  const config = await getViteConfig({
    configFile: false, envFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: "payment-page-test-actions", enforce: "pre",
      resolveId(id) { if (id === "astro:actions") return "\0payment-page-test-actions"; },
      load(id) { if (id === "\0payment-page-test-actions") return "export const actions = {};"; },
    }],
  }, { configFile: false, root: process.cwd(), output: "server", integrations: [react()], logLevel: "silent" })({ command: "serve", mode: "test" });
  const server = await createServer(config);
  closeServer = () => server.close();
  ({ default: page } = await server.ssrLoadModule("/src/pages/pay/[token].astro"));
  const { default: renderer } = await server.ssrLoadModule("@astrojs/react/server.js");
  container = await experimental_AstroContainer.create();
  container.addServerRenderer({ renderer });
  container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
}, 30_000);

afterAll(() => closeServer?.());
beforeEach(() => {
  for (const method of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => vi.restoreAllMocks());

function renderPage(database: unknown) {
  return container.renderToResponse(page, {
    request: new Request(`https://quickspense.test/pay/${payToken}?status=success`),
    params: { token: payToken },
    locals: { runtime: { env: { DB: database, EMAIL_FROM_NAME: "Fixture issuer" } } } as never,
    partial: false,
  });
}

describe("real public Astro payment page", () => {
  it.each(["query rejection", "prepare failure", "non-Error rejection"])("contains %s without exposing the token or driver diagnostic", async (stage) => {
    const detail = `Fixture D1 failure containing ${payToken} and private SQL`;
    const failure = stage === "non-Error rejection"
      ? { message: detail, name: payToken, stack: detail }
      : Object.assign(new Error(detail), { name: payToken, cause: { token: payToken } });
    const database = {
      prepare: vi.fn(() => {
        if (stage === "prepare failure") throw failure;
        return { bind: () => ({ raw: async () => { throw failure; } }) };
      }),
    };
    const response = await renderPage(database);
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html).toContain("We couldn't load this invoice. Please try again shortly.");
    expect(html).not.toMatch(/Invoice not available|Payment successful|Processing your payment|Pay \$/);
    expect(html).not.toContain(payToken);
    expect(html).not.toContain(detail);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("[invoice.public.page] read_failed");
    for (const method of ["warn", "log", "info", "debug"] as const) expect(console[method]).not.toHaveBeenCalled();
    expect(database.prepare).toHaveBeenCalled();
  });

  it("returns a private 404 only for an actual missing invoice", async () => {
    const response = await renderPage({ prepare: () => ({ bind: () => ({ raw: async () => [] }) }) });
    const html = await response.text();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html).toContain("Invoice not available");
    expect(html).not.toContain("We couldn't load this invoice");
    expect(console.error).not.toHaveBeenCalled();
  });
});
