# Provider mode

Independent Miami providers can sign in to a workspace that is **distinct from membership**, fill appointment requests in real time, keep a simple calendar, and finish **Stripe Connect** Express from the signed-in home. Direct deposit details are in [CONNECT.md](./CONNECT.md).

## What Daniel can do today

1. Open **`/provider/signin`** (or **Provider workspace** in the footer).
2. In development, **Continue as Tide & Tone** — labeled demo provider, no Google app required.
3. After approval, the same Auth.js Google / Apple account opens this workspace with `role=provider`.
4. Incoming member bookings for that practice appear in the in-app queue (polls every few seconds).
5. **Accept**, **decline**, or **propose a new time**. When you propose, the member accepts or declines from Appointments — not only through Atlas.
6. On **Schedule**, see accepted jobs, **mark complete**, and **block off** a time.
7. On **Payouts** (and the request-home card), **Set up payouts** — Stripe Connect Express for that `provider_accounts` practice.

You do **not** need live Stripe, live OAuth, or D1 to compile, lint, or test. Without `STRIPE_SECRET_KEY`, **Set up payouts** stays a labeled **demo**. Without a provider session, `/provider` keeps Apply / BD lookup plus the labeled **Tide & Tone fabricated demo**.

## Sign-in (distinct from member)

| Path | Who |
| --- | --- |
| `/signin` | Members (Google, Apple, local preview) |
| `/provider/signin` | Providers (same Auth.js; callback `/provider`) |

Sessions are Auth.js JWTs. `/api/me` returns `{ member, provider, providers }`. `provider` is present only when the email is a demo practice, an allowlisted provider, or (after the recruitment PR) an **approved** application.

| Key | Required for | Notes |
| --- | --- | --- |
| `SALU_PROVIDER_EMAILS` | Production Google/Apple providers | Comma-separated emails that should get `role=provider` and Tide & Tone coverage when they are not already an approved Apply person. |
| `SALU_ADMIN_EMAILS` | BD review queue | Comma-separated staff emails for `/admin` and application list/status. Distinct from provider allowlist. See [PROVIDERS.md](./PROVIDERS.md). |

Demo emails `tide@localhost` and `provider@localhost` always resolve to **Tide & Tone Recovery** (`practice_id` `tide-tone`). Production builds never show **Continue as Tide & Tone**.

## Member bookings become assignable requests

When a signed-in member confirms a reservation (`POST /api/bookings` or Atlas `create_booking`), the server also writes an `appointment_requests` row (`open`) for that catalog practice. The member calendar shows **Awaiting provider** until someone accepts. See [ATLAS.md](./ATLAS.md).

| Provider action | Request | Member appointment |
| --- | --- | --- |
| Accept | `accepted` + `provider_assignments` | **Provider accepted** |
| Decline | `declined` | **Provider declined** (Credits stay until the member cancels) |
| Propose time | `proposed` + `proposed_date` | **Provider proposed …** with **This time works** / **Not this time** on Appointments (Move with Atlas still available) |
| Member accepts proposed time | `accepted` + assignment at the proposed slot | **Provider accepted** at the new time (Credits stay as already charged) |
| Member declines proposed time | `open` (clears `proposed_date` and the assignment) | **Awaiting provider** at the original time (Credits stay until the member cancels) |
| Member cancels | `cancelled` | Cancelled as today |

Notification is the **in-app queue**. Email is optional and not wired.

## API

The Worker intercepts `/api/provider` and `/api/provider/*` only — not `/api/providers` (recruitment pipeline, if present).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/provider/me` | Provider session or labeled demo. |
| `GET` | `/api/provider/requests` | Open + proposed inbox. Seeds one **labeled walkthrough request** when the queue is empty so a demo provider can accept immediately. |
| `POST` | `/api/provider/requests/accept` | Body: `id`. |
| `POST` | `/api/provider/requests/decline` | Body: `id`. |
| `POST` | `/api/provider/requests/propose` | Body: `id`, `date`. |
| `GET` | `/api/provider/schedule` | Accepted jobs + blocks. |
| `POST` | `/api/provider/schedule/block` | Body: `date`, optional `note`. |
| `POST` | `/api/provider/schedule/unblock` | Body: `id`. |
| `GET` | `/api/connect/me` | Auto-claims the signed-in practice (`provider_accounts.practice_id`). |
| `POST` | `/api/connect/onboard` | Express Account Link. Defaults to the provider account practice. |
| `POST` | `/api/bookings/complete` | Provider who owns that practice can complete an accepted job. |
| `POST` | `/api/bookings/accept-proposal` | Member session. Accepts a `proposed` time; assignment uses that slot. |
| `POST` | `/api/bookings/decline-proposal` | Member session. Returns the request to `open` at the original time. |

`GET`/`POST` without a provider session return `{ source: "demo" }` (401 on writes).

## D1

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0000_members.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0001_payments.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0002_bookings.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0003_provider_applications.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0004_provider_workspace.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0005_connect.sql
```

Apply / BD review is in [PROVIDERS.md](./PROVIDERS.md) (`0003_provider_applications.sql`). `0004_provider_workspace.sql` adds `provider_accounts`, `appointment_requests`, `provider_assignments`, and `provider_blocks`. Connect tables are in `0005_connect.sql` — see [CONNECT.md](./CONNECT.md). The Worker also `CREATE TABLE IF NOT EXISTS` on first use. Without `DB`, the same APIs use an in-process store (lost on Worker restart).

## What works without a live Stripe Connect account

| Works now | Still demo / later |
| --- | --- |
| Provider sign-in (demo or approved email) | Live bank payouts until Express is finished |
| Live request queue from member bookings | Held-slot inventory |
| Accept / decline / propose time | Email / SMS notify |
| Accepted-job calendar + block time + mark complete | Atlas LLM extras, Cloudflare DNS ([CUTOVER.md](./CUTOVER.md)) |
| Labeled Tide & Tone fallback | Live credential verification |
| Member appointment assignment labels | Full tax / 1099 ops beyond Express |
| **Set up payouts** on the signed-in home (demo without keys) | |

Commission math on the unsigned-in demo glance is still fabricated. Accepting a request does **not** move money. Completing a booking records an estimated `ProviderPayout` until Stripe Connect payouts are enabled.
