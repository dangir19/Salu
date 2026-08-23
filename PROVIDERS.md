# Provider recruitment

Head of BD can run a Miami pipeline of **individual** providers from **Apply to Salu** (`/apply`) through **Admin** (`/admin`). Salu recruits named LMTs and other solo licensed people — not multi-therapist spa brands, unless BD is taking a specific therapist off a roster. Applications persist on the server (D1). Refreshing the browser does **not** drop a real submission.

This surface is apply + review only. Provider login and the request calendar live in [PROVIDER.md](./PROVIDER.md). Stripe Connect payouts are in [CONNECT.md](./CONNECT.md).

## Who owns what

| Owner | Owns | Does not own |
| --- | --- | --- |
| **Head of BD** | Outreach to named people, the Apply URL, interviews, collecting license/insurance **proof** offline, docs status, moving `submitted` → `under_review` → `approved` / `rejected`, Brickell / Miami Beach / Miami-Dade coverage, rate conversations | D1 schema, APIs, Explore merge, Stripe Connect implementation, credential-verification products |
| **Eng** | `/apply` form, D1 `provider_applications`, `/api/providers/*`, admin filter + status + docs, approved individuals in the Explore catalog, labeled demo fallbacks, provider workspace ([PROVIDER.md](./PROVIDER.md)), Stripe Connect Express + transfers | Vendor outreach, interviewing, deciding who is approved, live license registries |

Point independent providers at **https://joinsalu.com/apply** (or the Worker preview `/apply`). BD reviews them at `/admin` after signing in with an allowlisted staff email.

## Review fields (what BD listed)

| Field | Apply | Admin queue |
| --- | --- | --- |
| Full legal name | Required | Shown |
| FL license type + number | Required | Shown · filter by type |
| Mobile / at-home (yes/no) | Required | Shown · filter |
| Neighborhoods (Brickell, Miami Beach, Miami-Dade; multi-select) | At least one | Shown · filter |
| Rate ask | Required | Shown |
| Docs status (license proof / insurance: missing or received) | Starts **missing** | Editable · filter |
| Email / phone | Email required | Shown for follow-up |
| Insurance attestation | Required checkbox | Implied; proof is the docs field |

License number and insurance checkbox are **self-reported**. They are not verification. BD marks proof received in the queue.

## What is durable

| Path | Behavior |
| --- | --- |
| `POST /api/providers/apply` | Public. Writes `submitted` into D1 when `DB` is bound, otherwise an in-process store (lost on Worker restart). |
| `GET /api/providers/apply?email=` | Provider workspace lookup. Returns that person’s applications only. |
| `GET /api/providers/applications` | Admin list. **Signed-in allowlisted staff only.** Filters: `status`, `neighborhood`, `mobile=yes\|no`, `licenseType`, `docs=missing_license\|missing_insurance\|complete`. |
| `POST /api/providers/applications/status` | Admin status, BD note, and docs received/missing. **Signed-in allowlisted staff only.** |
| `GET /api/providers/catalog` | Approved **individuals** as Explore cards. Empty list keeps the labeled **demo catalog**. |

The Worker intercepts `/api/providers` (same pattern as auth, payments, and bookings).

## Status

`submitted` · `under_review` · `approved` · `rejected`

Approved people appear on Explore as **independent providers**. Prototype portraits and “Tide & Tone” economics stay labeled **demo**.

## Staff auth

`/admin` and the list/status APIs are **not public**. They require:

1. A signed-in Auth.js session (the same `/api/me` session as membership — Google, Apple, ChatGPT headers, or the development bypass).
2. That session email on `SALU_ADMIN_EMAILS` (comma-separated, case-insensitive).

| Visitor | `/admin` | List / status APIs |
| --- | --- | --- |
| Signed out | Redirect to `/signin` — the live queue is never rendered | `401` — no application rows |
| Signed in, email not on the allowlist | **Not authorized** (`403`) — no queue data | `403` — no application rows |
| Signed in + allowlisted | Live review queue | `200` |

Production fails closed: an empty `SALU_ADMIN_EMAILS` means **nobody** can read or update the live queue. Set Daniel / Head of BD emails on the Worker before they review production Apply submissions.

Development has a labeled **Continue as Salu admin** path (`admin@localhost`), same idea as Tide & Tone. Production builds never register that provider and never treat `admin@localhost` as staff.

The **APPROVAL QUEUE · DEMO** block on `/admin` is fabricated walkthrough names (Sofia Alvarez, Mateo Ruiz, Elena Torres). It is not the D1 pipeline. The **LIVE REVIEW QUEUE** is the real applicant list and stays gated even in local previews.

### Optional ops header

When `SALU_OPS_SECRET` is set, list/status also need the `x-salu-ops` header after the session + allowlist check. The admin page stores what BD types in `sessionStorage`. This is an extra lock, not a substitute for sign-in. **Not required** to compile, lint, or test.

## D1 binding

Auth, Stripe, and bookings already use Cloudflare D1 as `DB` when the binding exists.

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0000_members.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0001_payments.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0002_bookings.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0003_provider_applications.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0004_provider_workspace.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0005_connect.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0006_credentials.sql
```

`0003_provider_applications.sql` adds `provider_applications`. The request queue and calendar tables are in `0004_provider_workspace.sql` ([PROVIDER.md](./PROVIDER.md)). `0005_connect.sql` adds `providers` and `provider_payouts` for Express onboarding and transfers. The Worker also `CREATE TABLE IF NOT EXISTS` on first use.

## Still demo

- Explore mock catalog (Tide & Tone portraits, years, fun facts) — labeled **FABRICATED DEMO**
- Unsigned `/provider` glance calendar (signed-in queue is [PROVIDER.md](./PROVIDER.md))
- Availability inventory
- Live license, insurance, or background-check integrations
- Atlas LLM, Cloudflare DNS cutover ([CUTOVER.md](./CUTOVER.md))
- Package remaining-session counts ([BOOKINGS.md](./BOOKINGS.md))
