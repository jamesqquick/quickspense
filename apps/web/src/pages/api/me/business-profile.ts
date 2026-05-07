import type { APIRoute } from "astro";
import {
  businessProfiles,
  upsertBusinessProfileSchema,
  createDb,
  DomainError,
} from "@quickspense/domain";

/**
 * Returns the authenticated user's business profile, or 404 if none exists.
 * The 404 is meaningful: callers (settings UI) use it to show an empty form.
 */
export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);

  const profile = await businessProfiles.getBusinessProfile(db, user.id);
  if (!profile) {
    return new Response(
      JSON.stringify({ error: "Business profile not set" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify(profile), {
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Upserts the authenticated user's business profile.
 *
 * Field semantics:
 * - `business_name` (required): always overwrites
 * - `business_email`, `business_phone`, `business_address` (optional):
 *     omit to leave unchanged on update; pass `null` to clear; pass a string to set
 */
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return new Response(
        JSON.stringify({ error: "Invalid request body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const parsed = upsertBusinessProfileSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const profile = await businessProfiles.upsertBusinessProfile(
      db,
      user.id,
      parsed.data,
    );

    return new Response(JSON.stringify(profile), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    if (e instanceof DomainError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    }
    locals.logger.error("Upsert business profile error", { error: e });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
