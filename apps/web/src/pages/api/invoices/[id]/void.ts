import type { APIRoute } from "astro";
import { createDb, DomainError } from "@quickspense/domain";
import { voidInvoice } from "@/lib/invoiceVoid";

export const POST: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ error: "You must be logged in." }), { status: 401, headers: { "Content-Type": "application/json" } });
    const db = createDb(locals.runtime.env.DB);
    const invoiceId = params.id!;

    const invoice = await voidInvoice(db, invoiceId, user.id, locals.runtime.env);
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
    locals.logger.error("Void invoice confirmation failed");
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
