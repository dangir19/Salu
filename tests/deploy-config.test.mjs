import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const wrangler=await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8");
const workflow=await readFile(new URL("../.github/workflows/deploy.yml",import.meta.url),"utf8");
const vite=await readFile(new URL("../vite.config.ts",import.meta.url),"utf8");
const deployDocs=await readFile(new URL("../DEPLOY.md",import.meta.url),"utf8");
const cutover=await readFile(new URL("../CUTOVER.md",import.meta.url),"utf8");

test("ships a production Worker config that lets vinext own member routes",()=>{
 assert.match(wrangler,/"name":\s*"salu"/);
 assert.match(wrangler,/"main":\s*"\.\/worker\/index\.ts"/);
 assert.match(wrangler,/"compatibility_flags":\s*\[["']nodejs_compat["']\]/);
 assert.match(wrangler,/"not_found_handling":\s*"none"/);
 assert.match(wrangler,/"binding":\s*"ASSETS"/);
 assert.match(wrangler,/"binding":\s*"IMAGES"/);
 assert.match(wrangler,/"workers_dev":\s*true/);
 assert.match(wrangler,/"keep_vars":\s*true/);
 assert.doesNotMatch(wrangler,/joinsalu\.com/);
 assert.doesNotMatch(wrangler,/single-page-application/);
});

test("deploys from GitHub Actions with the documented Cloudflare secrets",()=>{
 assert.match(workflow,/branches:\s*\[main\]/);
 assert.match(workflow,/workflow_dispatch:/);
 assert.match(workflow,/SALU_ENABLE_SITES:\s*"0"/);
 assert.match(workflow,/pnpm install --frozen-lockfile/);
 assert.match(workflow,/pnpm build/);
 assert.match(workflow,/cloudflare\/wrangler-action@v4/);
 assert.match(workflow,/secrets\.CLOUDFLARE_API_TOKEN/);
 assert.match(workflow,/secrets\.CLOUDFLARE_ACCOUNT_ID/);
 assert.match(workflow,/github\.event_name == 'workflow_dispatch'/);
});

test("keeps Codex Sites plugin off the CI production build path",()=>{
 assert.match(vite,/SALU_ENABLE_SITES/);
 assert.match(vite,/process\.env\.CI === "true"/);
 assert.match(vite,/build\/sites-vite-plugin/);
 assert.match(deployDocs,/CLOUDFLARE_API_TOKEN/);
 assert.match(deployDocs,/Workers Scripts — Edit/);
 assert.match(cutover,/joinsalu\.com/);
 assert.match(cutover,/workers\.dev/);
});
