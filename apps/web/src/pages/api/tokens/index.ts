import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const result = await locals.auth.api.listApiKeys({
    headers: request.headers,
    query: {},
  });

  return Response.json(
    (result.apiKeys ?? []).map((k) => ({
      id: k.id,
      name: k.name ?? "Untitled",
      created_at: k.createdAt instanceof Date ? k.createdAt.toISOString() : k.createdAt,
    })),
  );
};

export const POST: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const name = body?.name;
  if (!name || typeof name !== "string" || name.length < 1 || name.length > 100) {
    return new Response(
      JSON.stringify({ error: "Token name is required (1-100 chars)" }),
      { status: 400 },
    );
  }

  const result = await locals.auth.api.createApiKey({
    body: {
      name,
      prefix: "qs_",
      userId: user.id,
    },
  });

  return Response.json({ token: result.key, tokenId: result.id });
};
