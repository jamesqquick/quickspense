import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { paymentEnv } from "./helpers/invoicePayment";

const mocks = vi.hoisted(() => ({ voidInvoice: vi.fn(), createDb: vi.fn(() => ({})) }));
vi.mock("@/lib/invoiceVoid", () => ({ voidInvoice: mocks.voidInvoice }));
vi.mock("@quickspense/domain", async (original) => ({ ...await original<typeof import("@quickspense/domain")>(), createDb: mocks.createDb }));
vi.mock("astro:schema", async () => ({ z: (await import("astro/zod")).z }));
vi.mock("astro:actions", async () => import("../node_modules/astro/dist/actions/runtime/server.js"));
import { server } from "@/actions/index";
import { POST } from "@/pages/api/invoices/[id]/void";

const invoiceId = "11111111-1111-4111-8111-111111111111";
function context(authenticated = true) {
  return { [Symbol.for("astro.actionAPIContext")]: true, locals: {
    user: authenticated ? { id: "issuer" } : undefined,
    runtime: { env: { ...paymentEnv, DB: {} } }, logger: { error: vi.fn() },
  } };
}
const invoke = (input: unknown, ctx = context()) => server.invoice.void.call(ctx as never, input as never);
beforeEach(() => { vi.resetAllMocks(); mocks.voidInvoice.mockResolvedValue({ id: invoiceId, status: "void" }); });

describe("authenticated invoice void Action and compatibility route", () => {
  it("takes ownership only from the authenticated session", async () => {
    expect(await invoke({ id: invoiceId })).toMatchObject({ data: { status: "void" } });
    expect(mocks.voidInvoice).toHaveBeenCalledWith({}, invoiceId, "issuer", expect.objectContaining(paymentEnv));
  });
  it("refuses anonymous callers before opening a database", async () => {
    expect((await invoke({ id: invoiceId }, context(false))).error).toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.createDb).not.toHaveBeenCalled();
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
    expect((await POST({ ...context(false), params: { id: invoiceId } } as never)).status).toBe(401);
    expect(mocks.createDb).not.toHaveBeenCalled();
  });
  it.each([{}, { id: "invalid" }, { id: invoiceId, userId: "attacker" }])("validates input %j before changing the invoice", async (input) => {
    expect((await invoke(input)).error).toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
  });
  it("maps conflicts and cross-owner not-found without leaking unexpected errors", async () => {
    const { ConflictError, NotFoundError } = await import("@quickspense/domain");
    mocks.voidInvoice.mockRejectedValue(new ConflictError("Resolve outstanding payments first."));
    expect((await invoke({ id: invoiceId })).error).toMatchObject({ code: "CONFLICT" });
    mocks.voidInvoice.mockRejectedValue(new NotFoundError("Invoice", invoiceId));
    expect((await invoke({ id: invoiceId })).error).toMatchObject({ code: "NOT_FOUND", message: "Invoice not found." });
    mocks.voidInvoice.mockRejectedValue(new Error("private SQL/account fixture"));
    const ctx = context();
    const result = await invoke({ id: invoiceId }, ctx);
    expect(result.error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(result.error?.message).not.toContain("private");
    expect(JSON.stringify(ctx.locals.logger.error.mock.calls)).not.toContain("private");
  });
  it("keeps the API as a thin authenticated orchestration wrapper", async () => {
    const response = await POST({ ...context(), params: { id: invoiceId } } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "void" });
    expect(mocks.voidInvoice).toHaveBeenCalledWith({}, invoiceId, "issuer", expect.objectContaining(paymentEnv));
  });
  it("routes InvoiceDetail void mutations through the Action", () => {
    const source = readFileSync(new URL("../src/components/InvoiceDetail.tsx", import.meta.url), "utf8");
    expect(source).toContain("actions.invoice.void({ id: invoiceId })");
    expect(source).not.toContain("`/api/invoices/${invoiceId}/void`");
  });
});
