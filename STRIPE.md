# Stripe Billing and Credits

Salu membership (Gold / Platinum) and Credit top-ups charge through **Stripe Checkout**. Webhooks write the plan and Credit ledger on the server (D1). The browser is never the source of truth for paid entitlements.

Stripe Connect / provider payouts are **not** in this release. See [NEXT_PAYMENTS.md](./NEXT_PAYMENTS.md).

## When Daniel must sign into Stripe

You do **not** need a Stripe account to run `pnpm dev`, `pnpm test`, `pnpm lint`, or `pnpm exec tsc --noEmit`. Without keys, Plans & Credits stay a labeled **demo** (local Credits, no charges).

Sign into [Stripe Dashboard](https://dashboard.stripe.com) when you want a real card to:

1. Create the Gold and Platinum products/prices
2. Add the webhook endpoint for `joinsalu.com`
3. Copy secrets into Cloudflare / OpenAI Sites / `.env`

Use **Test mode** until you are ready for live cards. Toggle Test / Live in the Dashboard; each mode has its own keys, products, and webhook secret.

## What members see

| Surface | With Stripe keys | Without keys (demo) |
| --- | --- | --- |
| Plans & Packages | Gold / Platinum open Stripe Checkout (or update an existing subscription) | Existing labeled onboarding; Credits are granted locally |
| Credits | **Add 100 Credits** opens Stripe Checkout (`$100` → 100 Credits) | **Add 100 demo Credits** |
| Profile billing | Brand + last4 from Stripe, plus **Manage billing** (Customer Portal) | “No payment method on file” / “Stripe Billing is not connected yet” |

Wallet contributions are **customer liabilities**. They are not Salu revenue. Salu revenue remains marketplace commission (`PlatformCommission`). Provider payouts stay estimated until Connect.

## Environment keys

| Key | Where it lives | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Server / Worker only | `sk_test_…` then `sk_live_…`. Never expose to the browser. |
| `STRIPE_PUBLISHABLE_KEY` | Server (reserved for Payment Element later) | `pk_test_…` / `pk_live_…`. Checkout redirect does not need it on the client yet. |
| `STRIPE_WEBHOOK_SECRET` | Server / Worker only | `whsec_…` from the webhook endpoint. Required to accept events. |
| `STRIPE_GOLD_PRICE_ID` | Server | Recurring price `price_…` for **$200 / month**. |
| `STRIPE_PLATINUM_PRICE_ID` | Server | Recurring price `price_…` for **$500 / month**. |

Copy `.env.example` to `.env` (Vite) or `.dev.vars` (Wrangler). Do not commit secrets.

## Dashboard setup (sign in required)

### 1. Create products and prices

Dashboard → **Product catalog** → **Add product**. Create two products:

| Product | Description | Price |
| --- | --- | --- |
| Salu Gold | 200 Credits monthly · 10% off · Credits roll | Recurring, **$200 USD / month** |
| Salu Platinum | 500 Credits monthly · 20% off · Credits roll | Recurring, **$500 USD / month** |

Copy each **Price ID** (`price_…`, not the product `prod_…`) into `STRIPE_GOLD_PRICE_ID` and `STRIPE_PLATINUM_PRICE_ID`.

Credit top-ups do **not** need a Dashboard price. Checkout creates a one-time `price_data` amount (`$1` = 1 Credit). Allowed amounts: 100, 200, 500.

### 2. Customer Portal (membership changes and cancellation)

Dashboard → **Settings → Billing → Customer portal**. Enable:

- Update payment method
- Cancel subscriptions (recommend **at period end**)
- Optional: switch plans if you list both prices

Members open this from **Profile → Manage billing**.

### 3. Webhook endpoint

Dashboard → **Developers → Webhooks → Add endpoint**.

| Field | Value |
| --- | --- |
| Endpoint URL | `https://joinsalu.com/api/stripe/webhook` |
| API version | Account default is fine |
| Events | `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded` |

Copy **Signing secret** → `STRIPE_WEBHOOK_SECRET`.

For a Cloudflare preview host, add a second endpoint with that origin (`https://<preview>/api/stripe/webhook`) or use the Stripe CLI (below).

### 4. Paste secrets

**Local:** `.env` or `.dev.vars` (same keys as the table).

**Cloudflare:** Workers & Pages → Salu worker → Settings → Variables. Add the five `STRIPE_*` keys. Keep them secret (encrypted).

**OpenAI Sites:** project secrets for this repo.

Also keep `AUTH_URL=https://joinsalu.com` from [AUTH.md](./AUTH.md). Checkout success returns to `/credits?checkout=success`.

Redeploy after saving secrets. Confirm:

- `https://joinsalu.com/api/payments/me` returns `"stripe": true` when signed in
- The webhook endpoint shows recent `invoice.paid` / `checkout.session.completed` deliveries as successful

## Local webhook forwarding (optional)

Sign into Stripe (Dashboard or CLI) first.

```bash
stripe listen --forward-to localhost:5173/api/stripe/webhook
```

Paste the CLI `whsec_…` into local `STRIPE_WEBHOOK_SECRET`. Use Test mode keys and test cards (`4242 4242 4242 4242`). Without `stripe listen`, hosted Checkout can succeed while the local ledger stays empty until you retry the event.

## How the ledger is updated

| Stripe event | Salu effect |
| --- | --- |
| `checkout.session.completed` (subscription) | Store customer + subscription; wait for `invoice.paid` for Credits |
| `invoice.paid` (subscription invoice) | Set Gold/Platinum; credit wallet by `amount_paid / 100` (1 Credit = $1) |
| `checkout.session.completed` (payment) | Credit wallet by `amount_total / 100` |
| `invoice.payment_failed` | Mark membership `past_due`; Credits stay |
| `customer.subscription.updated` | Move plan when the price changes |
| `customer.subscription.deleted` | Return to Member; existing Credits remain |
| `charge.refunded` | Debit Credits by the refunded dollar amount |

Events are stored in `stripe_events` so a retry does not double-credit. Choosing **Member** while a paid subscription exists sets `cancel_at_period_end` in Stripe.

## D1

`drizzle/0001_payments.sql` adds `members.stripe_*`, `wallets`, `credit_transactions`, and `stripe_events`. The worker also `CREATE TABLE IF NOT EXISTS` on first use. Apply the SQL in the Cloudflare D1 console if you want the schema in place before the first webhook.

Booking spend and refunds use this same ledger. Appointment rows live in `drizzle/0002_bookings.sql` — see [BOOKINGS.md](./BOOKINGS.md). Provider applications are a separate D1 table — see [PROVIDERS.md](./PROVIDERS.md).

## Accounting reminder

- Credits funded by Stripe = **wallet liability**
- Completed marketplace volume = **GMV**
- Salu take-rate = **commission** (`PlatformCommission`)
- Provider money movement = **Connect** (next)

Do not treat Gold/Platinum monthly charges as revenue until a booking earns commission.
