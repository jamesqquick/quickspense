import { beforeEach, describe, expect, it, vi } from "vitest";
import { payToken, paymentEnv } from "./helpers/invoicePayment";

const mocks = vi.hoisted(() => ({ payInvoice: vi.fn(), createDb: vi.fn(() => ({})) }));
vi.mock("@/lib/invoiceCheckout", () => ({ payInvoice: mocks.payInvoice }));
vi.mock("@quickspense/domain", async (original) => ({ ...await original<typeof import("@quickspense/domain")>(), createDb: mocks.createDb }));
vi.mock("astro:schema", async () => ({ z: (await import("astro/zod")).z }));
// Use Astro's real parser/Action wrapper, while replacing only its virtual module entry point.
vi.mock("astro:actions", async () => import("../node_modules/astro/dist/actions/runtime/server.js"));
import { server } from "@/actions/index";
import { POST } from "@/pages/api/invoices/public/[token]/checkout";

function context() {
  return { [Symbol.for("astro.actionAPIContext")]: true, locals: { runtime: { env: { ...paymentEnv, DB: {} } }, logger: { error: vi.fn() } } };
}
const invoke = (input: unknown, ctx = context()) => server.invoice.pay.call(ctx as never, input as never);
beforeEach(() => { vi.resetAllMocks(); mocks.payInvoice.mockResolvedValue({ status: "processing" }); });

describe("public typed invoice payment Action", () => {
  it("permits anonymous pay-token holders and returns a typed processing result", async () => {
    const result = await invoke({ payToken });
    expect(result).toEqual({ data: { status: "processing" }, error: undefined });
    expect(mocks.payInvoice).toHaveBeenCalledWith({}, { payToken }, expect.objectContaining(paymentEnv));
  });
  it.each([{}, { payToken: "" }, { payToken: "short" }, { payToken, userId: "attacker" }, { payToken: `${payToken}/path` }])("validates token/input before orchestration %j", async (input) => {
    expect((await invoke(input)).error).toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.payInvoice).not.toHaveBeenCalled();
  });
  it("maps safe payment conflicts without exposing internal errors", async () => {
    const { ConflictError } = await import("@quickspense/domain");
    mocks.payInvoice.mockRejectedValue(new ConflictError("Payment is already being confirmed. Refresh shortly."));
    expect((await invoke({ payToken })).error).toMatchObject({ code: "CONFLICT" });
    mocks.payInvoice.mockRejectedValue(new Error(`SQL failed with ${payToken}`));
    const result = await invoke({ payToken });
    expect(result.error?.message).not.toContain(payToken);
    expect(result.error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("keeps the existing Checkout API as a thin wrapper with no-cache/no-referrer", async () => {
    const response = await POST({ ...context(), params: { token: payToken } } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "processing" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.payInvoice).toHaveBeenCalledOnce();
  });
});
