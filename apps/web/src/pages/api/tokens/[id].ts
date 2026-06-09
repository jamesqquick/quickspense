import type { APIRoute } from "astro";

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const tokenId = params.id;
  if (!tokenId) {
    return new Response(JSON.stringify({ error: "Token ID required" }), { status: 400 });
  }

  try {
    await locals.auth.api.deleteApiKey({
      body: { keyId: tokenId },
      headers: request.headers,
    });
    return new Response(null, { status: 204 });
  } catch (e) {
    locals.logger.error("Failed to delete API key", { tokenId, error: e });
    return new Response(JSON.stringify({ error: "Failed to delete token" }), { status: 500 });
  }
};
