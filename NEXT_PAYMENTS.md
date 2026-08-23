# Next PR: Stripe Billing and Connect

This release stops pretending a Visa is on file. Profile billing reads `PaymentsPort.getDefaultPaymentMethod()`, which currently returns `null`.

## Already in the tree

- `domain/types.ts` — `PaymentMethod`, `PaymentsPort`
- `domain/payments.ts` — null implementation + placeholder copy
- Profile UI — “No payment method on file” / “Stripe Billing is not connected yet”

Do **not** treat wallet contributions as Salu revenue. Credits are customer liabilities; Salu revenue is marketplace commission (`PlatformCommission`).

## Following PR should add

1. **Stripe Billing** for Gold ($200/mo) and Platinum ($500/mo) Credit funding.
2. **Stripe Checkout / Payment Element** for one-time Credit top-ups.
3. **Stripe Connect** for provider payouts, keeping gross member spend, commission, and net payout separate (`ProviderPayout`).
4. Webhooks: `invoice.paid`, `customer.subscription.updated`, `account.updated`.
5. Persist `stripeCustomerId` / `stripeSubscriptionId` on the member row (D1), not in localStorage.

## Suggested env keys (do not add until that PR)

```text
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_GOLD_PRICE_ID=
STRIPE_PLATINUM_PRICE_ID=
STRIPE_CONNECT_CLIENT_ID=
```

Create the Stripe account and products when you are ready to take live cards — not required for this auth PR.
