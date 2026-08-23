# Stripe Connect — provider payouts

Approved Salu providers receive **direct deposit** through **Stripe Connect Express**. Members still fund Credits on the platform (customer liabilities). When a booking is completed, Salu transfers only the **net provider payout**. The commission stays on the platform as revenue (`PlatformCommission`).

You do **not** need Connect to compile, lint, or test. Without `STRIPE_SECRET_KEY`, Provider → **Set up payouts** stays a labeled **demo**.

## Charge pattern (read this first)

Salu does **not** use destination charges.

| Pattern | Why it does or does not fit |
| --- | --- |
| **Separate charges and transfers** (this PR) | Members already pay into the Credit wallet via Checkout. That money is a **customer liability**, not a per-booking charge. On `completed` bookings, the platform creates a [Transfer](https://docs.stripe.com/api/transfers) to the Express account for `gross − commission`. |
| Destination charges | Would charge the member again at booking time and mix wallet funding with provider money movement. Breaks the liability vs commission split from Billing. |

1 Credit = $1. Transfer amounts are cents (`netPayout * 100`). Package redemptions with `credits_charged = 0` use the catalog standard price as GMV so the provider still gets paid.

## When Daniel must sign into Stripe

Same Test-mode account as [STRIPE.md](./STRIPE.md). Do this before a real provider can finish onboarding:

1. Dashboard → **Connect** → get started / enable Connect (Express).
2. Use **Test mode** until you are ready for live bank accounts.
3. Add Connect events to the existing webhook (below).
4. Optional: copy the Connect client id if you later want Standard OAuth. Express Account Links only need `STRIPE_SECRET_KEY`.

## Environment keys

| Key | Required for Express | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes | Same platform secret as Billing. Creates Express accounts, Account Links, and Transfers. |
| `STRIPE_WEBHOOK_SECRET` | Yes, to persist status | Same signing secret as Billing. |
| `STRIPE_CONNECT_CLIENT_ID` | No | `ca_…` from Connect settings. Reserved for Standard OAuth; unused by Express Account Links. |

Copy `.env.example` → `.env` or `.dev.vars`. Do not commit secrets.

## Dashboard setup

### 1. Enable Connect (Express)

Dashboard → **Connect**. Choose a platform / marketplace profile. Express connected accounts are the Salu default (hosted onboarding + Express Dashboard for the provider).

Brand the Express onboarding with the Salu name if you like. Not required for test mode.

### 2. Webhook events (same endpoint as Billing)

Dashboard → **Developers → Webhooks** → the `https://joinsalu.com/api/stripe/webhook` endpoint.

Add:

- `account.updated` — persist `not_connected` / `pending` / `payouts_enabled`
- `transfer.created`
- `transfer.updated`
- `transfer.reversed`

Keep the Billing events from [STRIPE.md](./STRIPE.md). One endpoint, one `STRIPE_WEBHOOK_SECRET`.

For a Cloudflare preview host, add a second endpoint or use:

```bash
stripe listen --forward-to localhost:5173/api/stripe/webhook
```

### 3. Platform balance (so transfers can pay)

Transfers leave the **platform** Stripe balance (from Credit top-ups and membership charges). In Test mode, Dashboard → **Balance → Add funds** if a transfer is rejected for insufficient available funds.

### 4. Provider walkthrough (test mode)

1. Sign in as a provider at **[/provider/signin](/provider/signin)** (Google / Apple, or **Continue as Tide & Tone** in development).
2. Open the signed-in provider home (`/provider`) — request queue + **Set up payouts**.
3. The workspace claims that practice (Tide & Tone for the demo account). Unsigned `/provider` still has Apply lookup and a labeled demo glance.
4. Click **Set up payouts**.
5. Finish Express onboarding with [test business / bank details](https://docs.stripe.com/connect/testing).
6. Return to `/provider`. Status becomes **Payouts enabled** after `account.updated` (or on the next `/api/connect/me` refresh).

Use **Continue setup** if Stripe sends the provider back with `?connect=refresh`. **Open payouts dashboard** opens the Express Dashboard login link once payouts are enabled.

## What the server stores

`drizzle/0005_connect.sql`:

| Table | Purpose |
| --- | --- |
| `providers` | Practice row + `stripe_connect_account_id` + Connect flags / `connect_status` |
| `provider_payouts` | One settlement per booking: gross, commission, net, transfer id, status |

Catalog practices (Tide & Tone, Form House, …) start **approved** and **not connected**. A signed-in **provider account** (`provider_accounts.practice_id`) claims that practice, then onboards. Tide & Tone demo sign-in is the test-mode path so Daniel can finish Express without an approved BD application. Production credential review can later flip `status` off `approved`; only approved rows can start Connect. Apply and the request queue are separate — see [PROVIDERS.md](./PROVIDERS.md) and [PROVIDER.md](./PROVIDER.md).

The Worker also `CREATE TABLE IF NOT EXISTS` on first use. Apply the SQL in the D1 console if you want the tables before the first onboard:

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0005_connect.sql
```

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/connect/me` | Status, claimed practice, payouts. Session optional. |
| `POST` | `/api/connect/claim` | Body: `{ providerId }` (catalog id, e.g. `tide-tone`). |
| `POST` | `/api/connect/onboard` | Claims if needed, creates Express account + Account Link. |
| `POST` | `/api/connect/login` | Express Dashboard login link. |
| `POST` | `/api/bookings/complete` | Marks fulfillable booking `completed` and settles a payout. |

Onboarding without `STRIPE_SECRET_KEY` returns `503` + `{ demo: true }` so CI and local review stay green.

## Settlement

`POST /api/bookings/complete` (member who booked, or the member who claimed that practice):

1. Booking → `completed` (Credits already moved on confirm; this does **not** touch the wallet).
2. Gross = Credits charged, or catalog standard price for a package redemption.
3. Commission = `round(gross * commission_rate / 100)` (default **20%**).
4. If `payouts_enabled` and Stripe is configured → `Transfer` for the net amount; payout `paid`.
5. Otherwise payout `estimated` (demo / not connected) or `failed` if Stripe rejects the transfer.

Replays do not create a second transfer (`provider_payouts.booking_id` + Stripe `Idempotency-Key`).

## Accounting reminder

- Credits funded by Stripe = **wallet liability**
- Completed marketplace volume = **GMV** (`provider_payouts.gross_amount`)
- Salu take-rate = **commission** (`commission_amount`)
- Provider money movement = **Connect transfer** (`net_payout`)

Do not treat Gold / Platinum monthly charges as revenue until a booking earns commission.

## Out of scope

Full tax forms beyond what Express onboarding already collects (W-9 / 1099 via Stripe), and Cloudflare DNS cutover. Atlas booking tools are already on main — see [ATLAS.md](./ATLAS.md).
