# Next PR: Stripe Connect (provider payouts)

Membership Billing and Credit top-ups are in this release. See **[STRIPE.md](./STRIPE.md)** for Dashboard products, the `joinsalu.com` webhook, and the `STRIPE_*` secrets.

This file is only the **Connect** follow-up. Do **not** treat wallet contributions as Salu revenue. Credits are customer liabilities; Salu revenue is marketplace commission (`PlatformCommission`).

## Already in the tree

- Stripe Checkout for Gold ($200/mo) and Platinum ($500/mo)
- Stripe Checkout for one-time Credit top-ups (100 / 200 / 500)
- Webhooks: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`
- D1 `wallets`, `credit_transactions`, `stripe_events` plus `members.stripe_customer_id` / `stripe_subscription_id`
- Member booking create / list / reschedule / cancel on D1 (`BOOKINGS.md`) — Credit spend/refund stays on the wallet ledger
- Provider applications on D1 (`PROVIDERS.md`) — BD pipeline only; not Connect onboarding
- Profile billing reads `/api/payments/me` (card last4 when Stripe has one)
- Demo fallback when `STRIPE_SECRET_KEY` is missing

## Following PR should add

1. **Stripe Connect** for provider payouts, keeping gross member spend, commission, and net payout separate (`ProviderPayout`).
2. Webhooks: `account.updated`, plus transfer/payout events.
3. `STRIPE_CONNECT_CLIENT_ID` and connected-account onboarding for approved providers.
4. Attach a `PlatformCommission` when a persisted booking completes (bookings themselves are in `BOOKINGS.md`).

## Suggested env keys (do not add until that PR)

```text
STRIPE_CONNECT_CLIENT_ID=
```

Create connected accounts when you are ready to pay providers — not required for membership or Credit funding.
