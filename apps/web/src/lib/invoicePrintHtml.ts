import type {
  BusinessProfile,
  InvoiceWithLineItems,
} from "@quickspense/domain";

export type RenderInvoiceOptions = {
  /** Used as the issuer name when the user has no business profile yet. */
  fallbackIssuerName: string;
  /** Public app URL, included in the rendered footer for client reference. */
  appUrl: string;
  /**
   * If true, prepends a yellow "DEV MODE" banner to the rendered page. Used
   * by the dev fallback in PDF endpoints when the BROWSER binding isn't
   * available (e.g. under `astro dev`). Never true in production.
   */
  devBanner?: boolean;
};

const ESCAPE_LOOKUP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE_LOOKUP[ch] ?? ch);
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function statusLabel(status: InvoiceWithLineItems["status"]): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "sent":
      return "Outstanding";
    case "void":
      return "Voided";
    case "draft":
    default:
      return "Draft";
  }
}

/**
 * Renders a self-contained, print-optimized HTML document for an invoice.
 *
 * The output has no external assets (no <link>, no <script>, no <img src>),
 * so puppeteer's `page.setContent(html)` renders deterministically without
 * waiting on the network. Both the in-browser print routes and the PDF
 * endpoints use this single source of truth so the printed view and the
 * PDF stay in sync.
 *
 * Issuer fields fall back to `opts.fallbackIssuerName` (typically
 * `EMAIL_FROM_NAME`) when the user hasn't set up a business profile.
 */
export function renderInvoicePrintHtml(
  invoice: InvoiceWithLineItems,
  businessProfile: BusinessProfile | null,
  opts: RenderInvoiceOptions,
): string {
  const issuerName = businessProfile?.business_name ?? opts.fallbackIssuerName;
  const issuerEmail = businessProfile?.business_email ?? null;
  const issuerPhone = businessProfile?.business_phone ?? null;
  const issuerAddress = businessProfile?.business_address ?? null;

  const issuerContact = [issuerEmail, issuerPhone].filter(Boolean).join(" · ");

  const lineItemsHtml = invoice.line_items
    .map(
      (item) => `
        <tr>
          <td class="desc">${escapeHtml(item.description)}</td>
          <td class="num">${item.quantity}</td>
          <td class="num">$${formatCents(item.unit_price)}</td>
          <td class="num">$${formatCents(item.line_total)}</td>
        </tr>`,
    )
    .join("");

  const issuedDate = invoice.issued_at?.split("T")[0] ?? null;
  const paidDate = invoice.paid_at?.split("T")[0] ?? null;

  const devBannerHtml = opts.devBanner
    ? `<div class="dev-banner">DEV MODE — preview only. PDF generation is disabled outside Workers runtime.</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Invoice ${escapeHtml(invoice.invoice_number)}</title>
    <style>
      @page { size: Letter; margin: 0.75in; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        color: #0f172a;
        background: #ffffff;
        font-size: 12pt;
        line-height: 1.4;
      }
      .container {
        max-width: 7in;
        margin: 0 auto;
        padding: 0.25in 0;
      }
      .dev-banner {
        background: #fef3c7;
        border: 1px solid #f59e0b;
        color: #78350f;
        padding: 8px 12px;
        margin-bottom: 16px;
        font-size: 10pt;
        text-align: center;
        border-radius: 4px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
        border-bottom: 2px solid #0f172a;
        padding-bottom: 12px;
        margin-bottom: 18px;
      }
      .header .issuer {
        flex: 1;
      }
      .issuer-name {
        font-size: 16pt;
        font-weight: 700;
        margin: 0 0 4px 0;
      }
      .issuer-meta {
        font-size: 10pt;
        color: #475569;
        white-space: pre-line;
        margin: 0;
      }
      .invoice-meta {
        text-align: right;
      }
      .invoice-meta .label {
        font-size: 9pt;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #64748b;
      }
      .invoice-meta .number {
        font-size: 14pt;
        font-weight: 700;
        margin: 2px 0 6px 0;
      }
      .status {
        display: inline-block;
        padding: 2px 8px;
        font-size: 9pt;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        border-radius: 4px;
        background: #e2e8f0;
        color: #0f172a;
      }
      .status.paid { background: #dcfce7; color: #166534; }
      .status.void { background: #fee2e2; color: #991b1b; }
      .status.sent { background: #dbeafe; color: #1e40af; }
      .columns {
        display: flex;
        gap: 24px;
        margin-bottom: 18px;
      }
      .columns .col {
        flex: 1;
      }
      .col h3 {
        font-size: 9pt;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #64748b;
        margin: 0 0 4px 0;
      }
      .col .name {
        font-weight: 600;
        margin: 0;
      }
      .col p {
        margin: 2px 0;
        color: #334155;
        font-size: 10pt;
        white-space: pre-line;
      }
      table.items {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 18px;
      }
      table.items thead th {
        text-align: left;
        font-size: 9pt;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #64748b;
        padding: 8px 6px;
        border-bottom: 1px solid #cbd5e1;
      }
      table.items thead th.num {
        text-align: right;
      }
      table.items td {
        padding: 8px 6px;
        border-bottom: 1px solid #e2e8f0;
        vertical-align: top;
      }
      table.items td.desc {
        white-space: pre-line;
      }
      table.items td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .totals {
        margin-left: auto;
        width: 50%;
      }
      .totals .row {
        display: flex;
        justify-content: space-between;
        padding: 4px 6px;
        font-size: 10pt;
      }
      .totals .row.total {
        font-size: 12pt;
        font-weight: 700;
        border-top: 2px solid #0f172a;
        margin-top: 4px;
        padding-top: 8px;
      }
      .notes {
        margin-top: 24px;
        padding-top: 12px;
        border-top: 1px solid #e2e8f0;
      }
      .notes h3 {
        font-size: 9pt;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #64748b;
        margin: 0 0 4px 0;
      }
      .notes p {
        margin: 0;
        font-size: 10pt;
        color: #334155;
        white-space: pre-line;
      }
      .footer {
        margin-top: 36px;
        padding-top: 12px;
        border-top: 1px solid #e2e8f0;
        font-size: 9pt;
        color: #94a3b8;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <div class="container">
      ${devBannerHtml}

      <div class="header">
        <div class="issuer">
          <p class="issuer-name">${escapeHtml(issuerName)}</p>
          ${
            issuerAddress
              ? `<p class="issuer-meta">${escapeHtml(issuerAddress)}</p>`
              : ""
          }
          ${
            issuerContact
              ? `<p class="issuer-meta">${escapeHtml(issuerContact)}</p>`
              : ""
          }
        </div>
        <div class="invoice-meta">
          <div class="label">Invoice</div>
          <div class="number">${escapeHtml(invoice.invoice_number)}</div>
          <span class="status ${invoice.status}">${statusLabel(invoice.status)}</span>
        </div>
      </div>

      <div class="columns">
        <div class="col">
          <h3>Bill to</h3>
          <p class="name">${escapeHtml(invoice.client_name)}</p>
          <p>${escapeHtml(invoice.client_email)}</p>
          ${
            invoice.client_address
              ? `<p>${escapeHtml(invoice.client_address)}</p>`
              : ""
          }
        </div>
        <div class="col" style="text-align: right;">
          <h3>Dates</h3>
          ${issuedDate ? `<p><strong>Issued:</strong> ${escapeHtml(issuedDate)}</p>` : ""}
          <p><strong>Due:</strong> ${escapeHtml(invoice.due_date)}</p>
          ${paidDate ? `<p><strong>Paid:</strong> ${escapeHtml(paidDate)}</p>` : ""}
        </div>
      </div>

      <table class="items">
        <thead>
          <tr>
            <th>Description</th>
            <th class="num">Qty</th>
            <th class="num">Unit</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>${lineItemsHtml}
        </tbody>
      </table>

      <div class="totals">
        <div class="row">
          <span>Subtotal</span>
          <span>$${formatCents(invoice.subtotal)}</span>
        </div>
        <div class="row">
          <span>Tax</span>
          <span>$${formatCents(invoice.tax_amount)}</span>
        </div>
        <div class="row total">
          <span>Total ${escapeHtml(invoice.currency.toUpperCase())}</span>
          <span>$${formatCents(invoice.total)}</span>
        </div>
      </div>

      ${
        invoice.notes
          ? `<div class="notes">
              <h3>Notes</h3>
              <p>${escapeHtml(invoice.notes)}</p>
            </div>`
          : ""
      }

      <div class="footer">
        Generated by ${escapeHtml(opts.appUrl)}
      </div>
    </div>
  </body>
</html>`;
}
