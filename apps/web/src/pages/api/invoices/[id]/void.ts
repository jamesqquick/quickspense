import type { APIRoute } from "astro";
import { invoices, createDb, DomainError } from "@quickspense/domain";

export const POST: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const invoiceId = params.id!;

    const invoice = await invoices.voidInvoice(db, invoiceId, user.id);
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
    locals.logger.error("Void invoice error", { error: e });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
