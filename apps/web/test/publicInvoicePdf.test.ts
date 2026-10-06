import { beforeEach, describe, expect, it, vi } from "vitest";
import { payToken } from "./helpers/invoicePayment";

const mocks = vi.hoisted(() => ({ getInvoiceByPayToken: vi.fn() }));
vi.mock("@quickspense/domain", () => ({
  createDb: () => ({}),
  invoices: mocks,
  businessProfiles: {},
}));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: vi.fn() } }));

import { GET } from "../src/pages/api/invoices/public/[token]/pdf";

beforeEach(() => vi.resetAllMocks());

describe("public invoice PDF failure logs", () => {
  it.each([new Error(`Failed query for ${payToken}`), payToken])(
    "keeps payment tokens and raw error details out of logs and responses",
    async (failure) => {
      mocks.getInvoiceByPayToken.mockRejectedValue(failure);
      const error = vi.fn();
      const response = await GET({
        params: { token: payToken },
        locals: { runtime: { env: { DB: {} } }, logger: { error } },
      } as Parameters<typeof GET>[0]);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to generate PDF" });
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(error).toHaveBeenCalledWith("Generate invoice PDF (public) failed", {
        errorType: failure instanceof Error ? "Error" : "UnknownError",
      });
      expect(JSON.stringify(error.mock.calls)).not.toContain(payToken);
    },
  );
});
