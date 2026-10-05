import { ActionError, defineAction, isActionError } from "astro:actions";
import { z } from "astro:schema";
import {
  ConflictError,
  createDb,
  DomainError,
  payInvoiceSchema,
  StripeConnectionOperationConflictError,
  stripeConnections,
  type PayInvoiceInput,
} from "@quickspense/domain";
import { payInvoice } from "@/lib/invoiceCheckout";
import { voidInvoice } from "@/lib/invoiceVoid";
import { createStripeClient, createStripeOAuthClient } from "@/lib/stripe";
import {
  classifyStripeConnectError,
  classifyStripeDeauthorizationError,
  createAuthorizedAccountObservation,
  deriveStripeLivemode,
  getStripeDeauthorizationRecovery,
  retrieveStripeAccountObservation,
} from "@/lib/stripeConnect";

function toActionError(error: unknown): ActionError {
  if (isActionError(error)) return error;
  if (error instanceof ConflictError) {
    return new ActionError({ code: "CONFLICT", message: error.message });
  }
  return new ActionError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Something went wrong. Please try again.",
  });
}

export const server = {
  invoice: {
    void: defineAction({
      accept: "json",
      input: z.object({ id: z.string().uuid() }).strict(),
      handler: async ({ id }, { locals }) => {
        if (!locals.user) throw new ActionError({ code: "UNAUTHORIZED", message: "You must be logged in." });
        try {
          const invoice = await voidInvoice(createDb(locals.runtime.env.DB), id, locals.user.id, locals.runtime.env);
          return { status: invoice.status };
        } catch (error) {
          if (error instanceof DomainError && error.statusCode === 404) throw new ActionError({ code: "NOT_FOUND", message: "Invoice not found." });
          if (error instanceof ConflictError) throw new ActionError({ code: "CONFLICT", message: error.message });
          locals.logger.error("Invoice void confirmation failed");
          throw new ActionError({ code: "SERVICE_UNAVAILABLE", message: "Stripe void confirmation is pending. Please retry shortly." });
        }
      },
    }),
    pay: defineAction({
      accept: "json",
      input: z.custom<PayInvoiceInput>((input) => payInvoiceSchema.safeParse(input).success, "Invalid invoice payment link"),
      handler: async (input, { locals }) => {
        try {
          return await payInvoice(createDb(locals.runtime.env.DB), input, locals.runtime.env);
        } catch (error) {
          if (error instanceof DomainError && error.statusCode === 404) {
            throw new ActionError({ code: "NOT_FOUND", message: "Invoice not found." });
          }
          if (error instanceof ConflictError) {
            throw new ActionError({ code: "CONFLICT", message: error.message });
          }
          locals.logger.error("Invoice payment confirmation failed");
          throw new ActionError({
            code: "SERVICE_UNAVAILABLE",
            message: "Payment confirmation is temporarily unavailable. Please try again shortly.",
          });
        }
      },
    }),
  },
  stripe: {
    refreshStatus: defineAction({
      input: z.object({ connectionId: z.string().uuid() }).strict(),
      handler: async ({ connectionId }, { locals }) => {
        if (!locals.user) {
          throw new ActionError({ code: "UNAUTHORIZED", message: "You must be logged in." });
        }
        const env = locals.runtime.env;
        const db = createDb(env.DB);
        const changed = () => new ActionError({
          code: "CONFLICT", message: "Stripe connection changed. Reload Settings and try again.",
        });
        try {
          if (!env.STRIPE_SECRET_KEY) {
            throw new ActionError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe Connect is not configured correctly." });
          }
          const stripe = createStripeClient(env);
          const livemode = deriveStripeLivemode(env.STRIPE_SECRET_KEY);
          const connection = await stripeConnections.getConnectionById(db, connectionId);
          if (!connection || connection.user_id !== locals.user.id || connection.disconnected_at !== null
            || connection.disconnect_operation_id !== null || connection.disconnect_started_at !== null) {
            throw changed();
          }
          if (connection.livemode !== livemode) {
            throw new ActionError({ code: "CONFLICT", message: "The connected Stripe account mode does not match." });
          }
          const { account, observedAt } = await retrieveStripeAccountObservation(
            () => stripe.accounts.retrieve(connection.stripe_account_id), connection.stripe_account_id, livemode,
          );
          const observation = await stripeConnections.updateAccountStatus(db, {
            ...account, observedAt, expectedAuthorizationRevision: connection.authorization_revision,
          });
          const current = await stripeConnections.getConnectionById(db, connectionId);
          if (observation.outcome !== "applied" || !current || current.user_id !== locals.user.id
            || current.stripe_account_id !== connection.stripe_account_id || current.livemode !== livemode
            || current.authorization_revision !== connection.authorization_revision
            || current.disconnected_at !== null || current.disconnect_operation_id !== null
            || current.disconnect_started_at !== null) {
            throw changed();
          }
          return { refreshed: true };
        } catch (error) {
          if (isActionError(error)) throw error;
          const category = classifyStripeConnectError(error);
          locals.logger.error("Stripe status refresh failed", { category });
          throw new ActionError({
            code: category === "configuration" ? "INTERNAL_SERVER_ERROR" : "SERVICE_UNAVAILABLE",
            message: category === "configuration" ? "Stripe Connect is not configured correctly."
              : "Stripe status could not be refreshed. Please try again.",
          });
        }
      },
    }),
    resolveUnconfirmedAuthorization: defineAction({
      input: z.object({ confirmedRevoked: z.literal(true) }).strict(),
      handler: async (_, context) => {
        const user = context.locals.user;
        if (!user) {
          throw new ActionError({
            code: "UNAUTHORIZED",
            message: "You must be logged in.",
          });
        }

        throw new ActionError({ code: "CONFLICT", message: "Stripe/support verification is needed. This authorization remains blocked." });
      },
    }),
    recoverConnection: defineAction({
      input: z.object({}).strict(),
      handler: async (_, context) => {
        const user = context.locals.user;
        if (!user) {
          throw new ActionError({
            code: "UNAUTHORIZED",
            message: "You must be logged in.",
          });
        }

        const env = context.locals.runtime.env;
        const db = createDb(env.DB);

        try {
          const operation =
            await stripeConnections.getCurrentAuthorizedOperation(db, user.id);
          if (!operation) {
            throw new ActionError({
              code: "CONFLICT",
              message: "No Stripe connection recovery is pending.",
            });
          }
          if (
            operation.phase !== "authorized" ||
            !operation.stripeAccountId
          ) {
            throw new ActionError({
              code: "CONFLICT",
              message:
                 "Stripe/support verification is needed. This authorization remains blocked.",
            });
          }
          if (!env.STRIPE_SECRET_KEY) {
            throw new ActionError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Stripe Connect is not configured correctly.",
            });
          }

          const livemode = deriveStripeLivemode(env.STRIPE_SECRET_KEY);
          if (livemode !== operation.livemode) {
            throw new ActionError({
              code: "CONFLICT",
              message:
                "Restore Stripe configuration to the account's recorded mode, then try again.",
            });
          }

          const completeOwnerConflict = async () => {
            const finished =
              await stripeConnections.completeAuthorizedConnectionConflict(
                db,
                {
                  userId: user.id,
                  operationId: operation.operationId,
                },
              );
            if (!finished) {
              throw new ActionError({
                code: "CONFLICT",
                message: "Stripe connection recovery changed. Refresh and try again.",
              });
            }
            throw new ActionError({
              code: "CONFLICT",
              message: "That Stripe account is already connected to another user.",
            });
          };

          const resolveExtraAuthorization = async () => {
            const owner = await stripeConnections.getConnectionByAccountId(
              db,
              operation.stripeAccountId!,
            );
            if (owner && owner.user_id !== user.id) {
              return completeOwnerConflict();
            }
            if (!env.STRIPE_CONNECT_CLIENT_ID) {
              throw new ActionError({
                code: "INTERNAL_SERVER_ERROR",
                message: "Stripe Connect is not configured correctly.",
              });
            }

            const stripe = createStripeOAuthClient(env);
            let deauthorizationConfirmed = false;
            let outcome = "succeeded";
            try {
              const revoked = await stripe.oauth.deauthorize({
                client_id: env.STRIPE_CONNECT_CLIENT_ID,
                stripe_user_id: operation.stripeAccountId!,
              });
              deauthorizationConfirmed = revoked.stripe_user_id === operation.stripeAccountId;
            } catch (error) {
              outcome = classifyStripeDeauthorizationError(error);
              deauthorizationConfirmed = outcome === "already_disconnected";
            }

            if (!deauthorizationConfirmed) {
              context.locals.logger.error(
                "Extra Stripe authorization cleanup was not confirmed",
                { outcome },
              );
              throw new ActionError({
                code: "SERVICE_UNAVAILABLE",
                message:
                  outcome === "ambiguous"
                    ? "Stripe is still confirming authorization cleanup. Retry resolution in Settings."
                    : "Stripe authorization cleanup was rejected. Check Stripe configuration and try again.",
              });
            }

            const completed =
              await stripeConnections.completeDeauthorizedConnectOperation(
                db,
                {
                  userId: user.id,
                  operationId: operation.operationId,
                  stripeAccountId: operation.stripeAccountId!,
                },
              );
            if (!completed) {
              const current =
                await stripeConnections.getCurrentAuthorizedOperation(
                  db,
                  user.id,
                );
              if (current) {
                throw new ActionError({
                  code: "SERVICE_UNAVAILABLE",
                  message:
                    "Stripe removed the extra authorization, but local confirmation is pending. Retry resolution in Settings.",
                });
              }
            }

            return { recovered: true };
          };

          const activeConnection =
            await stripeConnections.getActiveConnection(db, user.id);
          if (
            activeConnection &&
            activeConnection.stripe_account_id !== operation.stripeAccountId
          ) {
            return resolveExtraAuthorization();
          }

          let persisted: Awaited<
            ReturnType<typeof stripeConnections.persistAuthorizedConnection>
          >;
          try {
            persisted = await stripeConnections.persistAuthorizedConnection(db, {
              userId: user.id,
              operationId: operation.operationId,
              livemode: operation.livemode,
            });
          } catch (error) {
            if (
              error instanceof StripeConnectionOperationConflictError &&
              error.reason === "active_connection"
            ) {
              return resolveExtraAuthorization();
            }
            throw error;
          }
          if (persisted.outcome === "owner_conflict") {
            return completeOwnerConflict();
          }

          const stripe = createStripeClient(env);
          const { account, observedAt } =
            await retrieveStripeAccountObservation(
              () => stripe.accounts.retrieve(operation.stripeAccountId!),
              operation.stripeAccountId,
              operation.livemode,
            );
          const observation =
            await stripeConnections.updateAuthorizedAccountStatus(
              db,
              createAuthorizedAccountObservation(
                {
                  ...account,
                  userId: user.id,
                  operationId: operation.operationId,
                  expectedAuthorizationRevision:
                    persisted.connection.authorization_revision,
                },
                observedAt,
              ),
            );
          if (observation.outcome !== "applied") {
            throw new ActionError({
              code: "CONFLICT",
              message: "Stripe connection recovery changed. Refresh and try again.",
            });
          }

          const visible = await stripeConnections.getCurrentUiConnection(
            db,
            user.id,
          );
          if (
            !visible ||
            visible.id !== persisted.connection.id ||
            visible.authorization_revision !==
              persisted.connection.authorization_revision ||
            visible.disconnected_at !== null
          ) {
            throw new ActionError({
              code: "CONFLICT",
              message: "Stripe connection recovery changed. Refresh and try again.",
            });
          }

          const completed =
            await stripeConnections.completeAuthorizedConnection(
              db,
              {
                userId: user.id,
                operationId: operation.operationId,
                connectionId: persisted.connection.id,
                expectedAuthorizationRevision:
                  persisted.connection.authorization_revision,
              },
              observedAt,
            );
          if (!completed) {
            const currentOperation =
              await stripeConnections.getCurrentAuthorizedOperation(
                db,
                user.id,
              );
            if (currentOperation) {
              throw new ActionError({
                code: "CONFLICT",
                message: "Stripe connection recovery changed. Refresh and try again.",
              });
            }
          }

          return { recovered: true };
        } catch (error) {
          if (isActionError(error)) throw error;
          if (error instanceof ConflictError) {
            throw new ActionError({
              code: "CONFLICT",
              message:
                error.message === "Stripe account mode changed"
                  ? "Restore Stripe configuration to the account's recorded mode, then try again."
                  : "Stripe connection recovery changed. Refresh and try again.",
            });
          }

          const category = classifyStripeConnectError(error);
          context.locals.logger.error("Stripe connection recovery failed", {
            category,
          });
          if (category === "configuration") {
            throw new ActionError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Stripe Connect is not configured correctly.",
            });
          }
          if (category === "account_invalid") {
            throw new ActionError({
              code: "BAD_REQUEST",
              message: "Stripe returned an account that could not be connected.",
            });
          }
          throw new ActionError({
            code: "SERVICE_UNAVAILABLE",
            message:
              "Stripe connection recovery is temporarily unavailable. Please try again.",
          });
        }
      },
    }),
    disconnect: defineAction({
      input: z.object({ connectionId: z.string().uuid() }).strict(),
      handler: async ({ connectionId }, context) => {
        const user = context.locals.user;
        if (!user) {
          throw new ActionError({
            code: "UNAUTHORIZED",
            message: "You must be logged in.",
          });
        }

        const env = context.locals.runtime.env;
        if (!env.STRIPE_CONNECT_CLIENT_ID || !env.STRIPE_SECRET_KEY) {
          throw new ActionError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Stripe Connect is not configured.",
          });
        }

        const db = createDb(env.DB);
        let connection: Awaited<
          ReturnType<typeof stripeConnections.disconnectAccount>
        >;
        let stripe: ReturnType<typeof createStripeOAuthClient>;
        let livemode: boolean;

        try {
          stripe = createStripeOAuthClient(env);
          livemode = deriveStripeLivemode(env.STRIPE_SECRET_KEY);
          connection = await stripeConnections.disconnectAccount(
            db,
            connectionId,
            user.id,
          );
        } catch (error) {
          throw toActionError(error);
        }

        const disconnectOperationId = connection.disconnect_operation_id;
        if (!disconnectOperationId) {
          context.locals.logger.error(
            "Stripe disconnect reservation has no operation ID",
          );
          throw new ActionError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Stripe could not be disconnected. Please try again.",
          });
        }

        const reservation = {
          connectionId: connection.id,
          userId: user.id,
          disconnectOperationId,
          expectedAuthorizationRevision: connection.authorization_revision,
        };

        let attempt: Awaited<
          ReturnType<typeof stripeConnections.claimDisconnectAttempt>
        >;
        try {
          attempt = await stripeConnections.claimDisconnectAttempt(
            db,
            reservation,
          );
          connection = attempt.connection;
        } catch (error) {
          throw toActionError(error);
        }

        const operation = { ...reservation, attemptId: attempt.attemptId };

        const restoreReservation = async () => {
          try {
            return await stripeConnections.restoreDisconnectedAccount(
              db,
              operation,
            );
          } catch {
            return false;
          }
        };

        const finalizeReservation = async () => {
          try {
            const finalized = await stripeConnections.finalizeDisconnectedAccount(
              db,
              operation,
            );
            if (finalized) return true;

            const current = await stripeConnections.getConnectionById(
              db,
              connection.id,
            );
            return Boolean(
              current &&
                current.user_id === user.id &&
                current.authorization_revision ===
                  connection.authorization_revision &&
                current.disconnected_at !== null &&
                current.disconnect_operation_id === null,
            );
          } catch {
            return false;
          }
        };

        if (connection.livemode !== livemode) {
          const restored = await restoreReservation();
          context.locals.logger.error("Stripe connection mode mismatch", {
            restored,
          });
          throw new ActionError({
            code: "CONFLICT",
            message: "The connected Stripe account mode does not match.",
          });
        }

        try {
          const revoked = await stripe.oauth.deauthorize({
            client_id: env.STRIPE_CONNECT_CLIENT_ID,
            stripe_user_id: connection.stripe_account_id,
          });
          if (revoked.stripe_user_id !== connection.stripe_account_id) {
            throw new ConflictError("Stripe deauthorization could not be confirmed.");
          }
        } catch (error) {
          const outcome = classifyStripeDeauthorizationError(error);
          const recovery = getStripeDeauthorizationRecovery(outcome);

          if (recovery === "finalize") {
            const finalized = await finalizeReservation();
            if (!finalized) {
              context.locals.logger.error(
                "Stripe disconnect could not be finalized after prior deauthorization",
              );
              throw new ActionError({
                code: "SERVICE_UNAVAILABLE",
                message:
                  "Stripe disconnected the account, but confirmation is pending.",
              });
            }
            return { disconnected: true };
          }

          let restored = false;
          if (recovery === "restore") {
            try {
              const observation = await retrieveStripeAccountObservation(
                () => createStripeClient(env).accounts.retrieve(connection.stripe_account_id),
                connection.stripe_account_id, connection.livemode,
              );
              restored = await stripeConnections.restoreDisconnectedAccount(db, { ...operation, observation });
            } catch {
              // Permission/authentication/network errors are not proof of current authorization.
            }
          }
          let attemptReleased = false;
          if (!restored) {
            try { attemptReleased = await stripeConnections.releaseDisconnectAttempt(db, operation); } catch { /* The lease will expire. */ }
          }
          context.locals.logger.error("Stripe account deauthorization failed", {
            outcome,
            restored,
            attemptReleased,
          });
          throw new ActionError({
            code: "SERVICE_UNAVAILABLE",
            message:
              outcome === "ambiguous"
                ? "Stripe is still confirming the disconnect. Use Retry disconnect in Settings."
                : "Stripe could not be disconnected. Please check the connection and try again.",
          });
        }

        const finalized = await finalizeReservation();
        if (!finalized) {
          context.locals.logger.error(
            "Stripe disconnect succeeded but could not be finalized",
          );
          throw new ActionError({
            code: "SERVICE_UNAVAILABLE",
            message: "Stripe disconnected the account, but confirmation is pending.",
          });
        }

        return { disconnected: true };
      },
    }),
  },
};
