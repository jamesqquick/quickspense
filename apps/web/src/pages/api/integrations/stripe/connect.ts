import type { APIRoute } from "astro";
import {
  createDb,
  StripeConnectionOperationConflictError,
  stripeConnections,
} from "@quickspense/domain";
import { createStripeClient } from "@/lib/stripe";
import {
  buildStripeAuthorizeUrl,
  classifyStripeConnectError,
  deriveStripeLivemode,
  generateStripeConnectState,
  getStripeConnectRedirectUri,
} from "@/lib/stripeConnect";

function redirectToSettings(requestUrl: string, result: string): Response {
  return Response.redirect(new URL(`/settings?stripe=${result}`, requestUrl), 303);
}

export const GET: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return new Response("Unauthorized", { status: 401 });

  const env = locals.runtime.env;
  if (
    !env.APP_URL ||
    !env.STRIPE_SECRET_KEY ||
    !env.STRIPE_CONNECT_CLIENT_ID
  ) {
    return redirectToSettings(request.url, "configuration");
  }

  try {
    createStripeClient(env);
    const livemode = deriveStripeLivemode(env.STRIPE_SECRET_KEY);
    const redirectUri = getStripeConnectRedirectUri(env.APP_URL, livemode);
    const state = generateStripeConnectState();
    const authorizeUrl = buildStripeAuthorizeUrl({
      clientId: env.STRIPE_CONNECT_CLIENT_ID,
      redirectUri,
      state,
      email: user.email,
    });
    const db = createDb(env.DB);

    await stripeConnections.createOAuthState(db, {
      userId: user.id,
      state,
      livemode,
    });

    return Response.redirect(authorizeUrl, 302);
  } catch (error) {
    if (error instanceof StripeConnectionOperationConflictError) {
      const result =
        error.reason === "active_connection"
          ? "already_connected"
          : error.reason === "pending_disconnect"
            ? "disconnect_pending"
            : "operation_in_progress";
      return redirectToSettings(request.url, result);
    }

    const category = classifyStripeConnectError(error);
    locals.logger.error("Stripe Connect authorization could not start", {
      category,
    });
    return redirectToSettings(request.url, category);
  }
};
