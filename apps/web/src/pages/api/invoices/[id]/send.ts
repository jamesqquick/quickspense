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
    // so it remains undefined. We skip the send and surface the pay URL in
    // the response (and console) so you can finish testing the flow without
    // a real email round-trip. Status is already 'sent'; the link works.
    if (!env.EMAIL) {
      const payUrl = `${env.APP_URL}/pay/${invoice.pay_token}`;
      locals.logger.warn(
        "EMAIL binding not available (local dev?); skipping email send",
        {
          invoiceId,
          to: invoice.client_email,
          payUrl,
        },
      );
      // eslint-disable-next-line no-console
      console.log(
        `\n[invoice ${invoice.invoice_number}] would email ${invoice.client_email}\n  pay url: ${payUrl}\n`,
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
