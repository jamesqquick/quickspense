import type { APIRoute } from "astro";
import {
  ConflictError,
  createDb,
  stripeConnections,
  type StripeConnectState,
} from "@quickspense/domain";
import { createStripeClient, createStripeOAuthClient } from "@/lib/stripe";
import {
  classifyStripeConnectError,
  createAuthorizedAccountObservation,
  deriveStripeLivemode,
  getStripeConnectRedirectUri,
  normalizeStripeOAuthToken,
  retrieveStripeAccountObservation,
} from "@/lib/stripeConnect";

function redirectToSettings(requestUrl: string, result: string): Response {
  return Response.redirect(new URL(`/settings?stripe=${result}`, requestUrl), 303);
}

function callbackResultForError(error: unknown): string {
  if (error instanceof ConflictError) return "conflict";

  const category = classifyStripeConnectError(error);
  return category === "unknown" ? "oauth_error" : category;
}

export const GET: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) {
    return Response.redirect(
      new URL("/login?toast=Please+log+in+to+connect+Stripe.", request.url),
      303,
    );
  }

  const env = locals.runtime.env;
  if (
    !env.APP_URL ||
    !env.STRIPE_SECRET_KEY ||
    !env.STRIPE_CONNECT_CLIENT_ID
  ) {
    return redirectToSettings(request.url, "configuration");
  }

  let livemode: boolean;
  let stripe: ReturnType<typeof createStripeClient>;
  let oauthStripe: ReturnType<typeof createStripeOAuthClient>;
  try {
    stripe = createStripeClient(env);
    oauthStripe = createStripeOAuthClient(env);
    livemode = deriveStripeLivemode(env.STRIPE_SECRET_KEY);
    getStripeConnectRedirectUri(env.APP_URL, livemode);
  } catch {
    return redirectToSettings(request.url, "configuration");
  }

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) return redirectToSettings(request.url, "invalid_state");

  const db = createDb(env.DB);
  let consumedState: StripeConnectState;
  try {
    consumedState = await stripeConnections.consumeOAuthState(db, {
      state,
      userId: user.id,
      livemode,
    });
  } catch {
    return redirectToSettings(request.url, "invalid_state");
  }

  try {
    const operation = await stripeConnections.getCurrentOperation(db, user.id);
    let stripeAccountId =
      operation?.id === consumedState.operation_id &&
      operation.kind === "connect" &&
      operation.phase === "authorized"
        ? operation.stripe_account_id
        : null;

    if (!stripeAccountId) {
      if (url.searchParams.has("error")) {
        await stripeConnections.completeOAuthState(db, {
          stateHash: consumedState.state_hash,
          userId: user.id,
          operationId: consumedState.operation_id!,
        });
        const result =
          url.searchParams.get("error") === "access_denied"
            ? "access_denied"
            : "oauth_error";
        return redirectToSettings(request.url, result);
      }

      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("scope") !== "read_write") {
        await stripeConnections.completeOAuthState(db, {
          stateHash: consumedState.state_hash,
          userId: user.id,
          operationId: consumedState.operation_id!,
        });
        return redirectToSettings(request.url, "oauth_invalid");
      }

      const oauthAccount = normalizeStripeOAuthToken(
        await oauthStripe.oauth.token({
          grant_type: "authorization_code",
          code,
        }),
        livemode,
      );
      stripeAccountId = oauthAccount.stripeAccountId;
      let recorded = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await stripeConnections.recordAuthorizedAccount(db, {
            userId: user.id,
            operationId: consumedState.operation_id!,
            stripeAccountId,
          });
          recorded = true;
          break;
        } catch {
          recorded = false;
        }
      }
      if (!recorded) {
        locals.logger.error(
          "Stripe authorization account ID could not be persisted",
        );
        return redirectToSettings(request.url, "authorization_unconfirmed");
      }
    }

    const persisted = await stripeConnections.persistAuthorizedConnection(
      db,
      {
        userId: user.id,
        operationId: consumedState.operation_id!,
        livemode,
      },
    );
    if (persisted.outcome === "owner_conflict") {
      const completed =
        await stripeConnections.completeAuthorizedConnectionConflict(db, {
          userId: user.id,
          operationId: consumedState.operation_id!,
        });
      if (!completed) {
        throw new ConflictError("Stripe account authorization changed");
      }
      return redirectToSettings(request.url, "conflict");
    }

    const { account, observedAt } = await retrieveStripeAccountObservation(
      () => stripe.accounts.retrieve(stripeAccountId),
      stripeAccountId,
      livemode,
    );
    const observation =
      await stripeConnections.updateAuthorizedAccountStatus(
        db,
        createAuthorizedAccountObservation(
          {
            ...account,
            userId: user.id,
            operationId: consumedState.operation_id!,
            expectedAuthorizationRevision:
              persisted.connection.authorization_revision,
          },
          observedAt,
        ),
      );
    if (observation.outcome !== "applied") {
      throw new ConflictError("Stripe account authorization changed");
    }

    const completed = await stripeConnections.completeAuthorizedConnection(
      db,
      {
        userId: user.id,
        operationId: consumedState.operation_id!,
        connectionId: persisted.connection.id,
        expectedAuthorizationRevision:
          persisted.connection.authorization_revision,
      },
      observedAt,
    );
    if (!completed) {
      throw new ConflictError("Stripe account authorization changed");
    }
    return redirectToSettings(request.url, "connected");
  } catch (error) {
    const result = callbackResultForError(error);
    locals.logger.error("Stripe Connect authorization failed", { result });
    return redirectToSettings(request.url, result);
  }
};
