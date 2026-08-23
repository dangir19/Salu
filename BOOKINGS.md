# Bookings

Member appointments persist on the server (D1) for signed-in sessions. Refreshing the browser does **not** drop a real reservation. Credits deducted or restored on confirm / cancel go through the same wallet ledger as Stripe funding (`credit_transactions`) so those entries stay **customer liabilities**, not Salu revenue.

## What is durable

| Path | Behavior |
| --- | --- |
| Signed-in member + `DB` binding | Create / list / reschedule / cancel write `bookings`. Credit spend and refund use the Stripe wallet ledger. |
| Signed-in member, no D1 | Same API, in-process store (lost on Worker restart). Labeled as server-backed for the session. |
| No session / local preview | Labeled **demo appointments**. `SaluApp` still uses browser `localStorage` (`salu-demo-state-v7`). |

`GET /api/bookings` without a session returns `{ source: "demo" }` so the client can keep the local preview. `POST` without a session is `401` with the same demo label.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/bookings` | Member’s reservations. |
| `POST` | `/api/bookings` | Confirm. Body: `serviceId`, `date`, `mode`, optional `packageName` / `packageItem`. |
| `POST` | `/api/bookings/reschedule` | Body: `id`, `date`. No Credit movement. |
| `POST` | `/api/bookings/cancel` | Body: `id`. Restores Credits once when the booking had charged Credits. |

The Worker intercepts `/api/bookings` (same pattern as `/api/auth` and `/api/payments`). Catalog prices and Gold / Platinum discounts are computed on the server. When Stripe keys are present, a short wallet is rejected (`402`) instead of trusting the browser balance.

## D1 binding

Auth and Stripe already use Cloudflare D1 as `DB` when the binding exists.

**OpenAI / Codex Sites:** `.openai/hosting.json` already sets `"d1": "DB"`. The Worker also `CREATE TABLE IF NOT EXISTS` on first use.

**Cloudflare Worker (`salu`):** D1 is still optional. Create and bind it, then apply the checked-in migrations (see [DEPLOY.md](./DEPLOY.md)):

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0000_members.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0001_payments.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0002_bookings.sql
```

`0002_bookings.sql` adds `bookings` (`member_id`, service snapshot, display `date`, `status`, `credits_charged`, optional package fields). No extra env keys are required for bookings.

A confirmed reservation also opens an assignable **appointment request** for the catalog practice. Providers fill those in [PROVIDER.md](./PROVIDER.md).

You do **not** need live Stripe or Auth secrets to compile, lint, or test.

## Still demo

- Package **remaining-session counts** stay in the browser. A booking can record `packageName` / `packageItem` and skip Credits; the pack inventory is not a D1 entitlement table yet.
- Head of BD owns the Miami supplier pipeline (outreach, interviews, status); eng owns persistence and APIs — see [PROVIDERS.md](./PROVIDERS.md). The live provider request queue and calendar are in [PROVIDER.md](./PROVIDER.md).
- Availability inventory is the Miami catalog (`domain/mock-data.ts`), not a held-slot table. Approved individual providers can appear in Explore; the mock catalog stays a labeled **demo**.
- Stripe Connect / `ProviderPayout` is still the next payments step ([NEXT_PAYMENTS.md](./NEXT_PAYMENTS.md)).
- Atlas now books through this API; the optional language-model key, Cloudflare DNS cutover, and live credential-verification integrations are unchanged. See [ATLAS.md](./ATLAS.md).
