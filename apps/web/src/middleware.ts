import { defineMiddleware } from "astro:middleware";
import { createAuth, createDb, createLogger, newRequestId } from "@quickspense/domain";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/pay",
  "/api/auth",
  "/api/invoices/public",
  "/api/webhooks/stripe",
];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Static assets are served by the asset binding, skip auth + logging
  if (pathname.startsWith("/_astro/") || pathname === "/favicon.ico") {
    return next();
  }

  // Set up per-request logger. User context is attached once we identify the user.
  const requestId = newRequestId();
  context.locals.requestId = requestId;
  context.locals.logger = createLogger({
    service: "web",
    requestId,
    path: pathname,
    method: context.request.method,
  });

  const env = context.locals.runtime.env;
  const db = createDb(env.DB);
  const auth = createAuth(db, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
  });

  // Validate session via Better Auth
  try {
    const session = await auth.api.getSession({
      headers: context.request.headers,
    });

    if (session) {
      context.locals.user = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
      };
      context.locals.session = {
        id: session.session.id,
        token: session.session.token,
        expiresAt: session.session.expiresAt,
      };
      context.locals.logger = context.locals.logger.child({
        userId: session.user.id,
      });
    }
  } catch (e) {
    context.locals.logger.error("Session validation error", { error: e });
  }

  // Protect non-public routes
  if (
    !context.locals.user &&
    !PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
  ) {
    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return context.redirect("/login");
  }

  return next();
});
