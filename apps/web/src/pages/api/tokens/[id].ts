import type { APIRoute } from "astro";
import { createAuth, createDb } from "@quickspense/domain";

export const DELETE: APIRoute = async ({ locals, params, request, url }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const tokenId = params.id;
  if (!tokenId) {
    return new Response(JSON.stringify({ error: "Token ID required" }), { status: 400 });
  }

  const env = locals.runtime.env;
  const db = createDb(env.DB);
  const auth = createAuth(db, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL || url.origin,
  });

  try {
    await auth.api.deleteApiKey({
      body: { keyId: tokenId },
      headers: request.headers,
    });
    return new Response(null, { status: 204 });
  } catch {
    return new Response(JSON.stringify({ error: "Token not found" }), { status: 404 });
  }
};
