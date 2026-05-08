import type { APIRoute } from "astro";
import { expenses, createDb } from "@quickspense/domain";

/**
 * Returns counts of the user's expenses grouped by status. Used by the
 * dashboard's "Needs Review" / "Processing" cards.
 */
export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);

  const counts = await expenses.countExpensesByStatus(db, user.id);
  return new Response(JSON.stringify(counts), {
    headers: { "Content-Type": "application/json" },
  });
};
