import type { APIRoute } from "astro";
import { receipts } from "@quickspense/domain";

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  const db = locals.runtime.env.DB;

  const counts = await receipts.countReceiptsByStatus(db, user.id);
  return new Response(JSON.stringify(counts), {
    headers: { "Content-Type": "application/json" },
  });
};
