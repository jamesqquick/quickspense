import type { APIRoute } from "astro";
import {
  invoices,
  createInvoiceSchema,
  listInvoicesSchema,
  createDb,
} from "@quickspense/domain";

export const GET: APIRoute = async ({ locals, url }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);

  const params = listInvoicesSchema.safeParse({
    status: url.searchParams.get("status") || undefined,
    limit: url.searchParams.get("limit") || 20,
    offset: url.searchParams.get("offset") || 0,
  });

  if (!params.success) {
    return new Response(
      JSON.stringify({ error: params.error.issues[0].message }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const list = await invoices.listInvoices(db, user.id, params.data);
  return new Response(JSON.stringify(list), {
    headers: { "Content-Type": "application/json" },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);

    const body = await request.json();
    const parsed = createInvoiceSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const created = await invoices.createDraftInvoice(db, {
      userId: user.id,
      client_name: parsed.data.client_name,
      client_email: parsed.data.client_email,
      client_address: parsed.data.client_address,
      notes: parsed.data.notes,
      due_date: parsed.data.due_date,
      tax_amount: parsed.data.tax_amount,
      line_items: parsed.data.line_items,
    });

    return new Response(JSON.stringify(created), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    locals.logger.error("Create invoice error", { error: e });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
