import type { APIRoute } from "astro";
import puppeteer from "@cloudflare/puppeteer";
import {
  invoices,
  businessProfiles,
  createDb,
} from "@quickspense/domain";
import { renderInvoicePrintHtml } from "../../../../lib/invoicePrintHtml";

/**
 * Owner-facing PDF download. Auth-gated via middleware (Astro.locals.user).
 * Returns 404 (not 403) for invoices owned by other users — the existence
 * of any given invoice ID is itself a private signal.
 *
 * Allowed for any status (draft / sent / paid / void) so the owner can
 * preview a draft as a PDF before sending it.
 *
 * In DEV (`astro dev`), the BROWSER binding isn't proxied by
 * getPlatformProxy and `puppeteer.launch` would throw. We gate on
 * `import.meta.env.DEV` (build-time replaced, tree-shaken in production)
 * and return the print HTML with a yellow banner instead, so the layout
 * is still previewable locally via the browser's Print → Save as PDF.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user!;
    const env = locals.runtime.env;
    const db = createDb(env.DB);
    const invoiceId = params.id!;

    const invoice = await invoices.getInvoice(db, invoiceId, user.id);
    if (!invoice) {
      return new Response("Invoice not found", { status: 404 });
    }

    const profile = await businessProfiles.getBusinessProfile(db, user.id);

    if (import.meta.env.DEV) {
      const html = renderInvoicePrintHtml(invoice, profile, {
        fallbackIssuerName: env.EMAIL_FROM_NAME,
        appUrl: env.APP_URL,
        devBanner: true,
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const html = renderInvoicePrintHtml(invoice, profile, {
      fallbackIssuerName: env.EMAIL_FROM_NAME,
      appUrl: env.APP_URL,
    });

    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdf = await page.pdf({ printBackground: true, format: "letter" });
      const filename = `${invoice.invoice_number}.pdf`;
      return new Response(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    } finally {
      await browser.close();
    }
  } catch (e) {
    locals.logger.error("Generate invoice PDF (owner) failed", {
      invoiceId: params.id,
      error: e,
    });
    return new Response(
      JSON.stringify({ error: "Failed to generate PDF" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
