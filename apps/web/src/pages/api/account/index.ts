import type { APIRoute } from "astro";
import { auth } from "@quickspense/domain";

export const DELETE: APIRoute = async ({ locals, cookies }) => {
  const user = locals.user!;
  const db = locals.runtime.env.DB;
  const bucket = locals.runtime.env.BUCKET;
  const logger = locals.logger;

  logger.warn("Account deletion requested");

  try {
    // Remove user from D1 (cascades to all user-owned tables).
    // Returns the list of R2 file keys to clean up.
    const { fileKeys } = await auth.deleteUser(db, user.id);

    // Clean up R2 objects. Best-effort: if any fail, we've already deleted
    // the D1 rows so the files are orphaned but no longer linked to a user.
    let deleted = 0;
    let failed = 0;
    for (const key of fileKeys) {
      try {
        await bucket.delete(key);
        deleted += 1;
      } catch (e) {
        failed += 1;
        logger.error("Failed to delete R2 object", { key, error: e });
      }
    }

    logger.info("Account deleted", {
      r2ObjectsDeleted: deleted,
      r2ObjectsFailed: failed,
    });

    // Clear session cookie
    cookies.delete("session", { path: "/" });

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    logger.error("Account deletion failed", { error: e });
    return new Response(
      JSON.stringify({ error: "Failed to delete account" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
