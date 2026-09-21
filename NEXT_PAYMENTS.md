# Payments follow-ups

Membership Billing, Credit top-ups, and **Stripe Connect Express** are in the tree.

- Billing + Credits: **[STRIPE.md](./STRIPE.md)**
- Provider direct deposit: **[CONNECT.md](./CONNECT.md)**

Do **not** treat wallet contributions as Salu revenue. Credits are customer liabilities; Salu revenue is marketplace commission (`PlatformCommission`). Provider money movement is a Connect **transfer** of the net payout, not a destination charge.

## Already in the tree

- Stripe Checkout for Gold ($200/mo) and Platinum ($500/mo)
- Stripe Checkout for one-time Credit top-ups (100 / 200 / 500)
- Webhooks: Billing events plus `account.updated`, `transfer.created`, `transfer.updated`, `transfer.reversed`
- D1 `wallets`, `credit_transactions`, `stripe_events`, `provider_applications`, `provider_accounts`, `providers`, `provider_payouts`
- Provider applications on D1 (`PROVIDERS.md`) — BD pipeline
- Provider request queue and calendar (`PROVIDER.md`)
- Express onboarding from the signed-in provider home → **Set up payouts**
- Transfers on `POST /api/bookings/complete` when `payouts_enabled`
- Profile billing reads `/api/payments/me` (card last4 when Stripe has one)
- Demo fallback when `STRIPE_SECRET_KEY` is missing
- Admin payments setup section (`/admin` → "One paste from Daniel"): shows exactly which Stripe keys are missing, where Daniel finds each value, and a single copy-paste block. `GET /api/payments/config` is admin-gated and returns presence booleans only, never values.

## Still later

1. Full tax / 1099 ops beyond what Connect Express already collects.
2. Package entitlement tables (package redemptions already settle at catalog price).
3. Atlas LLM, Cloudflare DNS cutover, live credential verification.

## Health/Strava note (Sep 21, 2026)

- Strava OAuth `state` is now persisted in D1 (`strava_oauth_states`, migration
  `drizzle/0011_strava_oauth_state.sql`). Previously it lived in a per-isolate
  in-memory Map, so the authorize → callback round trip broke in production
  when the callback landed on a different Workers isolate.
- Behavior: single-use states, 10-minute TTL enforced on consume, expired rows
  pruned on write. Unknown/expired/consumed states fail the callback with a
  clean 400 (redirect to `/apps?health=error&reason=exchange_failed`).
- Apply `0011_strava_oauth_state.sql` to prod D1 manually (same as 0007–0010).
  `db/health.ts` `ensureHealthSchema()` also creates the table at runtime.
- Still Daniel's: Strava API app credentials (`STRAVA_CLIENT_ID`,
  `STRAVA_CLIENT_SECRET` from strava.com/settings/api).
