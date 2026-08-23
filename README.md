# Salu MVP

Salu is a premium self-pay wellness, recovery and personal-care membership for Miami, positioned as **“Your health concierge.”** The experience feels closer to thoughtful hospitality than a healthcare portal. Atlas, its deterministic demo concierge, provides general wellness education and helps members discover, compare, schedule, reschedule and coordinate independent services.

## Run locally

Requirements: Node.js 22.13+ and pnpm.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

No Google or Apple secrets are required to compile, lint, or test. In development, sign-in offers a labeled **local preview** bypass. Open the local URL printed by the development server.

To enable real Google / Apple member login, follow **[AUTH.md](./AUTH.md)** (Google Cloud OAuth client, Apple Services ID, `AUTH_*` env on the Cloudflare Worker). To take live cards for Gold / Platinum and Credit top-ups, follow **[STRIPE.md](./STRIPE.md)**. For provider direct deposit, follow **[CONNECT.md](./CONNECT.md)**. Atlas booking tools are in **[ATLAS.md](./ATLAS.md)**. Head of BD runs the Miami supplier pipeline from **[PROVIDERS.md](./PROVIDERS.md)** (`/apply` → D1 → `/admin`).

Production hosting is a Cloudflare Worker named `salu`, deployed by GitHub Actions on every push to `main`. See **[DEPLOY.md](./DEPLOY.md)** for token permissions and secrets. Do not move **joinsalu.com** off Codex Sites until **[CUTOVER.md](./CUTOVER.md)**.

Production validation:

```bash
pnpm build
pnpm lint
pnpm exec tsc --noEmit
pnpm test
```

## Included flows

- Premium hospitality-led landing experience with Member (free, standard prices), Gold ($200/month, 10% off) and Platinum ($500/month, 20% off)
- Automatic month-to-month Credit rollover for Gold and Platinum, with no Credit loss
- Stripe Checkout for Gold / Platinum and Credit top-ups when `STRIPE_*` keys are present; labeled demo wallet without secrets
- Persistent Ask Atlas action across every member screen
- Atlas conversation with a guarded tool layer: discover services, check catalog windows, create bookings through `/api/bookings` (those open the provider request queue), and show a confirmation card that opens Appointments
- Credit deduction, transaction history and package purchase/entitlements
- Searchable Miami marketplace across at-home, virtual, hotel and provider-location modes
- Service and provider details, time selection, checkout, rescheduling and cancellation
- Single-member profile, member offers, and Apply to Salu (persisted **individual** LMT / solo-provider applications)
- Runna-first connected-app demo plus Strava, Apple Health, Garmin, Oura, Whoop and Calendar placeholders
- Provider sign-in (distinct from member) with a live appointment-request queue, accept / decline / propose, a calendar of accepted jobs, and **Set up payouts** (Stripe Connect Express); unsigned `/provider` keeps Apply lookup plus a labeled Tide & Tone demo ([PROVIDER.md](./PROVIDER.md), [PROVIDERS.md](./PROVIDERS.md), [CONNECT.md](./CONNECT.md))
- Admin Miami pipeline (list / filter / status) plus a labeled demo of wallet contributions, GMV, and Salu net revenue
- Responsive editorial layouts, compact mobile navigation, accessible controls and compliance boundaries

All provider names, credentials, availability and integration data are clearly identified as fabricated prototype data. No insurance workflow, real medical-record storage, live payment credentials, diagnosis or prescribing is included.

## Architecture

```text
app/
  layout.tsx          Metadata and application shell
  [[...slug]]/page.tsx Shareable member routes + session hand-off
  api/auth            Auth.js Google / Apple / development handlers
  api/me              Combined member session
  api/payments        Checkout, portal, and wallet snapshot
  api/connect         Express onboarding, payout status
  api/bookings        Member create / list / reschedule / cancel / complete
  api/atlas           Concierge turn: tools, safety, optional OpenAI
  api/providers       Apply, catalog, and admin pipeline
  api/provider        Provider session, request queue, schedule
  api/stripe/webhook  Signed Stripe events → membership, Credits, Connect
  chatgpt-auth.ts     OpenAI Sites header identity
components/
  SaluApp.tsx         Member shell (gated on a real session)
  SignIn.tsx          Hospitality Google / Apple sign-in
auth/                 Auth.js config, env stubs, member mapping
payments/             Stripe env, Checkout, webhook ledger
connect/              Express accounts, transfers, payout settlement
domain/
  mock-data.ts        Miami services, packages, bookings and Atlas fixtures
  types.ts            Member, wallet, and payments-port contracts
  payments.ts         Browser placeholder until /api/payments/me returns a card
bookings/             Member booking service, catalog prices, handlers
atlas/                Deterministic planner, tools, optional OpenAI, handlers
providers/            Application service, Miami catalog mapping, handlers
provider/             Provider session, request queue, schedule
db/                   D1/Drizzle members, wallets, credit ledger, bookings, applications, provider workspace, Connect
worker/               Cloudflare entry; auth + payments + Connect + bookings + Atlas + providers + provider intercept
wrangler.jsonc        Production Worker `salu` (CI deploy; no joinsalu.com route)
.github/workflows/    Verify on PRs; deploy to Workers on `main`
DEPLOY.md / CUTOVER.md Cloudflare token, secrets, and DNS switch
.openai/hosting.json  Local / Codex Sites metadata + D1 binding `DB`
ATLAS.md              Concierge tools, safety, and optional language-model path
tests/                Render/build, auth identity, payments, deploy-config, booking, provider, Atlas, and Connect checks
```

Signed-in member appointments persist in D1 (`/api/bookings`) and survive refresh. Those bookings also open assignable provider requests (`/api/provider/requests`). Without a session, Appointments stay a labeled **demo** in browser storage. Provider applications persist in D1 (`/api/providers/apply`); BD reviews named people at `/admin`. Approved individuals appear in Explore and can sign in with `role=provider`. When Stripe keys are present, membership, Credit funding, and booking spend/refund share the D1 wallet ledger. Member identity is no longer “always Daniel / DG”: production builds require Google, Apple, or OpenAI Sites sign-in. The contracts in `domain/types.ts` separate wallet transactions from package entitlements and gross member funding from platform commission revenue. See **[BOOKINGS.md](./BOOKINGS.md)**, **[PROVIDERS.md](./PROVIDERS.md)**, **[PROVIDER.md](./PROVIDER.md)**, and **[ATLAS.md](./ATLAS.md)**.

## Production next steps

1. Persist package entitlements and availability holds in D1; add row-level access and audit logging (members, Credits, bookings, provider applications, and request assignments are in place).
2. Apply `drizzle/0001_payments.sql`, `drizzle/0002_bookings.sql`, `drizzle/0003_provider_applications.sql`, `drizzle/0004_provider_workspace.sql`, and `drizzle/0005_connect.sql` in Cloudflare D1 if you want the tables before first use; see `STRIPE.md`, `BOOKINGS.md`, `PROVIDERS.md`, `PROVIDER.md`, and `CONNECT.md`.
3. Finish Stripe Connect Dashboard setup (enable Express, add `account.updated` to the webhook) so signed-in providers can complete test-mode onboarding from the provider home. See `CONNECT.md`.
4. Add live license / insurance verification integrations; never treat Apply attestations or prototype fields as verified.
5. Optional: set `OPENAI_API_KEY` so Atlas can use a language model on top of the same discover / availability / booking tools. Reschedule and cancel from chat are still follow-ups.
6. Add integration consent, token storage and official APIs for Runna/Strava/etc. only after partnership and privacy review.
7. Add provider onboarding, offer management, lab-order eligibility, and tightly bounded GLP-1-adjacent education without medication prescribing.
8. Add automated unit, integration, accessibility and end-to-end tests plus observability.

## Product boundaries

Salu is a marketplace and coordination platform. Independent third parties deliver services. Atlas is not a physician and does not diagnose, prescribe or replace professional care. Clinical services must be performed by appropriately qualified independent providers. Salu does not process insurance and this MVP stores no medical records. Users should call 911 or seek appropriate urgent professional care for emergencies.
