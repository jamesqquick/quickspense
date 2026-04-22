import type { APIRoute } from "astro";
import { auth, resetPasswordSchema } from "@quickspense/domain";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const parsed = resetPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const db = locals.runtime.env.DB;
    const logger = locals.logger;

    const validated = await auth.validatePasswordResetToken(db, parsed.data.token);

    if (!validated) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired reset token" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await auth.consumePasswordResetToken(
      db,
      validated.tokenId,
      validated.userId,
      parsed.data.password,
    );

    logger.info("Password reset completed", { userId: validated.userId });

    return new Response(
      JSON.stringify({ message: "Password reset successfully. You can now log in." }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    locals.logger.error("Reset password error", { error: e });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
