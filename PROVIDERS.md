# Provider recruitment

Head of BD can run a Miami supplier pipeline from **Apply to Salu** (`/apply`) through **Admin** (`/admin`). Applications persist on the server (D1). Refreshing the browser does **not** drop a real submission.

## Who owns what

| Owner | Owns | Does not own |
| --- | --- | --- |
| **Head of BD** | Outreach, the Apply URL, interviews, collecting license/insurance proof offline, moving status (`submitted` → `under_review` → `approved` / `rejected`), neighborhood coverage (Brickell, Miami Beach, Miami-Dade, and the rest of the chip list), rate conversations | D1 schema, APIs, Explore merge, Stripe Connect, credential-verification products |
| **Eng** | `/apply` form, D1 `provider_applications`, `/api/providers/*`, admin filter + status, approved rows in the Explore catalog, labeled demo fallbacks | Vendor outreach, interviewing, deciding who is approved, live license registries, payouts |

Point providers at **https://joinsalu.com/apply** (or the Worker preview `/apply`). BD reviews them at `/admin`.

## What is durable

| Path | Behavior |
| --- | --- |
| `POST /api/providers/apply` | Public. Writes `submitted` into D1 when `DB` is bound, otherwise an in-process store (lost on Worker restart). |
| `GET /api/providers/apply?email=` | Provider workspace lookup. Returns that contact’s applications only. |
| `GET /api/providers/applications` | Admin list + optional `?status=`. |
| `POST /api/providers/applications/status` | Admin status + optional BD note. |
| `GET /api/providers/catalog` | Approved applications as Explore cards. Empty list keeps the labeled **demo catalog**. |

The Worker intercepts `/api/providers` (same pattern as auth, payments, and bookings).

## Status

`submitted` · `under_review` · `approved` · `rejected`

Approved practices appear on Explore as **Miami suppliers**. License and insurance checkboxes are **self-attestations**, not verification. Prototype portraits and “Tide & Tone” economics stay labeled **demo**.

## Ops key

When `SALU_OPS_SECRET` is set, list/status calls need the `x-salu-ops` header. The admin page stores what BD types in `sessionStorage`. **Not required** to compile, lint, or test — without the secret, the pipeline stays open so local review still works.

## D1 binding

Auth, Stripe, and bookings already use Cloudflare D1 as `DB` when the binding exists.

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0000_members.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0001_payments.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0002_bookings.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0003_provider_applications.sql
```

`0003_provider_applications.sql` adds `provider_applications` (contact, services, neighborhoods, attestations, rate, status). The Worker also `CREATE TABLE IF NOT EXISTS` on first use.

## Still demo

- Explore mock catalog (Tide & Tone portraits, years, fun facts) — labeled **FABRICATED DEMO**
- Provider calendar, availability inventory, and payout economics
- Stripe Connect / `ProviderPayout` ([NEXT_PAYMENTS.md](./NEXT_PAYMENTS.md))
- Live license, insurance, or background-check integrations
- Provider login (email lookup only)
- Atlas LLM, Cloudflare DNS cutover ([CUTOVER.md](./CUTOVER.md))
- Package remaining-session counts ([BOOKINGS.md](./BOOKINGS.md))
