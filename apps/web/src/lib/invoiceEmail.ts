import type { InvoiceWithLineItems } from "@quickspense/domain";

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

export async function sendInvoiceEmail(params: {
  email: SendEmail;
  fromAddress: string;
  fromName: string;
  appUrl: string;
  invoice: InvoiceWithLineItems;
}): Promise<void> {
  const { email, fromAddress, fromName, appUrl, invoice } = params;
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

  const text = [
    `Hello ${invoice.client_name},`,
    "",
    `You have a new invoice from ${fromName}.`,
    "",
    `Invoice: ${invoice.invoice_number}`,
    `Total due: ${totalFormatted}`,
    dueLine,
    "",
    "View and pay your invoice:",
    payUrl,
    "",
    `-- ${fromName}`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111;">
      <h2 style="margin:0 0 16px;">Invoice ${escapeHtml(invoice.invoice_number)}</h2>
      <p>Hello ${escapeHtml(invoice.client_name)},</p>
      <p>You have a new invoice from <strong>${escapeHtml(fromName)}</strong>.</p>
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
      <p style="color:#888;font-size:12px;margin-top:32px;">-- ${escapeHtml(fromName)}</p>
    </div>
  `;

  await email.send({
    to: invoice.client_email,
    from: { email: fromAddress, name: fromName },
    subject: `Invoice ${invoice.invoice_number} from ${fromName}`,
    text,
    html,
  });
}
