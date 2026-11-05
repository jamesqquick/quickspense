import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(() => ({})),
  duplicateInvoice: vi.fn(),
}));

vi.mock("@quickspense/domain", async (original) => {
  const actual = await original<typeof import("@quickspense/domain")>();

  return {
    ...actual,
    createDb: mocks.createDb,
    invoices: {
      ...actual.invoices,
      duplicateInvoice: mocks.duplicateInvoice,
    },
  };
});
vi.mock("astro:schema", async () => ({ z: (await import("astro/zod")).z }));
vi.mock("astro:actions", async () => import("../node_modules/astro/dist/actions/runtime/server.js"));

import { server } from "@/actions/index";

const invoiceId = "11111111-1111-4111-8111-111111111111";

function context(authenticated = true) {
  return {
    [Symbol.for("astro.actionAPIContext")]: true,
    locals: {
      user: authenticated ? { id: "issuer" } : undefined,
      runtime: { env: { DB: {} } },
      logger: { error: vi.fn() },
    },
  };
}

const invoke = (input: unknown, ctx = context()) =>
  server.invoice.duplicate.call(ctx as never, input as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createDb.mockReturnValue({});
  mocks.duplicateInvoice.mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    invoice_number: "INV-0002",
  });
});

describe("authenticated invoice duplicate Action", () => {
  it("uses the authenticated owner and returns only the new invoice identity", async () => {
    const result = await invoke({ id: invoiceId });

    expect(result).toMatchObject({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        invoice_number: "INV-0002",
      },
    });
    expect(mocks.duplicateInvoice).toHaveBeenCalledWith({}, invoiceId, "issuer");
  });

  it("refuses anonymous callers before opening a database", async () => {
    expect((await invoke({ id: invoiceId }, context(false))).error).toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mocks.createDb).not.toHaveBeenCalled();
    expect(mocks.duplicateInvoice).not.toHaveBeenCalled();
  });

  it.each([{}, { id: "invalid" }, { id: invoiceId, userId: "attacker" }])(
    "validates input %j before duplicating",
    async (input) => {
      expect((await invoke(input)).error).toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.duplicateInvoice).not.toHaveBeenCalled();
    },
  );

  it("maps cross-owner not-found and hides unexpected errors", async () => {
    const { NotFoundError } = await import("@quickspense/domain");
    mocks.duplicateInvoice.mockRejectedValue(new NotFoundError("Invoice", invoiceId));
    expect((await invoke({ id: invoiceId })).error).toMatchObject({
      code: "NOT_FOUND",
      message: "Invoice not found.",
    });

    mocks.duplicateInvoice.mockRejectedValue(new Error("private SQL details"));
    const ctx = context();
    const result = await invoke({ id: invoiceId }, ctx);
    expect(result.error).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(result.error?.message).not.toContain("private");
    expect(JSON.stringify(ctx.locals.logger.error.mock.calls)).not.toContain("private");
  });

  it("routes the detail-page mutation through the Action", () => {
    const source = readFileSync(
      new URL("../src/components/InvoiceDetail.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("actions.invoice.duplicate({ id: invoiceId })");
    expect(source).not.toContain("/api/invoices/${invoiceId}/duplicate");
  });
});
