import type { APIRoute } from "astro";
import { receipts, parse, updateParsedFieldsSchema } from "@quickspense/domain";

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user!;
  const db = locals.runtime.env.DB;
  const receiptId = params.id!;

  const receipt = await receipts.getReceipt(db, receiptId, user.id);
  if (!receipt) {
    return new Response(JSON.stringify({ error: "Receipt not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const parsed = await parse.getLatestParsedReceipt(db, receiptId);

  return new Response(JSON.stringify({ receipt, parsed }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user!;
  const db = locals.runtime.env.DB;
  const receiptId = params.id!;

  const receipt = await receipts.getReceipt(db, receiptId, user.id);
  if (!receipt) {
    return new Response(JSON.stringify({ error: "Receipt not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json();
  const parsed = updateParsedFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: parsed.error.issues[0].message }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const latest = await parse.getLatestParsedReceipt(db, receiptId);
  if (!latest) {
    return new Response(JSON.stringify({ error: "No parsed data to update" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const updated = await parse.updateParsedReceiptFields(
    db,
    latest.id,
    parsed.data,
  );

  return new Response(JSON.stringify(updated), {
    headers: { "Content-Type": "application/json" },
  });
};
