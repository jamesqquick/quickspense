import { defineMiddleware } from "astro:middleware";
import { auth, createDb, createLogger, newRequestId } from "@quickspense/domain";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
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

  // Parse session cookie
  const sessionId = context.cookies.get("session")?.value;
  if (sessionId) {
    try {
      const db = createDb(context.locals.runtime.env.DB);
      const result = await auth.validateSession(db, sessionId);
      if (result) {
        context.locals.user = { id: result.user.id, email: result.user.email };
        // Attach userId to the logger for all downstream logs
        context.locals.logger = context.locals.logger.child({ userId: result.user.id });
      } else {
        context.cookies.delete("session", { path: "/" });
      }
    } catch (e) {
      context.locals.logger.error("Session validation error", { error: e });
      context.cookies.delete("session", { path: "/" });
    }
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
