import type { APIRoute } from "astro";
import { auth, createApiTokenSchema, createDb } from "@quickspense/domain";

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);
  const tokens = await auth.listApiTokens(db, user.id);
  return new Response(JSON.stringify(tokens), {
    headers: { "Content-Type": "application/json" },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);

    const body = await request.json();
    const parsed = createApiTokenSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const result = await auth.createApiToken(db, user.id, parsed.data.name);
    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    console.error("Create token error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
