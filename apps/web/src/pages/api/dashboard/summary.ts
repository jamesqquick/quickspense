import type { APIRoute } from "astro";
import { expenses } from "@quickspense/domain";

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  const db = locals.runtime.env.DB;

  const summary = await expenses.getExpenseSummary(db, user.id);
  return new Response(JSON.stringify(summary), {
    headers: { "Content-Type": "application/json" },
  });
};
