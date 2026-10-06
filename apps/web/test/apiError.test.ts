import { describe, expect, it } from "vitest";
import { getApiErrorMessage } from "../src/lib/apiError";

describe("API error messages", () => {
  it("preserves the server's string error message", () => {
    expect(getApiErrorMessage({ error: "Only draft invoices can be edited" }, "Failed"))
      .toBe("Only draft invoices can be edited");
  });

  it.each([null, undefined, {}, "failure", [], { error: "" }, { error: 42 }, { error: { message: "failure" } }])(
    "uses the fallback for malformed error response %j",
    (data) => {
      expect(getApiErrorMessage(data, "Failed to save")).toBe("Failed to save");
    },
  );
});
