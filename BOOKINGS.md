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
| `POST` | `/api/bookings` | Confirm. Body: `serviceId`, `date`, `mode`, optional `packageName` / `packageItem`. Scheduled path: `providerId` + `slotStart`. Optional `idempotencyKey`: retries with the same key replay the original booking instead of double-booking / double-charging. |
| `POST` | `/api/bookings/reschedule` | Body: `id`, `date`. Bookings that hold a real provider slot must also pass the new `startsAt` (`slotEnd` optional) — the new slot is re-verified free and claimed atomically; a display-date-only move is rejected for those. No Credit movement. |
| `POST` | `/api/bookings/accept-proposal` | Body: `id`. Member accepts a provider-proposed time. Request becomes `accepted` at that slot. No Credit movement. |
| `POST` | `/api/bookings/decline-proposal` | Body: `id`. Member declines a proposed time. Request returns to `open` / awaiting provider at the original time. Credits stay until cancel. |
| `POST` | `/api/bookings/cancel` | Body: `id`. Cancelling an upcoming reservation restores Credits **only when the booking actually debited the wallet** (org bookings refund to the org wallet, never the member). Double-cancel is a no-op; completed bookings cannot be cancelled. |
| `POST` | `/api/bookings/complete` | Body: `id`. Marks the reservation completed and settles a Connect payout ([CONNECT.md](./CONNECT.md)). Cancelled bookings cannot be completed. |

The Worker intercepts `/api/bookings` (same pattern as `/api/auth` and `/api/payments`). Catalog prices and Gold / Platinum discounts are computed on the server. When Stripe keys are present, a short wallet is rejected (`402`) instead of trusting the browser balance.

## D1 binding

Auth and Stripe already use Cloudflare D1 as `DB` when the binding exists.

**OpenAI / Codex Sites:** `.openai/hosting.json` already sets `"d1": "DB"`. The Worker also `CREATE TABLE IF NOT EXISTS` on first use.

**Cloudflare Worker (`salu`):** D1 is still optional. Create and bind it, then apply the checked-in migrations (see [DEPLOY.md](./DEPLOY.md)):

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0000_members.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0001_payments.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0002_bookings.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0003_provider_applications.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0004_provider_workspace.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0005_connect.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0006_credentials.sql
```

Apply `drizzle/0007_provider_scheduling.sql` through `drizzle/0010_mcp.sql` the same way for the scheduling engine and org wallets. (Slot claims and idempotency keys live in `slot_claims` / `booking_idempotency` tables created at runtime by `ensureBookingsSchema()` in `db/bookings.ts` — no migration needed.)

`0002_bookings.sql` adds `bookings` (`member_id`, service snapshot, display `date`, `status`, `credits_charged`, optional package fields). Provider applications and Connect payouts are later migrations — see [PROVIDERS.md](./PROVIDERS.md) and [CONNECT.md](./CONNECT.md). No extra env keys are required for bookings.

A confirmed reservation also opens an assignable **appointment request** for the catalog practice. Providers fill those in [PROVIDER.md](./PROVIDER.md). When a provider proposes a new time, the signed-in member accepts or declines it from Appointments (`POST /api/bookings/accept-proposal` or `/api/bookings/decline-proposal`) without opening Atlas. Accept confirms the proposed slot; decline reopens the request as awaiting provider. Credits do not move either way.

## Booking integrity

- **Atomic slot claims.** Creating or moving a booking that holds a real provider slot first claims `[startsAt, slotEnd)` in a `slot_claims` table (created at runtime by `ensureBookingsSchema()` in `db/bookings.ts`). The claim is one `INSERT … SELECT … WHERE NOT EXISTS` statement, so two workers racing for the same or overlapping intervals resolve to exactly one winner (409 for the loser). The claim is released once the booking row is written; stale claims are swept after a 10-minute TTL. Without D1, an in-process claim store with the same overlap rules is used.
- **Idempotent creation.** `POST /api/bookings` accepts an optional `idempotencyKey`. Repeats with the same key return the original booking and never charge twice — enforced by a `booking_idempotency` table (`PRIMARY KEY (member_id, idempotency_key)`, created at runtime by `ensureBookingsSchema()` in `db/bookings.ts`) plus a per-key lock. The key is claimed before the booking row is written, so concurrent retries collide on the key instead of creating duplicates; a key whose booking never landed is treated as an orphan and released on lookup. If a retry lands after the slot was taken by the original booking, it still replays the original instead of 409ing.
- **No past slots.** Concrete-slot bookings (`createScheduledMemberBooking`, `assignMemberBooking`, reschedule) reject start times in the past with 400.
- **Reschedule moves the slot.** For bookings with a real `startsAt`, reschedule requires the new slot (`startsAt`); it is verified free and claimed atomically (excluding the booking's own current interval), and the old slot is freed. Legacy display-date bookings keep the old date-only move.
- **Refunds restore debits.** Cancellation refunds only when a matching negative `booking` ledger entry exists — a booking that never charged (free item, waived spend) cannot mint credits, and org bookings refund to the org wallet.

You do **not** need live Stripe or Auth secrets to compile, lint, or test.

## Still demo

- Package **remaining-session counts** stay in the browser. A booking can record `packageName` / `packageItem` and skip Credits; the pack inventory is not a D1 entitlement table yet.
- Head of BD owns the Miami supplier pipeline (outreach, interviews, status); eng owns persistence and APIs — see [PROVIDERS.md](./PROVIDERS.md). The live provider request queue and calendar are in [PROVIDER.md](./PROVIDER.md).
- Availability inventory is the Miami catalog (`domain/mock-data.ts`), not a held-slot table. Approved individual providers can appear in Explore; the mock catalog stays a labeled **demo**.
- Completing a reservation (`POST /api/bookings/complete`) settles Stripe Connect payouts ([CONNECT.md](./CONNECT.md)). Without a connected Express account the payout stays `estimated`.
- Atlas now books through this API; the optional language-model key, Cloudflare DNS cutover, and live credential-verification integrations are unchanged. See [ATLAS.md](./ATLAS.md).
