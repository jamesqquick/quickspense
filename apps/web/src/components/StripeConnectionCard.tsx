import { useState } from "react";
import { actions } from "astro:actions";
import type { StripeConnectionStatus } from "@quickspense/domain";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type StripeConnectionView = Pick<
  StripeConnectionStatus,
  | "id"
  | "livemode"
  | "charges_enabled"
  | "payouts_enabled"
  | "details_submitted"
  | "requirements"
  | "stripe_status_at"
  | "disconnect_pending"
  | "mode_matches"
  | "ready"
> & {
  stripe_account_suffix: string;
};

type StripeConnectionCardProps = {
  connectConfigured: boolean;
  disconnectConfigured: boolean;
  refreshConfigured: boolean;
  connection: StripeConnectionView | null;
  recoveryState: "authorized" | "unconfirmed" | null;
};

function StatusDot({ enabled }: { enabled: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`size-2 rounded-full ${enabled ? "bg-emerald-400" : "bg-slate-600"}`}
    />
  );
}

function CapabilityStatus({
  enabled,
  label,
}: {
  enabled: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <StatusDot enabled={enabled} />
      <span>
        {label}: {enabled ? "Enabled" : "Not enabled"}
      </span>
    </div>
  );
}

function requirementLabel(requirement: string): string {
  if (requirement === "individual.verification.document") return "Identity verification document";
  return requirement.replace(/[_.]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export function StripeConnectionCard({
  connectConfigured,
  disconnectConfigured,
  refreshConfigured,
  connection,
  recoveryState,
}: StripeConnectionCardProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = disconnecting || recovering || refreshing;
  const requirements = connection?.requirements;
  const dueRequirements = [...new Set([...(requirements?.currently_due ?? []), ...(requirements?.past_due ?? [])])];
  const recoveryAvailable = recoveryState !== null;
  const recoveryCanRetry = recoveryState === "authorized";
  const stateLabel = !connection
    ? recoveryAvailable
      ? "Action required"
      : "Not connected"
    : connection.ready
      ? connection.livemode ? "Ready" : "Ready for sandbox"
      : "Action required";
  const stateClasses = !connection
    ? recoveryAvailable
      ? "bg-amber-500/15 text-amber-300"
      : "bg-white/10 text-slate-300"
    : connection.ready
      ? "bg-emerald-500/15 text-emerald-300"
      : "bg-amber-500/15 text-amber-300";

  const disconnect = async () => {
    if (!connection) return;
    if (
      !connection.disconnect_pending &&
      !confirm("Disconnect this Stripe account?")
    ) {
      return;
    }

    setDisconnecting(true);
    try {
      const result = await actions.stripe.disconnect({ connectionId: connection.id });
      if (result.error) {
        toast.error(result.error.message);
        return;
      }
      window.location.assign("/settings?stripe=disconnected");
    } catch {
      toast.error("Stripe disconnect confirmation is pending. Please retry shortly.");
    } finally {
      setDisconnecting(false);
    }
  };

  const recoverConnection = async () => {
    setRecovering(true);
    try {
      const result = await actions.stripe.recoverConnection({});
      if (result.error) {
        toast.error(result.error.message);
        return;
      }
      window.location.assign("/settings?stripe=recovered");
    } catch {
      toast.error("Stripe connection recovery is pending. Please retry shortly.");
    } finally {
      setRecovering(false);
    }
  };

  const refreshStatus = async () => {
    if (!connection) return;
    setRefreshing(true);
    try {
      const result = await actions.stripe.refreshStatus({ connectionId: connection.id });
      if (result.error) {
        toast.error(result.error.message);
        return;
      }
      window.location.assign("/settings?stripe=refreshed");
    } catch {
      toast.error("Stripe status could not be refreshed. Please try again.");
    } finally {
      setRefreshing(false);
    }
  };

  const unconfirmedRecovery = (
    <div className="space-y-3 text-sm">
      <p className="text-slate-300">
        Stripe authorization could not be confirmed. Stripe/support verification
        is needed to identify the account and verify its authorization. Connection
        changes and account deletion remain blocked until verification is complete.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <a
            href="https://dashboard.stripe.com/settings/applications"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Stripe Dashboard
            <ExternalLink aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </Button>
      </div>
    </div>
  );

  return (
    <Card className="overflow-hidden border border-white/10">
      <CardHeader className="flex flex-row items-start gap-4 border-b border-white/10 pb-5">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#635bff] text-xl font-bold text-white shadow-lg shadow-[#635bff]/20">
          S
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Stripe</CardTitle>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateClasses}`}
            >
              {stateLabel}
            </span>
          </div>
          <CardDescription className="mt-1">
            Accept card payments on invoices through your own Stripe account.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {!connection && recoveryState === "unconfirmed" ? (
          unconfirmedRecovery
        ) : !connection ? (
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <p className="max-w-md text-sm text-slate-400">
              {recoveryAvailable
                ? recoveryCanRetry
                  ? "Stripe authorized this account, but Quickspense still needs to finish the connection."
                  : "Stripe authorization could not be confirmed and must be retried or resolved before continuing."
                : "Connect Stripe to add secure online payment links to your invoices."}
            </p>
            {recoveryCanRetry ? (
              <Button
                type="button"
                disabled={busy}
                onClick={recoverConnection}
              >
                {recovering ? "Retrying..." : "Retry Stripe connection"}
              </Button>
            ) : connectConfigured ? (
              <Button asChild>
                <a href="/api/integrations/stripe/connect">Connect Stripe</a>
              </Button>
            ) : (
              <Button disabled>Stripe unavailable</Button>
            )}
          </div>
        ) : (
          <>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-xl bg-white/[0.04] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Account
                </p>
                <p className="mt-1 font-mono text-slate-200">
                  Stripe account •••• {connection.stripe_account_suffix}
                </p>
              </div>
              <div className="rounded-xl bg-white/[0.04] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Mode
                </p>
                <p className="mt-1 text-slate-200">
                  {connection.livemode ? "Live payments" : "Sandbox payments"}
                </p>
              </div>
            </div>

            <div className="grid gap-2 text-sm text-slate-300 sm:grid-cols-3">
              <CapabilityStatus
                enabled={connection.details_submitted}
                label="Details submitted"
              />
              <CapabilityStatus
                enabled={connection.charges_enabled}
                label="Charges"
              />
              <CapabilityStatus
                enabled={connection.payouts_enabled}
                label="Payouts"
              />
            </div>

            {!connection.mode_matches ? (
              <p className="text-sm text-amber-200">
                This account&apos;s payment mode does not match Quickspense&apos;s Stripe configuration.
              </p>
            ) : !connection.disconnect_pending && (
              <p className="text-sm text-slate-300">
                {connection.livemode
                  ? connection.ready
                    ? "Your Stripe account is ready to accept live invoice payments."
                    : "Live invoice payments require details submitted, charges enabled, and payouts enabled."
                  : "Sandbox payments can be attempted even when these flags are disabled. Stripe checks each test payment."}
              </p>
            )}

            <div className="space-y-2 text-sm">
              <h3 className="font-medium text-slate-200">Stripe requirements</h3>
              {!requirements ? (
                <p className="text-slate-400">Refresh Stripe status to load the account&apos;s requirements.</p>
              ) : (
                <>
                  {dueRequirements.length > 0 ? (
                    <ul className="space-y-1 text-slate-300">
                      {dueRequirements.map((requirement) => (
                        <li key={requirement}>
                          {requirementLabel(requirement)}
                          <span className="ml-2 text-xs text-amber-200">
                            {requirements.past_due.includes(requirement) ? "Past due" : "Required"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-slate-400">Stripe reports no information currently due.</p>
                  )}
                  {requirements.pending_verification.map((requirement) => (
                    <p key={requirement} className="text-slate-400">{requirementLabel(requirement)}: pending Stripe review.</p>
                  ))}
                  {requirements.errors.map((error, index) => (
                    <p key={`${error.requirement}:${error.code}:${index}`} className="text-amber-200">
                      {requirementLabel(error.requirement)}: {error.code === "verification_failed_keyed_identity"
                        ? "Stripe could not verify the identity details. Check the verification information in Stripe."
                        : `Stripe reported ${error.code.replace(/_/g, " ")}.`}
                    </p>
                  ))}
                  {requirements.disabled_reason && (
                    <p className="text-slate-400">Stripe restriction: {requirements.disabled_reason.replace(/[_.]/g, " ")}.</p>
                  )}
                </>
              )}
              {dueRequirements.length > 0 && (
                <p className="text-slate-400">
                  In Stripe Dashboard, select account •••• {connection.stripe_account_suffix} in {connection.livemode ? "live" : "sandbox"} mode
                  to review these requirements. If no task appears, contact Stripe support with the requirement shown above.
                </p>
              )}
              <p className="text-xs text-slate-500">
                Last checked: <time dateTime={connection.stripe_status_at}>{connection.stripe_status_at}</time>
              </p>
            </div>

            {connection.disconnect_pending && (
              <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-200">
                Disconnect pending. Stripe has not confirmed the request yet.
              </p>
            )}

            {recoveryAvailable && (
              <div className="flex flex-col items-start justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-200 sm:flex-row sm:items-center">
                {recoveryCanRetry ? (
                  <>
                    <p>
                      Resolve the separate pending Stripe authorization before
                      changing the active account.
                    </p>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={recoverConnection}
                    >
                      {recovering ? "Resolving..." : "Resolve authorization"}
                    </Button>
                  </>
                ) : (
                  unconfirmedRecovery
                )}
              </div>
            )}

            {!disconnectConfigured && (
              <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-200">
                Restore the Stripe client ID and the key for this account&apos;s
                recorded mode before disconnecting.
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5">
              <p className="text-xs text-slate-500">
                To use a different Stripe account, disconnect this one first.
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !refreshConfigured || !connection.mode_matches || connection.disconnect_pending}
                  onClick={refreshStatus}
                >
                  {refreshing ? "Refreshing..." : "Refresh Stripe status"}
                </Button>
                <Button asChild variant="outline">
                  <a
                    href="https://dashboard.stripe.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Manage Stripe account
                    <ExternalLink aria-hidden="true" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={
                    busy ||
                    !disconnectConfigured ||
                    !connection.mode_matches
                  }
                  onClick={disconnect}
                >
                  {connection.disconnect_pending
                    ? disconnecting
                      ? "Retrying..."
                      : "Retry disconnect"
                    : disconnecting
                      ? "Disconnecting..."
                      : disconnectConfigured
                        ? "Disconnect"
                        : "Disconnect unavailable"}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
