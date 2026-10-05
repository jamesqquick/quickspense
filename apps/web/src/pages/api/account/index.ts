import type { APIRoute } from "astro";
import {
  ConflictError,
  createDb,
  deleteUser,
  stripeConnections,
} from "@quickspense/domain";

export const DELETE: APIRoute = async ({ locals, request }) => {
  const user = locals.user!;
  const db = createDb(locals.runtime.env.DB);
  const bucket = locals.runtime.env.BUCKET;
  const logger = locals.logger;

  logger.warn("Account deletion requested");

  try {
    const deletionBlock = await stripeConnections.getAccountDeletionBlock(
      db,
      user.id,
    );
    if (deletionBlock) {
      logger.warn("Account deletion blocked by Stripe connection state", {
        reason: deletionBlock,
      });
      return new Response(
        JSON.stringify({
          error:
            deletionBlock === "outstanding_payments"
              ? "Resolve sent invoices and pending Stripe payments before deleting your account."
              : "Disconnect Stripe and resolve any pending connection work before deleting your account.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    // Remove user from D1 (cascades to all user-owned tables).
    // Returns the list of R2 file keys to clean up.
    const { fileKeys } = await deleteUser(db, user.id);

    // Best-effort cookie cleanup; deleting the user already cascaded sessions.
    try {
      await locals.auth.api.signOut({ headers: request.headers });
    } catch {
      // The deleted session can make the auth-layer signout a no-op.
    }

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

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    if (e instanceof ConflictError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    logger.error("Account deletion failed", { error: e });
    return new Response(
      JSON.stringify({ error: "Failed to delete account" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
