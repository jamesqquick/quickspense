import type { APIRoute } from "astro";
import { auth, loginSchema, createDb } from "@quickspense/domain";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const db = createDb(locals.runtime.env.DB);
    const user = await auth.getUserByEmail(db, parsed.data.email);

    if (!user || !(await auth.verifyPassword(parsed.data.password, user.password_hash))) {
      return new Response(
        JSON.stringify({ error: "Invalid email or password" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    // Opportunistic rehash: if the stored hash uses fewer iterations than current standard, upgrade it
    if (auth.needsRehash(user.password_hash)) {
      try {
        await auth.upgradePasswordHash(db, user.id, parsed.data.password);
      } catch (e) {
        // Non-fatal: user can still log in
        console.error("Failed to upgrade password hash for user:", user.id, e);
      }
    }

    const session = await auth.createSession(db, user.id);

    return new Response(
      JSON.stringify({ user: { id: user.id, email: user.email } }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `session=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
        },
      },
    );
  } catch (e: unknown) {
    console.error("Login error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
