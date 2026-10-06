import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), createLogger: vi.fn() }));
vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock("@quickspense/domain", () => ({
  createDb: () => ({}), newRequestId: () => "request_test", createLogger: mocks.createLogger,
  createAuth: () => ({ api: { getSession: mocks.getSession } }),
}));
import { onRequest } from "@/middleware";
beforeEach(() => {
  vi.resetAllMocks(); mocks.getSession.mockResolvedValue(null);
  mocks.createLogger.mockReturnValue({ error: vi.fn() });
});
async function requestPath(pathname: string) {
  const request = new Request(`https://quickspense.test${pathname}`, { method: "POST" });
  const next = vi.fn(async () => new Response("public handler"));
  const response = await onRequest({ request, url: new URL(request.url), locals: { runtime: { env: { DB: {} } } },
    redirect: () => new Response(null, { status: 302 }) } as never, next);
  return { response, next };
}
describe("anonymous payment middleware boundary", () => {
  it.each(["/_actions/invoice.pay", "/_actions/invoice.pay/", "/api/webhooks/stripe", "/api/webhooks/stripe-connect"])("allows exact public route %s", async (path) => {
    const { response, next } = await requestPath(path);
    expect(response.status).toBe(200); expect(next).toHaveBeenCalledOnce();
  });
  it.each(["/_actions/invoice.pay.admin", "/_actions/invoice.pay/admin", "/_actions/invoice.pay//", "/_actions/invoice.pay/admin/", "/_actions/stripe.disconnect", "/_actions/stripe.disconnect/", "/_actions/stripe.recoverConnection", "/_actions/stripe.resolveUnconfirmedAuthorization", "/api/webhooks/stripe/admin", "/api/webhooks/stripe-connect/admin"])("keeps nested/admin route %s authenticated", async (path) => {
    const { response, next } = await requestPath(path);
    expect(response.status).toBe(401); expect(next).not.toHaveBeenCalled();
  });
  it.each(["/pay", "/api/invoices/public"])("redacts pay tokens in %s request logs", async (prefix) => {
    const token = `qsi_${"a".repeat(64)}`;
    const { response, next } = await requestPath(`${prefix}/${token}/checkout`);
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
    expect(mocks.createLogger).toHaveBeenCalledWith(expect.objectContaining({ path: `${prefix}/[token]/checkout` }));
    expect(JSON.stringify(mocks.createLogger.mock.calls)).not.toContain(token);
  });
});
