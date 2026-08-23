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

To enable real Google / Apple member login, follow **[AUTH.md](./AUTH.md)** (Google Cloud OAuth client, Apple Services ID, `AUTH_*` env on the Cloudflare Worker). To take live cards for Gold / Platinum and Credit top-ups, follow **[STRIPE.md](./STRIPE.md)**. Stripe Connect (provider payouts) is **not** in this release — see **[NEXT_PAYMENTS.md](./NEXT_PAYMENTS.md)**.

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
- Atlas conversation with deterministic education, escalation and booking responses
- Credit deduction, transaction history and package purchase/entitlements
- Searchable Miami marketplace across at-home, virtual, hotel and provider-location modes
- Service and provider details, time selection, checkout, rescheduling and cancellation
- Single-member profile, member offers and provider onboarding application
- Runna-first connected-app demo plus Strava, Apple Health, Garmin, Oura, Whoop and Calendar placeholders
- Provider workspace with appointments, price/commission/payout economics
- Admin workspace distinguishing wallet contributions, GMV, provider payouts, liabilities and Salu net revenue
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
  api/bookings        Member create / list / reschedule / cancel
  api/stripe/webhook  Signed Stripe events → membership + Credits
  chatgpt-auth.ts     OpenAI Sites header identity
components/
  SaluApp.tsx         Member shell (gated on a real session)
  SignIn.tsx          Hospitality Google / Apple sign-in
auth/                 Auth.js config, env stubs, member mapping
payments/             Stripe env, Checkout, webhook ledger
domain/
  mock-data.ts        Miami services, packages, bookings and Atlas fixtures
  types.ts            Member, wallet, and payments-port contracts
  payments.ts         Browser placeholder until /api/payments/me returns a card
bookings/             Member booking service, catalog prices, handlers
db/                   D1/Drizzle members, wallets, credit ledger, bookings
worker/               Cloudflare entry; auth + payments + bookings intercept
wrangler.jsonc        Production Worker `salu` (CI deploy; no joinsalu.com route)
.github/workflows/    Verify on PRs; deploy to Workers on `main`
DEPLOY.md / CUTOVER.md Cloudflare token, secrets, and DNS switch
.openai/hosting.json  Local / Codex Sites metadata + D1 binding `DB`
tests/                Render/build, auth identity, payments, deploy-config, and booking API checks
```

Signed-in member appointments persist in D1 (`/api/bookings`) and survive refresh. Without a session, Appointments stay a labeled **demo** in browser storage. When Stripe keys are present, membership, Credit funding, and booking spend/refund share the D1 wallet ledger. Member identity is no longer “always Daniel / DG”: production builds require Google, Apple, or OpenAI Sites sign-in. The contracts in `domain/types.ts` separate wallet transactions from package entitlements and gross member funding from platform commission revenue. See **[BOOKINGS.md](./BOOKINGS.md)**.

## Production next steps

1. Persist package entitlements and availability holds in D1; add row-level access and audit logging (members, Credits, and bookings are in place).
2. Apply `drizzle/0001_payments.sql` and `drizzle/0002_bookings.sql` in Cloudflare D1 if you want the tables before the first webhook or reservation; see `STRIPE.md` and `BOOKINGS.md`.
3. Connect Stripe Connect for provider payouts; recognize commissions separately from customer wallet liabilities. See `NEXT_PAYMENTS.md`.
4. Implement a provider credential-review workflow; never treat prototype fields as verified.
5. Connect a real language model through a guarded Atlas orchestration layer with structured discovery, availability, booking, rescheduling and cancellation tools.
6. Add integration consent, token storage and official APIs for Runna/Strava/etc. only after partnership and privacy review.
7. Add provider onboarding, offer management, lab-order eligibility, and tightly bounded GLP-1-adjacent education without medication prescribing.
8. Add automated unit, integration, accessibility and end-to-end tests plus observability.

## Product boundaries

Salu is a marketplace and coordination platform. Independent third parties deliver services. Atlas is not a physician and does not diagnose, prescribe or replace professional care. Clinical services must be performed by appropriately qualified independent providers. Salu does not process insurance and this MVP stores no medical records. Users should call 911 or seek appropriate urgent professional care for emergencies.
