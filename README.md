# Salu MVP

Salu is a premium self-pay wellness, recovery and personal-care membership for Miami, positioned as **“Your health concierge.”** The experience feels closer to thoughtful hospitality than a healthcare portal. Atlas, its deterministic demo concierge, provides general wellness education and helps members discover, compare, schedule, reschedule and coordinate independent services.

## Run locally

Requirements: Node.js 22.13+ and pnpm.

```bash
pnpm install
pnpm dev
```

Then open the local URL printed by the development server. Production validation:

```bash
pnpm build
pnpm lint
pnpm exec tsc --noEmit
```

## Included flows

- Premium hospitality-led landing experience with Member (free, standard prices), Gold ($200/month, 10% off) and Platinum ($500/month, 20% off)
- Automatic month-to-month Credit rollover for Gold and Platinum, with no Credit loss
- Mock onboarding and funded Salu Credit wallet
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
  page.tsx            App entry
  globals.css         Core Salu hospitality design system
  extended*.css       Product surfaces and portals
  responsive.css      Modal, footer and mobile layouts
components/
  SaluApp.tsx         Full interactive application and action flows
domain/
  mock-data.ts        Miami services, packages, bookings and Atlas fixtures
  types.ts            Supabase/Stripe-ready domain contracts
db/                   D1/Drizzle starter persistence layer
worker/               Cloudflare-compatible worker entry
.openai/hosting.json  Sites deployment configuration
tests/                Render/build checks
```

The prototype uses React plus browser-local persistence so bookings, Credits and package sessions survive refreshes during local review. The contracts in `domain/types.ts` separate wallet transactions from package entitlements and gross member funding from platform commission revenue.

## Production next steps

1. Add a durable Supabase or D1 repository behind the domain contracts, migrations, row-level access controls and audit logging.
2. Replace demo onboarding with hosted authentication and server-enforced member accounts.
3. Connect Stripe Billing for recurring wallet funding and Stripe Connect for provider payouts; recognize commissions separately from customer wallet liabilities.
4. Implement a provider credential-review workflow; never treat prototype fields as verified.
5. Connect a real language model through a guarded Atlas orchestration layer with structured discovery, availability, booking, rescheduling and cancellation tools.
6. Add integration consent, token storage and official APIs for Runna/Strava/etc. only after partnership and privacy review.
7. Add provider onboarding, offer management, lab-order eligibility, and tightly bounded GLP-1-adjacent education without medication prescribing.
8. Add automated unit, integration, accessibility and end-to-end tests plus observability.

## Product boundaries

Salu is a marketplace and coordination platform. Independent third parties deliver services. Atlas is not a physician and does not diagnose, prescribe or replace professional care. Clinical services must be performed by appropriately qualified independent providers. Salu does not process insurance and this MVP stores no medical records. Users should call 911 or seek appropriate urgent professional care for emergencies.
