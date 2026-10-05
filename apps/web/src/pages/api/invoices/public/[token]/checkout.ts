import type { APIRoute } from "astro";
import { createDb, DomainError, payInvoiceSchema } from "@quickspense/domain";
import { payInvoice } from "@/lib/invoiceCheckout";

export const POST: APIRoute = async ({ params, locals }) => {
  const headers = {
    "Content-Type": "application/json",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
  const input = payInvoiceSchema.safeParse({ payToken: params.token });
  if (!input.success) return new Response(JSON.stringify({ error: "Invalid invoice payment link" }), { status: 400, headers });
  try {
    const env = locals.runtime.env;
    const result = await payInvoice(createDb(env.DB), input.data, env);
    return new Response(JSON.stringify(result), { headers });
  } catch (error) {
    if (error instanceof DomainError && [404, 409].includes(error.statusCode)) {
      return new Response(JSON.stringify({ error: error.message }), { status: error.statusCode, headers });
    }
    locals.logger.error("Invoice checkout confirmation failed");
    return new Response(JSON.stringify({ error: "Payment confirmation is temporarily unavailable. Please try again shortly." }), { status: 503, headers });
  }
};
