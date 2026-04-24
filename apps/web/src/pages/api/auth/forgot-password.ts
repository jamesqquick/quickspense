import type { APIRoute } from "astro";
import { auth, forgotPasswordSchema, createDb } from "@quickspense/domain";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const parsed = forgotPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const db = createDb(locals.runtime.env.DB);
    const email = locals.runtime.env.EMAIL;
    const appUrl = locals.runtime.env.APP_URL;
    const fromAddress = locals.runtime.env.EMAIL_FROM_ADDRESS;
    const fromName = locals.runtime.env.EMAIL_FROM_NAME;
    const logger = locals.logger;

    const user = await auth.getUserByEmail(db, parsed.data.email);

    // Always respond success to avoid leaking whether the email is registered.
    // Only send the actual email if the user exists.
    if (user) {
      try {
        const { token } = await auth.createPasswordResetToken(db, user.id);
        const resetUrl = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;

        await email.send({
          to: user.email,
          from: { email: fromAddress, name: fromName },
          subject: "Reset your Quickspense password",
          text: `Hello,\n\nYou requested a password reset for your Quickspense account. Click the link below to set a new password. This link expires in 1 hour.\n\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.\n\n-- Quickspense`,
          html: `
            <p>Hello,</p>
            <p>You requested a password reset for your Quickspense account. Click the link below to set a new password. This link expires in 1 hour.</p>
            <p><a href="${resetUrl}">Reset your password</a></p>
            <p>If you did not request this, you can safely ignore this email.</p>
            <p>-- Quickspense</p>
          `,
        });

        logger.info("Password reset email sent", { userId: user.id });
      } catch (e) {
        // Log but don't leak the error to the client
        logger.error("Failed to send password reset email", {
          userId: user.id,
          error: e,
        });
      }
    } else {
      logger.info("Password reset requested for non-existent email");
    }

    return new Response(
      JSON.stringify({
        message: "If an account exists with that email, a reset link has been sent.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    locals.logger.error("Forgot password error", { error: e });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
