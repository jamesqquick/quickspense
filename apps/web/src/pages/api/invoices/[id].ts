import type { APIRoute } from "astro";
import {
  invoices,
  updateInvoiceSchema,
  createDb,
  DomainError,
} from "@quickspense/domain";

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);
  const invoiceId = params.id!;

  const invoice = await invoices.getInvoice(db, invoiceId, user.id);
  if (!invoice) {
    return new Response(JSON.stringify({ error: "Invoice not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(invoice), {
    headers: { "Content-Type": "application/json" },
  });
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const invoiceId = params.id!;

    const body = await request.json();
    const parsed = updateInvoiceSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const updated = await invoices.updateDraftInvoice(
      db,
      invoiceId,
      user.id,
      parsed.data,
    );
    return new Response(JSON.stringify(updated), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    if (e instanceof DomainError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    }
    locals.logger.error("Update invoice error", { error: e });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const invoiceId = params.id!;

    await invoices.deleteInvoice(db, invoiceId, user.id);
    return new Response(null, { status: 204 });
  } catch (e: unknown) {
    if (e instanceof DomainError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    }
    locals.logger.error("Delete invoice error", { error: e });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
