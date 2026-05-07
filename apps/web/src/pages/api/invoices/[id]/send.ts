import type { APIRoute } from "astro";
import { invoices, createDb, DomainError } from "@quickspense/domain";
import { sendInvoiceEmail } from "../../../../lib/invoiceEmail";

export const POST: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user!;
    const env = locals.runtime.env;
    const db = createDb(env.DB);
    const invoiceId = params.id!;

    // Transition status -> sent (idempotent)
    const invoice = await invoices.markInvoiceSent(db, invoiceId, user.id);

    // env.EMAIL (the send_email binding) is only available on the Cloudflare
    // runtime. In `astro dev` getPlatformProxy does NOT proxy send_email,
    // so it remains undefined. In dev we surface the pay URL inline so the
    // flow is testable without real email delivery.
    //
    // SECURITY: We gate this fallback on `import.meta.env.DEV` (replaced
    // at build time and tree-shaken in production), NOT just `!env.EMAIL`.
    // If we used `!env.EMAIL` and the binding ever went missing in prod
    // (misconfig, deploy slip), we'd leak the pay_token URL to the
    // authenticated owner's logs and response — the owner can already
    // read the token, but the response shape `dev_email_skipped: true`
    // shipping to real production clients would silently misreport
    // successful delivery.
    const isDev = import.meta.env.DEV === true;
    if (!env.EMAIL) {
      if (!isDev) {
        // Production with no EMAIL binding: fail closed. Don't pretend we
        // sent the email; the caller should retry once the deploy is fixed.
        // markInvoiceSent already transitioned status -> sent (idempotent),
        // so the retry path works.
        locals.logger.error(
          "EMAIL binding missing in production; refusing to silently skip",
          { invoiceId },
        );
        return new Response(
          JSON.stringify({
            error: "Invoice marked sent but email binding is unavailable. Retry shortly.",
            invoice,
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }

      const payUrl = `${env.APP_URL}/pay/${invoice.pay_token}`;
      // Don't log the pay URL: tokens in log aggregators are an avoidable
      // leak vector even in dev. The authenticated owner sees the URL
      // inline in the response below.
      locals.logger.warn(
        "EMAIL binding not available (local dev); skipping email send",
        { invoiceId },
      );
      return new Response(
        JSON.stringify({
          ...invoice,
          dev_email_skipped: true,
          dev_pay_url: payUrl,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Send the email
    try {
      await sendInvoiceEmail({
        email: env.EMAIL,
        fromAddress: env.EMAIL_FROM_ADDRESS,
        fromName: env.EMAIL_FROM_NAME,
        appUrl: env.APP_URL,
        invoice,
      });
      locals.logger.info("Invoice email sent", {
        invoiceId,
        to: invoice.client_email,
      });
    } catch (e) {
      // Status is already 'sent'; surface the email failure but don't roll back.
      // The user can retry sending from the UI (idempotent).
      locals.logger.error("Failed to send invoice email", {
        invoiceId,
        error: e,
      });
      return new Response(
        JSON.stringify({
          error: "Invoice marked sent but email delivery failed",
          invoice,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(invoice), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    if (e instanceof DomainError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    }
    locals.logger.error("Send invoice error", { error: e });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
