import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const wrangler=await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8");
const workflow=await readFile(new URL("../.github/workflows/deploy.yml",import.meta.url),"utf8");
const vite=await readFile(new URL("../vite.config.ts",import.meta.url),"utf8");
const deployDocs=await readFile(new URL("../DEPLOY.md",import.meta.url),"utf8");
const cutover=await readFile(new URL("../CUTOVER.md",import.meta.url),"utf8");
const wranglerJson=JSON.parse(wrangler.replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,""));

test("ships a production Worker config that lets vinext own member routes",()=>{
 assert.equal(wranglerJson.name,"salu");
 assert.equal(wranglerJson.main,"./worker/index.ts");
 assert.deepEqual(wranglerJson.compatibility_flags,["nodejs_compat"]);
 assert.equal(wranglerJson.assets.not_found_handling,"none");
 assert.equal(wranglerJson.assets.binding,"ASSETS");
 assert.equal(wranglerJson.images.binding,"IMAGES");
 assert.equal(wranglerJson.workers_dev,true);
 assert.equal(wranglerJson.keep_vars,true);
 assert.equal(wranglerJson.routes,undefined);
 assert.equal(wranglerJson.route,undefined);
 assert.doesNotMatch(JSON.stringify(wranglerJson),/joinsalu\.com/);
 assert.notEqual(wranglerJson.assets.not_found_handling,"single-page-application");
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
