import type {ConnectStatus} from "../domain/types";
import type {StripeAccount} from "../payments/stripe";

export function connectStatusFromAccount(account: Pick<StripeAccount, "payouts_enabled" | "details_submitted" | "charges_enabled"> | null | undefined): ConnectStatus {
  if (!account) return "not_connected";
  if (account.payouts_enabled) return "payouts_enabled";
  return "pending";
}

export function connectStatusLabel(status: ConnectStatus): string {
  if (status === "payouts_enabled") return "Payouts enabled";
  if (status === "pending") return "Pending";
  return "Not connected";
}

export function isPayoutsEnabled(status: ConnectStatus): boolean {
  return status === "payouts_enabled";
}
