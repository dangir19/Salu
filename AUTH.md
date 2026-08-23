# Salu authentication

Salu members sign in with **Google** or **Apple**. Sessions are Auth.js JWTs (`@auth/core`) on vinext / Cloudflare Workers. Member rows persist to D1 when the `DB` binding exists.

## Why Auth.js (not Better Auth or Clerk)

| Option | Fit for this stack |
| --- | --- |
| **Auth.js `@auth/core`** | Portable Web `Request`/`Response` engine. Official Google + Apple providers. JWT sessions compile and run without D1 or live OAuth secrets. `trustHost` is the Cloudflare pattern. |
| Better Auth | Excellent with Drizzle/D1, but it expects a database adapter at boot. D1 is only now being bound, and CI/local checks must pass without a provisioned database. |
| Clerk | Hosted SaaS. A Clerk app and live keys are required before the integration is useful, which breaks the “no live secrets to compile/test” rule. |
| `next-auth` helpers | Vinext is Vite + Cloudflare Workers with Next-like routes, not Next.js. `@auth/core` is the layer that actually runs here. |

ChatGPT / OpenAI Sites headers (`oai-authenticated-user-*`) still count as a session when present.

## When Daniel must create the apps

Do this **before the first real member can sign in** on a hosted URL (joinsalu.com, a Cloudflare preview, or OpenAI Sites). You do **not** need these apps to run `pnpm dev`, `pnpm test`, `pnpm lint`, or `pnpm exec tsc --noEmit`.

1. **Local walkthrough today** — no Google or Apple app. Use the labeled **Continue with a local preview** control (development only).
2. **Google on localhost or production** — create the Google Cloud OAuth client *before* anyone clicks Continue with Google.
3. **Apple** — create the Apple Services ID *before* anyone clicks Continue with Apple. Apple rejects `http://` and `localhost`; use an `https://` host (production or a tunnel).
4. **Hosted deploy** — set the env keys on Cloudflare / OpenAI hosting *before* turning off the development bypass (it is already off when `NODE_ENV=production`).

## Environment keys

| Key | Required for | Notes |
| --- | --- | --- |
| `AUTH_SECRET` | All signed sessions | `openssl rand -base64 32`. The repo stub is `salu-dev-auth-secret-not-for-production-32b` and is **not** for production. |
| `AUTH_URL` | Hosted + local OAuth | Origin only, e.g. `https://joinsalu.com` or `http://localhost:5173`. |
| `AUTH_GOOGLE_ID` | Google | Also accepts `GOOGLE_CLIENT_ID`. |
| `AUTH_GOOGLE_SECRET` | Google | Also accepts `GOOGLE_CLIENT_SECRET`. |
| `AUTH_APPLE_ID` | Apple | Services ID, e.g. `com.joinsalu.web`. Also accepts `APPLE_CLIENT_ID`. |
| `AUTH_APPLE_SECRET` | Apple | JWT client secret from `npx auth add apple`, **or** generate from the next three keys. |
| `AUTH_APPLE_TEAM_ID` | Apple (alt) | 10-character Team ID. |
| `AUTH_APPLE_KEY_ID` | Apple (alt) | Key ID for the `.p8` Sign in with Apple key. |
| `AUTH_APPLE_PRIVATE_KEY` | Apple (alt) | Full `.p8` body. Use `\n` for newlines in env vars. |

Copy `.env.example` to `.env` for Vite, or `.dev.vars` for Wrangler.

## Google Cloud OAuth client

Create this when you want Continue with Google to work.

1. Open [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Create or select a project (e.g. `salu-membership`).
3. **APIs & Services → OAuth consent screen**.
   - User type: External.
   - App name: `Salu`.
   - Support email: yours.
   - Authorized domains: `joinsalu.com` (production).
   - Scopes: `openid`, `email`, `profile` (default).
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Name: `Salu Web`.
   - Authorized JavaScript origins:
     - `http://localhost:5173` (or the port `pnpm dev` prints)
     - `https://joinsalu.com`
   - Authorized redirect URIs:
     - `http://localhost:5173/api/auth/callback/google`
     - `https://joinsalu.com/api/auth/callback/google`
5. Copy Client ID → `AUTH_GOOGLE_ID`. Copy Client secret → `AUTH_GOOGLE_SECRET`.

If vinext prints a different local origin, add that origin and `/api/auth/callback/google` as well.

## Apple Services ID

Create this when you want Continue with Apple to work. Requires an [Apple Developer Program](https://developer.apple.com/programs/) membership.

1. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list).
2. **Identifiers → App IDs → Register** an App ID (explicit), enable **Sign in with Apple**. Example bundle: `com.joinsalu.app`.
3. **Identifiers → Services IDs → Register**. Example: `com.joinsalu.web`. Enable **Sign in with Apple → Configure**:
   - Primary App ID: the App ID from step 2.
   - Domains: `joinsalu.com`
   - Return URLs: `https://joinsalu.com/api/auth/callback/apple`
4. **Keys → Create** a key, enable **Sign in with Apple**, link the App ID, download the `.p8` once.
5. Set `AUTH_APPLE_ID` to the **Services ID** (`com.joinsalu.web`).
6. Either:
   - Run `npx auth add apple` and paste `AUTH_APPLE_SECRET`, or
   - Set `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID`, and `AUTH_APPLE_PRIVATE_KEY`.

Apple will not accept `http://localhost`. For a laptop test, put the same Services ID return URL on a public HTTPS tunnel and set `AUTH_URL` to that origin.

## Cloudflare / OpenAI hosting

Set the same keys as **Workers environment variables** / OpenAI Sites secrets. Do **not** commit them.

On Cloudflare: Workers & Pages → your Salu worker → Settings → Variables.

On OpenAI Sites: project secrets for this repo. `.openai/hosting.json` now binds D1 as `DB` so member rows can persist after deploy.

Also set:

```text
AUTH_URL=https://joinsalu.com
AUTH_SECRET=<production secret, not the stub>
```

After the first deploy, confirm:

- `https://joinsalu.com/signin`
- `https://joinsalu.com/api/auth/csrf` returns JSON
- Google/Apple callbacks are exactly `/api/auth/callback/google` and `/api/auth/callback/apple`

## Development bypass

Shown only when `NODE_ENV` is not `production`. Labeled **Development only · labeled bypass · not a live membership**. Production builds never register that provider.

## Routes

| Path | Role |
| --- | --- |
| `/signin` | Hospitality sign-in |
| `/api/auth/*` | Auth.js (signin, callback, signout, csrf, session) |
| `/api/me` | Combined member session (Auth.js JWT + ChatGPT headers + provider flags) |

Logged-out visitors hitting the member shell (`/`, `/atlas`, `/explore`, …) see `/signin` first. Provider/admin demos stay public.

## Member storage

`domain/types.ts` `Member` is the contract. `db/schema.ts` maps it onto D1 (`members`, `member_accounts`). `auth/members.ts` upserts to D1 when `env.DB` is bound, otherwise an in-process store so tests and secret-less builds still run.
