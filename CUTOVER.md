# Cutover: joinsalu.com → Worker `salu`

This is the only step that can take **joinsalu.com** off Codex Sites. Do it after the parallel Worker is verified on `workers.dev` ([DEPLOY.md](./DEPLOY.md)).

Attaching the custom domain is the switch. A normal `wrangler deploy` does **not** move the hostname.

## Before you start

- [ ] `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are in GitHub Actions secrets
- [ ] **Actions → Deploy** has succeeded on `main` (or a manual `workflow_dispatch`)
- [ ] `https://salu.<subdomain>.workers.dev` serves Home, `/about`, `/atlas`, `/explore`, `/signin`
- [ ] You recorded today’s production DNS (see below) so you can roll back
- [ ] Optional: production `AUTH_SECRET` / Google / Apple secrets are on Worker `salu`, and `AUTH_URL` will be set to `https://joinsalu.com` **at cutover** (not before, if those OAuth clients only allow the production origin)

### Record current DNS

Cloudflare Dashboard → **joinsalu.com** → **DNS → Records**. Note the apex (`joinsalu.com`) and `www` records (type, target, proxy status). Codex Sites typically owns a proxied CNAME or a Custom Domain on a Sites/Workers project. Do not delete mail (MX) or verification (TXT) records.

## Cutover checklist

1. **Freeze Sites publishes**  
   Do not click deploy in ChatGPT Sites while you switch. The next publish from Sites can steal the hostname back.

2. **Set production auth origin on the Worker**  
   Workers & Pages → **salu** → Settings → Variables and Secrets:
   - `AUTH_URL=https://joinsalu.com`
   - Production `AUTH_SECRET` (not the repo stub)
   - Google / Apple keys if members should sign in immediately  
   Confirm Google/Apple authorized origins and redirect URIs still include `https://joinsalu.com` and `/api/auth/callback/google` / `/api/auth/callback/apple` ([AUTH.md](./AUTH.md)).

3. **Remove the hostname from Codex Sites / the old project**  
   If `joinsalu.com` is attached as a Custom Domain on the Sites project (or another Worker), remove it there first. Cloudflare will not attach the same hostname to two Workers.

4. **Attach the custom domain to Worker `salu`**  
   Workers & Pages → **salu** → **Domains** (or Settings → Domains & Routes) → **Add → Custom Domain** → `joinsalu.com`.  
   Repeat for `www.joinsalu.com` if you serve www.  
   Cloudflare creates the DNS record. You should **not** add `joinsalu.com` to `wrangler.jsonc` in this repo (keeps future CI deploys from fighting the dashboard).

5. **Resolve DNS conflicts**  
   If add-domain fails because a CNAME already exists, delete that **site** CNAME (the one pointing at Sites / the old target) and retry. Leave MX/TXT alone.

6. **Verify production**

   ```bash
   curl -sI https://joinsalu.com/ | head
   curl -sI https://joinsalu.com/about | head
   curl -sI https://joinsalu.com/atlas | head
   curl -sI https://joinsalu.com/explore | head
   curl -sI https://joinsalu.com/signin | head
   curl -s https://joinsalu.com/api/auth/csrf
   ```

   Expect Salu HTML (or `/signin` for gated pages), `server: cloudflare`, and CSRF JSON. Hard-refresh the browser and walk Home → Atlas → Explore → About.

7. **Confirm CI is the publisher**  
   Make a no-op or real push to `main` and confirm Actions → Deploy succeeds. Do not publish from ChatGPT Sites anymore.

## Rollback

1. Workers & Pages → **salu** → Domains → remove `joinsalu.com` (and `www` if added).
2. Re-attach `joinsalu.com` on the Codex Sites project, **or** restore the DNS records you copied earlier (proxied CNAME to the previous target).
3. Confirm `https://joinsalu.com/` is the Sites build again.
4. Leave Worker `salu` on `workers.dev` so you can retry.

## After cutover

- Ship by merging to `main`. GitHub Actions runs `pnpm build` and `wrangler deploy`.
- Keep [DEPLOY.md](./DEPLOY.md) token permissions as-is; no extra DNS permission is required for routine deploys.
- Codex / local `pnpm dev` can still use the Sites vite plugin. Production CI sets `SALU_ENABLE_SITES=0`.
