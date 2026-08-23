import type {ID, PaymentMethod, PaymentsPort} from "./types";

/**
 * Live Stripe Billing is server-side (`payments/` + `/api/payments/*`).
 * This port stays null in the browser until `/api/payments/me` returns a card.
 * Stripe Connect / provider payouts are a later PR.
 */
export const payments: PaymentsPort = {
  async getDefaultPaymentMethod(memberId: ID): Promise<PaymentMethod | null> {
    void memberId;
    return null;
  },
};

export const PAYMENT_PLACEHOLDER = {
  label: "No payment method on file",
  detail: "Stripe Billing is not connected yet",
  note: "Cards and membership charges arrive through Stripe once Daniel pastes the keys. Nothing is charged from this screen in demo mode.",
} as const;

export const STRIPE_BILLING_NOTE =
  "Cards are charged by Stripe. Wallet Credits are customer funds — not Salu revenue. Provider payouts (Connect) are a later release.";
