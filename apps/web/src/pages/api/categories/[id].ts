import type { APIRoute } from "astro";
import { categories, updateCategorySchema, createDb } from "@quickspense/domain";

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const categoryId = params.id!;

    const body = await request.json();
    const parsed = updateCategorySchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const updated = await categories.updateCategory(db, categoryId, user.id, parsed.data.name);
    return new Response(JSON.stringify(updated), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NotFoundError") {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (e instanceof Error && e.name === "ConflictError") {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Update category error:", e);
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
    const categoryId = params.id!;

    await categories.deleteCategory(db, categoryId, user.id);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NotFoundError") {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Delete category error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
