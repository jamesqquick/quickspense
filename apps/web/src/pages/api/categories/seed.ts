import type { APIRoute } from "astro";
import { categories, createDb } from "@quickspense/domain";

export const POST: APIRoute = async ({ locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);

    await categories.seedGlobalCategories(db);

    // Return the full updated list (global + user's custom)
    const list = await categories.listCategories(db, user.id);
    return new Response(JSON.stringify(list), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    console.error("Seed categories error:", e);
    return new Response(
      JSON.stringify({ error: "Failed to seed default categories" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
