import type { BusinessProfile, InvoiceWithLineItems } from "@quickspense/domain";

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

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Resolves the display name and contact info to use as the invoice issuer.
 *
 * Falls back to the env defaults when the user hasn't set up a profile yet.
 * The returned `fromName` is used for both the email "from" header and the
 * issuer name in the email body. We also surface the issuer's email as
 * `Reply-To` when one is set, so client replies go directly to the user.
 */
export function resolveIssuer(
  profile: BusinessProfile | null,
  envFromName: string,
): {
  displayName: string;
  replyTo: string | null;
  address: string | null;
  phone: string | null;
} {
  return {
    displayName: profile?.business_name ?? envFromName,
    replyTo: profile?.business_email ?? null,
    address: profile?.business_address ?? null,
    phone: profile?.business_phone ?? null,
  };
}

export async function sendInvoiceEmail(params: {
  email: SendEmail;
  fromAddress: string;
  fromName: string;
  appUrl: string;
  invoice: InvoiceWithLineItems;
  /** When set, used to override `fromName` and supply Reply-To and footer info. */
  businessProfile?: BusinessProfile | null;
}): Promise<void> {
  const {
    email,
    fromAddress,
    fromName,
    appUrl,
    invoice,
    businessProfile,
  } = params;

  const issuer = resolveIssuer(businessProfile ?? null, fromName);
  const displayName = issuer.displayName;

  const payUrl = `${appUrl}/pay/${invoice.pay_token}`;
  const totalFormatted = `$${formatCents(invoice.total)}`;
  const dueLine = `Due by ${invoice.due_date}.`;

  const lineItemsHtml = invoice.line_items
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(item.description)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${item.quantity}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">$${formatCents(item.unit_price)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">$${formatCents(item.line_total)}</td>
        </tr>
      `,
    )
    .join("");

  const issuerFooterTextLines = [
    `-- ${displayName}`,
    issuer.address ?? "",
    [issuer.replyTo, issuer.phone].filter(Boolean).join(" · "),
  ].filter((line) => line.length > 0);

  const text = [
    `Hello ${invoice.client_name},`,
    "",
    `You have a new invoice from ${displayName}.`,
    "",
    `Invoice: ${invoice.invoice_number}`,
    `Total due: ${totalFormatted}`,
    dueLine,
    "",
    "View and pay your invoice:",
    payUrl,
    "",
    ...issuerFooterTextLines,
  ]
    .filter(Boolean)
    .join("\n");

  const issuerFooterHtmlParts = [
    `-- ${escapeHtml(displayName)}`,
    issuer.address
      ? `<br/><span style="white-space:pre-line;">${escapeHtml(issuer.address)}</span>`
      : "",
    issuer.replyTo || issuer.phone
      ? `<br/>${escapeHtml(
          [issuer.replyTo, issuer.phone].filter(Boolean).join(" · "),
        )}`
      : "",
  ];

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
      <h2 style="margin:0 0 16px;">Invoice ${escapeHtml(invoice.invoice_number)}</h2>
      <p>Hello ${escapeHtml(invoice.client_name)},</p>
      <p>You have a new invoice from <strong>${escapeHtml(displayName)}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr style="text-align:left;border-bottom:2px solid #111;">
            <th style="padding:8px 0;">Description</th>
            <th style="padding:8px 0;text-align:right;">Qty</th>
            <th style="padding:8px 0;text-align:right;">Unit</th>
            <th style="padding:8px 0;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${lineItemsHtml}</tbody>
        <tfoot>
          <tr><td colspan="3" style="padding:8px 0;text-align:right;">Subtotal</td><td style="padding:8px 0;text-align:right;">$${formatCents(invoice.subtotal)}</td></tr>
          <tr><td colspan="3" style="padding:8px 0;text-align:right;">Tax</td><td style="padding:8px 0;text-align:right;">$${formatCents(invoice.tax_amount)}</td></tr>
          <tr><td colspan="3" style="padding:8px 0;text-align:right;font-weight:700;border-top:2px solid #111;">Total</td><td style="padding:8px 0;text-align:right;font-weight:700;border-top:2px solid #111;">${totalFormatted}</td></tr>
        </tfoot>
      </table>
      ${dueLine ? `<p>${escapeHtml(dueLine)}</p>` : ""}
      <p style="margin:24px 0;">
        <a href="${payUrl}" style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">View &amp; pay invoice</a>
      </p>
      <p style="color:#555;font-size:12px;">If the button doesn't work, paste this URL into your browser:<br/>${payUrl}</p>
      <p style="color:#888;font-size:12px;margin-top:32px;">${issuerFooterHtmlParts.join("")}</p>
    </div>
  `;

  await email.send({
    to: invoice.client_email,
    from: { email: fromAddress, name: displayName },
    subject: `Invoice ${invoice.invoice_number} from ${displayName}`,
    text,
    html,
    // Direct client replies to the issuer's business email when set, so the
    // user actually receives questions from clients (otherwise replies go
    // to the EMAIL_FROM_ADDRESS which is a system address).
    ...(issuer.replyTo ? { replyTo: issuer.replyTo } : {}),
  });
}
