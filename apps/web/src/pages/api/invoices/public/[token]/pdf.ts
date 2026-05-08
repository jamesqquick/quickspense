import type { APIRoute } from "astro";
import puppeteer from "@cloudflare/puppeteer";
import {
  invoices,
  businessProfiles,
  createDb,
} from "@quickspense/domain";
import { renderInvoicePrintHtml } from "../../../../../lib/invoicePrintHtml";

/**
 * Public PDF download. Token-gated (no auth). Returns 404 for missing,
 * draft, or void invoices — matching the public print route. Uses the
 * same shape of 404 response for all three cases so we don't leak which
 * tokens correspond to draft/void invoices.
 *
 * Sets `Referrer-Policy: no-referrer` so the pay_token isn't leaked in
 * the Referer header when the user navigates away from the response.
 *
 * DEV fallback: when the BROWSER binding isn't available (e.g. under
 * `astro dev`), returns the print HTML with a yellow banner instead.
 * Gated on `import.meta.env.DEV`, which is build-time replaced and
 * tree-shaken from production builds.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const env = locals.runtime.env;
    const db = createDb(env.DB);
    const token = params.token!;

    const invoice = await invoices.getInvoiceByPayToken(db, token);
    if (
      !invoice ||
      invoice.status === "draft" ||
      invoice.status === "void"
    ) {
      return new Response("Invoice not available", {
        status: 404,
        headers: { "Referrer-Policy": "no-referrer" },
      });
    }

    const profile = await businessProfiles.getBusinessProfile(
      db,
      invoice.user_id,
    );

    if (import.meta.env.DEV) {
      const html = renderInvoicePrintHtml(invoice, profile, {
        fallbackIssuerName: env.EMAIL_FROM_NAME,
        appUrl: env.APP_URL,
        devBanner: true,
      });
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "no-referrer",
        },
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
          "Referrer-Policy": "no-referrer",
        },
      });
    } finally {
      await browser.close();
    }
  } catch (e) {
    locals.logger.error("Generate invoice PDF (public) failed", {
      token: params.token,
      error: e,
    });
    return new Response(
      JSON.stringify({ error: "Failed to generate PDF" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  }
};
