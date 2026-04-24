import type { APIRoute } from "astro";
import { auth, registerSchema, createDb } from "@quickspense/domain";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const db = createDb(locals.runtime.env.DB);
    const user = await auth.createUser(db, parsed.data.email, parsed.data.password);
    const session = await auth.createSession(db, user.id);

    return new Response(
      JSON.stringify({ user: { id: user.id, email: user.email } }),
      {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `session=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
        },
      },
    );
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "ConflictError") {
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    console.error("Register error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
