# Provider mode

Independent Miami providers can sign in to a workspace that is **distinct from membership**, fill appointment requests in real time, and keep a simple calendar. Stripe Connect / direct deposit is **not** in this release — see [NEXT_PAYMENTS.md](./NEXT_PAYMENTS.md).

## What Daniel can do today

1. Open **`/provider/signin`** (or **Provider workspace** in the footer).
2. In development, **Continue as Tide & Tone** — labeled demo provider, no Google app required.
3. After approval, the same Auth.js Google / Apple account opens this workspace with `role=provider`.
4. Incoming member bookings for that practice appear in the in-app queue (polls every few seconds).
5. **Accept**, **decline**, or **propose a new time**.
6. On **Schedule**, see accepted jobs and **block off** a time.

You do **not** need Stripe Connect, live OAuth, or D1 to compile, lint, or test. Without a provider session, `/provider` keeps Apply / BD lookup plus the labeled **Tide & Tone fabricated demo**.

## Sign-in (distinct from member)

| Path | Who |
| --- | --- |
| `/signin` | Members (Google, Apple, local preview) |
| `/provider/signin` | Providers (same Auth.js; callback `/provider`) |

Sessions are Auth.js JWTs. `/api/me` returns `{ member, provider, providers }`. `provider` is present only when the email is a demo practice, an allowlisted provider, or (after the recruitment PR) an **approved** application.

| Key | Required for | Notes |
| --- | --- | --- |
| `SALU_PROVIDER_EMAILS` | Production Google/Apple providers | Comma-separated emails that should get `role=provider` and Tide & Tone coverage until Connect / a live practice record exists. |

Demo emails `tide@localhost` and `provider@localhost` always resolve to **Tide & Tone Recovery** (`practice_id` `tide-tone`). Production builds never show **Continue as Tide & Tone**.

## Member bookings become assignable requests

When a signed-in member confirms a reservation (`POST /api/bookings` or Atlas `create_booking`), the server also writes an `appointment_requests` row (`open`) for that catalog practice. The member calendar shows **Awaiting provider** until someone accepts. See [ATLAS.md](./ATLAS.md).

| Provider action | Request | Member appointment |
| --- | --- | --- |
| Accept | `accepted` + `provider_assignments` | **Provider accepted** |
| Decline | `declined` | **Provider declined** (Credits stay until the member cancels) |
| Propose time | `proposed` + `proposed_date` | **Provider proposed …** (member can still Move with Atlas) |
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

`GET`/`POST` without a provider session return `{ source: "demo" }` (401 on writes).

## D1

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0000_members.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0001_payments.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0002_bookings.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0003_provider_applications.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0004_provider_workspace.sql
```

Apply / BD review is in [PROVIDERS.md](./PROVIDERS.md) (`0003_provider_applications.sql`). `0004_provider_workspace.sql` adds `provider_accounts`, `appointment_requests`, `provider_assignments`, and `provider_blocks`. The Worker also `CREATE TABLE IF NOT EXISTS` on first use. Without `DB`, the same APIs use an in-process store (lost on Worker restart).

## What works without Connect

| Works now | Still demo / later |
| --- | --- |
| Provider sign-in (demo or approved email) | Stripe Connect onboarding |
| Live request queue from member bookings | Direct deposit / `ProviderPayout` |
| Accept / decline / propose time | Held-slot inventory |
| Accepted-job calendar + block time | Email / SMS notify |
| Labeled Tide & Tone fallback | Atlas LLM, Cloudflare DNS ([CUTOVER.md](./CUTOVER.md)) |
| Member appointment assignment labels | Live credential verification |

Commission math on the unsigned-in demo glance is still fabricated. Accepting a request does **not** move money.
