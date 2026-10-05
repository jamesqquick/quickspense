import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { stripeConnections } from "@quickspense/domain";
import { connectionFixture } from "./helpers/invoicePayment";

vi.mock("astro:actions", () => ({ actions: { stripe: { refreshStatus: vi.fn(), disconnect: vi.fn(), recoverConnection: vi.fn() } } }));
import { StripeConnectionCard, type StripeConnectionView } from "@/components/StripeConnectionCard";

const requirements = {
  disabled_reason: "requirements.past_due", currently_due: ["individual.verification.document"],
  past_due: ["individual.verification.document"], pending_verification: [],
  errors: [{ code: "verification_failed_keyed_identity", requirement: "individual.verification.document" }],
};

function render(overrides: Parameters<typeof connectionFixture>[0] = {}, refreshConfigured = true) {
  const status = stripeConnections.getConnectionStatus(connectionFixture({ charges_enabled: false, payouts_enabled: false,
    requirements, ...overrides }), overrides.livemode ?? false);
  const connection: StripeConnectionView = { ...status, stripe_account_suffix: "suer" };
  return renderToStaticMarkup(createElement(StripeConnectionCard, {
    connectConfigured: true, disconnectConfigured: true, refreshConfigured, connection, recoveryState: null,
  }));
}

describe("Stripe account status guidance", () => {
  it("explains sandbox eligibility without hiding disabled flags or Stripe requirements", () => {
    const html = render();
    expect(html).toContain("Ready for sandbox");
    expect(html).toContain("Sandbox payments can be attempted even when these flags are disabled");
    expect(html).toContain("Charges: Not enabled");
    expect(html).toContain("Identity verification document");
    expect(html).toContain("Past due");
    expect(html).toContain("Stripe could not verify the identity details");
    expect(html).toContain("If no task appears, contact Stripe support");
    expect(html).toContain("Last checked:");
    expect(html).toMatch(/<button[^>]*>Refresh Stripe status<\/button>/);
    expect(html.match(/Identity verification document/g)).toHaveLength(2);
  });

  it("keeps live payment restrictions and requirements visible", () => {
    const html = render({ livemode: true });
    expect(html).toContain("Action required");
    expect(html).toContain("Live invoice payments require details submitted, charges enabled, and payouts enabled");
    expect(html).not.toContain("Ready for sandbox");
    expect(html).toContain("Identity verification document");
  });

  it("distinguishes missing requirement data from no information due", () => {
    expect(render({ requirements: null })).toContain("Refresh Stripe status to load the account");
    expect(render({ requirements: { disabled_reason: null, currently_due: [], past_due: [], pending_verification: [], errors: [] } }))
      .toContain("Stripe reports no information currently due");
  });

  it("shows pending verification separately from currently due information", () => {
    const html = render({ requirements: { ...requirements, currently_due: [], past_due: [], errors: [],
      disabled_reason: "requirements.pending_verification", pending_verification: ["individual.verification.document"] } });
    expect(html).toContain("Identity verification document: pending Stripe review");
    expect(html).not.toContain("Past due");
  });

  it("disables refresh during a pending disconnect or invalid configuration", () => {
    expect(render({ disconnect_operation_id: "pending" })).toMatch(/<button[^>]*disabled=""[^>]*>Refresh Stripe status<\/button>/);
    expect(render({}, false)).toMatch(/<button[^>]*disabled=""[^>]*>Refresh Stripe status<\/button>/);
  });
});
