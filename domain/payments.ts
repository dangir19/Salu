import type {ID, PaymentMethod, PaymentsPort} from "./types";

/**
 * Stripe Billing / Connect arrives in the following PR.
 * Member identity can already ask for a card on file; this port stays null
 * until those secrets and webhooks exist.
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
  note: "Cards and membership charges arrive in the next payments release. Nothing is charged from this screen.",
} as const;
