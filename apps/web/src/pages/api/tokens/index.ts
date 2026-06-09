import type { APIRoute } from "astro";
import { createAuth, createDb } from "@quickspense/domain";

export const GET: APIRoute = async ({ locals, request, url }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const env = locals.runtime.env;
  const db = createDb(env.DB);
  const auth = createAuth(db, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL || url.origin,
  });

  const result = await auth.api.listApiKeys({
    headers: request.headers,
    query: {},
  });

  return Response.json(
    (result.apiKeys ?? []).map((k: { id: string; name: string | null; createdAt: Date }) => ({
      id: k.id,
      name: k.name ?? "Untitled",
      created_at: k.createdAt instanceof Date ? k.createdAt.toISOString() : k.createdAt,
    })),
  );
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const body = await request.json();
  const name = body?.name;
  if (!name || typeof name !== "string" || name.length < 1 || name.length > 100) {
    return new Response(
      JSON.stringify({ error: "Token name is required (1-100 chars)" }),
      { status: 400 },
    );
  }

  const env = locals.runtime.env;
  const db = createDb(env.DB);
  const auth = createAuth(db, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL || url.origin,
  });

  const result = await auth.api.createApiKey({
    body: {
      name,
      prefix: "qs_",
      userId: user.id,
    },
  });

  return Response.json({ token: result.key, tokenId: result.id });
};
