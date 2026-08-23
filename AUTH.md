# Salu authentication

Salu members and providers create an account with **email and password** from a **popup** over the browsable member shell. Google and Apple stay as optional shortcuts when their apps exist. Sessions are Auth.js JWTs (`@auth/core`) on vinext / Cloudflare Workers. Member rows persist to D1 when the `DB` binding exists. Password hashes live in `member_credentials` (same D1 / in-memory honesty pattern as members).

## Why Auth.js (not Better Auth or Clerk)

| Option | Fit for this stack |
| --- | --- |
| **Auth.js `@auth/core`** | Portable Web `Request`/`Response` engine. Official Google + Apple providers. JWT sessions compile and run without D1 or live OAuth secrets. `trustHost` is the Cloudflare pattern. |
| Better Auth | Excellent with Drizzle/D1, but it expects a database adapter at boot. D1 is only now being bound, and CI/local checks must pass without a provisioned database. |
| Clerk | Hosted SaaS. A Clerk app and live keys are required before the integration is useful, which breaks the “no live secrets to compile/test” rule. |
| `next-auth` helpers | Vinext is Vite + Cloudflare Workers with Next-like routes, not Next.js. `@auth/core` is the layer that actually runs here. |

ChatGPT / OpenAI Sites headers (`oai-authenticated-user-*`) still count as a session when present.

## Native email and password

This is the real non-OAuth path in production. No extra env keys. `AUTH_SECRET` still signs the JWT (the repo stub is fine locally).

| Step | Path |
| --- | --- |
| Create account | `POST /api/auth/register` with `{ email, password, displayName }` |
| Sign in | Auth.js Credentials provider `credentials` → `/api/auth/signin/credentials` |
| Surfaces | `/signin` (members) and `/provider/signin` (providers). Same identity. Role still comes from approved Apply, `SALU_PROVIDER_EMAILS`, or the labeled Tide & Tone demo. |

Safeguards shipped with the MVP:

- Email is trimmed and lowercased.
- Passwords need at least 8 characters (max 128).
- Hashes are **PBKDF2-SHA-256** via Web Crypto (`pbkdf2-sha256$210000$salt$hash`). bcrypt / argon2 / Node `scrypt` need native or WASM bindings that are a poor fit for Cloudflare Workers; WebCrypto is what Workers actually accelerate.
- Login errors stay generic (`We couldn’t sign you in with those details.`). Register does not confirm that an email already exists.
- In-isolate rate limits on register (6 / 15 min) and login (8 / 15 min) per IP + email. This is best-effort until KV exists.

**Password reset later.** There is no email provider in this repo, so a reset-token mailer would need new secrets. `/signin` says reset is not available yet. A token table can land later without changing `member_credentials`.

## When Daniel must create the apps

You do **not** need Google or Apple to run `pnpm dev`, `pnpm test`, `pnpm lint`, or `pnpm exec tsc --noEmit`, or for a member to sign in with email.

1. **Local walkthrough today** — create an email account on `/signin`, or use the labeled **Continue with a local preview** control (development only).
2. **Google / Apple are deferred.** The buttons stay on the sign-in screen as optional shortcuts and say **coming soon** until keys exist. You do not need to configure OAuth to ship email/password.
3. **Hosted deploy** — set `AUTH_SECRET` on Cloudflare / OpenAI hosting. Production builds never show the development bypass. Email/password is the live sign-in path. Add Google / Apple keys later if you want those shortcuts.

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
| `SALU_PROVIDER_EMAILS` | Provider workspace | Optional comma-separated emails (native, Google, or Apple) that open `/provider` as Tide & Tone until an approved Apply row exists. See [PROVIDER.md](./PROVIDER.md). |
| `SALU_ADMIN_EMAILS` | Admin review queue | Comma-separated staff emails that may open `/admin` and call application list/status APIs. Production fails closed when empty. See [PROVIDERS.md](./PROVIDERS.md). |

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

Production deploys go to Cloudflare Worker `salu` via GitHub Actions ([DEPLOY.md](./DEPLOY.md)). Do **not** commit auth keys.

On Cloudflare: Workers & Pages → **salu** → Settings → Variables and Secrets. Prefer secrets. `AUTH_URL` is `https://salu.<subdomain>.workers.dev` until cutover, then `https://joinsalu.com` ([CUTOVER.md](./CUTOVER.md)).

OpenAI Sites can still run local / Codex previews. `.openai/hosting.json` binds D1 as `DB` for that path. CI production builds set `SALU_ENABLE_SITES=0` and do not need Sites credentials.

Also set:

```text
AUTH_URL=https://joinsalu.com
AUTH_SECRET=<production secret, not the stub>
```

Use the `workers.dev` origin for `AUTH_URL` until [CUTOVER.md](./CUTOVER.md). After cutover, confirm:

- `https://joinsalu.com/signin`
- `https://joinsalu.com/api/auth/csrf` returns JSON
- Google/Apple callbacks are exactly `/api/auth/callback/google` and `/api/auth/callback/apple`
- Email/password create + sign-in works without Google or Apple keys

Until Google / Apple keys exist, `/signin` still renders; those buttons stay labeled as unconfigured. Email/password is the live non-OAuth path.

## Development bypass

Shown only when `NODE_ENV` is not `production`. Labeled **Development only · labeled bypass · not a live membership**. `/admin` also offers **Continue as Salu admin** (`admin@localhost`) so local review still works without Google. Production builds never register those providers. Native email/password stays registered in production.

## Routes

| Path | Role |
| --- | --- |
| `/signin` | Deep link that opens the member shell with the sign-in popup |
| `/provider/signin` | Provider sign-in (same Auth.js; demo Tide & Tone in development) |
| `/admin` | Staff review queue. Requires a signed-in email on `SALU_ADMIN_EMAILS`. |
| `/api/auth/register` | Native account create (JSON). Then the client signs in through Auth.js. |
| `/api/auth/*` | Auth.js (signin, callback, signout, csrf, session) including `credentials` |
| `/api/me` | Combined member + provider + admin session (Auth.js JWT + ChatGPT headers + provider/admin flags) |

## Browse first

The member shell is **not** a sign-in wall. Home, Atlas, Explore, Plans, About, Apply, and the other public member routes render for anonymous visitors. They see a labeled **Browsing Salu** mode — not a fake logged-in member. A Sign in control (header, banner, or `/signin`) opens a hospitality **popup** over the same shell.

Actions that need identity — book, buy Credits, manage profile, start a paid membership, provider workspace, admin — prompt that popup, then continue. `/signin` stays as a deep link; it opens the same modal rather than blocking the homepage. Email and password are the primary fields. Google and Apple stay optional shortcuts and say **coming soon** until their apps exist. Development still offers the labeled local preview.

`/provider` keeps the labeled demo plus application lookup until a provider session exists. `/admin` and the application list/status APIs require a signed-in session whose email is on `SALU_ADMIN_EMAILS`. Unauthenticated visitors opening `/admin` still see staff sign-in; signed-in non-staff see **Not authorized** and never receive queue data. Development can use the labeled **Continue as Salu admin** bypass (`admin@localhost`); production builds never register that provider. See [PROVIDERS.md](./PROVIDERS.md) and [PROVIDER.md](./PROVIDER.md).

## Member storage

`domain/types.ts` `Member` is the contract. `db/schema.ts` maps it onto D1 (`members`, `member_accounts`, `member_credentials`). `auth/members.ts` and `auth/credentials.ts` upsert to D1 when `env.DB` is bound, otherwise an in-process store so tests and secret-less builds still run.

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0006_credentials.sql
```

The Worker also `CREATE TABLE IF NOT EXISTS member_credentials` on first use.
