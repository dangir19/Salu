# Deploy Salu on Cloudflare Workers

Production today is **joinsalu.com** via Codex Sites, with Cloudflare already in front. This repo deploys a **parallel** Worker named `salu` so Daniel (and COO via cloud agents) can ship from GitHub without opening ChatGPT Sites.

Do **not** point `joinsalu.com` at the new Worker until [CUTOVER.md](./CUTOVER.md).

## What ships

| Item | Value |
| --- | --- |
| Worker name | `salu` |
| Config | [`wrangler.jsonc`](./wrangler.jsonc) |
| Entry | `worker/index.ts` (vinext App Router + `/api/auth` + `/api/me` + payments + bookings + Atlas + providers + provider) |
| Preview URL | `https://salu.<your-subdomain>.workers.dev` after the first deploy |
| Trigger | Push / merge to `main`, or **Actions → Deploy → Run workflow** |

CI runs `pnpm build` with `SALU_ENABLE_SITES=0`. The Codex Sites vite plugin and `.openai/hosting.json` stay available for local / Codex previews only.

## One-time Cloudflare setup

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) → the account that already proxies `joinsalu.com`.
2. Copy **Account ID** (Workers & Pages overview, right sidebar).
3. Create an API token:
   - **My Profile → API Tokens → Create Token**
   - Easiest: use the **Edit Cloudflare Workers** template.
   - Or a custom token with the permissions below.
   - Account resources: include this Cloudflare account.
4. You do **not** need to create the Worker by hand. The first `wrangler deploy` creates `salu`.

### API token permissions

**Minimum for this workflow** (build + deploy the `salu` script to `workers.dev`):

| Scope | Permission | Why |
| --- | --- | --- |
| Account | **Workers Scripts — Edit** | Upload / overwrite the Worker |
| Account | **Account Settings — Read** | Resolve the account when `CLOUDFLARE_ACCOUNT_ID` is set |
| User | **User Details — Read** | `wrangler` whoami / token checks |

**Recommended** (matches Cloudflare’s **Edit Cloudflare Workers** template, and covers a later custom-domain or D1 step):

| Scope | Permission |
| --- | --- |
| Account | Workers Scripts — Edit |
| Account | Account Settings — Read |
| Account | D1 — Edit (only needed when you create/bind the `salu` database) |
| User | User Details — Read |
| Zone | Workers Routes — Edit on the `joinsalu.com` zone (only if you attach routes via API; dashboard custom domains use your login) |

Do not use the Global API Key. Paste the token only into GitHub Actions secrets.

## GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Paste |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token from the previous section |
| `CLOUDFLARE_ACCOUNT_ID` | 32-character account id from the Workers overview |

These are the only secrets required for a Worker to appear on `*.workers.dev`. Daniel pastes them; this repo never stores the token.

### Auth secrets (already documented in AUTH.md)

Google / Apple sign-in is **not** configured by this deploy PR. After the Worker exists, copy the same keys you would set on Sites onto **this** Worker (Workers → `salu` → Settings → Variables and Secrets), or add them as GitHub secrets and `wrangler secret put` once:

- `AUTH_SECRET` — production value from `openssl rand -base64 32`, **not** the repo stub
- `AUTH_URL` — `https://salu.<subdomain>.workers.dev` for the first test; `https://joinsalu.com` after cutover
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`
- `AUTH_APPLE_ID` plus `AUTH_APPLE_SECRET` or the Team/Key/`.p8` trio

`wrangler.jsonc` sets `keep_vars: true` so dashboard values survive later CI deploys. Prefer **secrets** over plaintext vars.

Until those keys exist, `/signin` still renders; Continue with Google / Apple stay labeled as unconfigured. Email/password works without them. Production builds never show the local preview bypass.

## First deploy (manual `workflow_dispatch`)

Do this **before** merging is required to trust main, and **before** DNS cutover.

1. Confirm the two Cloudflare secrets are present.
2. GitHub → **Actions → Deploy → Run workflow** → branch `main` (or this PR branch if you want a dry run of the job; the Worker name is still `salu`).
3. Open the job log. Wrangler prints `https://salu.<subdomain>.workers.dev`.
4. Verify (see below). Leave `joinsalu.com` on Codex Sites.

A merge to `main` after secrets exist will deploy the same way automatically.

## Verify the Worker

From the `workers.dev` URL (not joinsalu.com):

```bash
curl -sI https://salu.<subdomain>.workers.dev/ | head
curl -sI https://salu.<subdomain>.workers.dev/about | head
curl -sI https://salu.<subdomain>.workers.dev/atlas | head
curl -sI https://salu.<subdomain>.workers.dev/explore | head
curl -sI https://salu.<subdomain>.workers.dev/signin | head
```

Expect `200` — not Cloudflare’s generic 404. Unknown paths such as `/not-a-real-page` should render Salu’s “This page isn’t on the map” 404. `/admin` still requires a staff session.

In a browser: Home, Atlas, Explore, About, and Plans should load **without** signing in. Sign-in is a popup (or `/signin` as a deep link). Static assets (`/favicon.svg`, CSS, fonts) should 200.

If Google/Apple apps are already created, add the workers.dev origin and `/api/auth/callback/google` (and Apple return URL) as extra authorized URLs for this preview only. After cutover, production callbacks stay on `https://joinsalu.com/api/auth/callback/...` as in AUTH.md.

## Optional: D1 for member rows

Auth.js JWTs work without D1. When `DB` is unbound, members stay in-process (see AUTH.md). To persist members on this Worker:

```bash
pnpm exec wrangler d1 create salu
```

Put the printed `database_id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "salu",
    "database_id": "<id from wrangler d1 create>"
  }
]
```

Then apply the checked-in migration and redeploy:

```bash
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0000_members.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0001_payments.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0002_bookings.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0003_provider_applications.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0004_provider_workspace.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0005_connect.sql
pnpm exec wrangler d1 execute salu --remote --file=drizzle/0006_credentials.sql
pnpm deploy
```

The token needs **Account → D1 → Edit** for these commands. Codex Sites can keep using the `DB` binding in `.openai/hosting.json` independently.

## Local and Codex

```bash
pnpm install
cp .env.example .env   # optional; also valid as .dev.vars
pnpm dev
```

Local / Codex builds still load the Sites vite plugin (copies `.openai/hosting.json` + drizzle into `dist/.openai`) unless `CI=true` or `SALU_ENABLE_SITES=0`. No Sites credentials are required to compile.

```bash
SALU_ENABLE_SITES=0 pnpm build   # same path CI uses
pnpm deploy                      # wrangler deploy; needs a token on your machine
```

## How this replaces Codex Sites

| | Codex Sites (current production) | This Worker (new) |
| --- | --- | --- |
| Trigger | Publish from ChatGPT Sites | Push to `main` / Actions |
| Config | `.openai/hosting.json` `project_id` | `wrangler.jsonc` name `salu` |
| URL | `joinsalu.com` until cutover | `salu.<subdomain>.workers.dev`, then `joinsalu.com` |
| App | Same vinext Worker (`worker/index.ts`) | Same |

After cutover (CUTOVER.md), stop using ChatGPT Sites to publish. The Sites project can stay as a fallback until you are confident; just do not publish over the live hostname.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Deploy job: “No account id found” | Missing `CLOUDFLARE_ACCOUNT_ID` |
| Deploy job: Authentication error | Token missing **Workers Scripts — Edit**, or wrong account |
| `/about` is a generic Cloudflare 404 | Worker did not receive the request (`not_found_handling` must stay `none`) |
| Auth callbacks fail on workers.dev | `AUTH_URL` still `https://joinsalu.com`, or OAuth app missing the workers.dev redirect |
| Dashboard AUTH_* disappeared after deploy | Use secrets, not vars; `keep_vars` is already on |
