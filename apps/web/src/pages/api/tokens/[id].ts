import type { APIRoute } from "astro";
import { auth, createDb } from "@quickspense/domain";

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const tokenId = params.id!;

    await auth.deleteApiToken(db, tokenId, user.id);
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
    console.error("Delete token error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
