import type { APIRoute } from "astro";
import { categories, createCategorySchema } from "@quickspense/domain";

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  const db = locals.runtime.env.DB;
  const list = await categories.listCategories(db, user.id);
  return new Response(JSON.stringify(list), {
    headers: { "Content-Type": "application/json" },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user!;
    const db = locals.runtime.env.DB;

    const body = await request.json();
    const parsed = createCategorySchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const category = await categories.createCategory(db, user.id, parsed.data.name);
    return new Response(JSON.stringify(category), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "ConflictError") {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Create category error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
