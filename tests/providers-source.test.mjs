import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const app = await readFile(new URL("../components/SaluApp.tsx", import.meta.url), "utf8");
const signIn = await readFile(new URL("../components/SignIn.tsx", import.meta.url), "utf8");
const config = await readFile(new URL("../auth/config.ts", import.meta.url), "utf8");
const routes = await readFile(new URL("../domain/routes.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const providersMd = await readFile(new URL("../PROVIDERS.md", import.meta.url), "utf8");
const authMd = await readFile(new URL("../AUTH.md", import.meta.url), "utf8");
const providerMd = await readFile(new URL("../PROVIDER.md", import.meta.url), "utf8");
const bookingsMd = await readFile(new URL("../BOOKINGS.md", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0003_provider_applications.sql", import.meta.url), "utf8");
const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");

test("wires Apply, catalog, and admin pipeline APIs with a labeled demo catalog", () => {
  for (const term of [
    "/api/providers/apply",
    "/api/providers/catalog",
    "/api/providers/applications",
    "INDEPENDENT PROVIDERS · FROM THE BD PIPELINE",
    "AT-HOME SERVICES · DEMO CATALOG",
    "INDEPENDENT EXPERTS · FABRICATED DEMO",
    "Submit application",
    "Florida license number",
    "Mobile / at-home",
    "Miami pipeline",
  ]) {
    assert.match(app, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(worker, /\/api\/providers/);
  assert.match(schema, /export const providerApplications/);
  assert.match(migration, /CREATE TABLE `provider_applications`/);
  assert.match(example, /SALU_ADMIN_EMAILS/);
  assert.match(example, /SALU_OPS_SECRET/);
});

test("gates /admin and application list/status behind an allowlisted session", () => {
  assert.match(app, /page==="admin"&&!admin/);
  assert.match(app, /<AdminForbidden go=\{go\} signOut=\{signOut\}\/>/);
  assert.match(signIn, /Staff sign-in for the review queue/);
  assert.match(signIn, /Continue as Salu admin/);
  assert.match(signIn, /Not authorized/);
  assert.match(config, /id: "admin-development"/);
  assert.match(routes, /publicPages: Page\[\] = \["signin","provider-apply","provider","provider-signin"\]/);
  assert.doesNotMatch(routes, /publicPages: Page\[\] = \[[^\]]*admin/);
  assert.match(app, /LIVE REVIEW QUEUE/);
  assert.match(app, /APPROVAL QUEUE · DEMO/);
  for (const term of ["SALU_ADMIN_EMAILS", "fails closed", "Not authorized", "APPROVAL QUEUE · DEMO"]) {
    assert.match(providersMd, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(authMd, /SALU_ADMIN_EMAILS/);
  assert.match(providerMd, /SALU_ADMIN_EMAILS/);
});

test("documents BD vs eng and what stays demo", () => {
  for (const term of [
    "Head of BD",
    "individual",
    "LMT",
    "License number",
    "submitted",
    "under_review",
    "approved",
    "rejected",
    "drizzle/0003_provider_applications.sql",
    "docs",
    "Stripe Connect",
    "demo catalog",
  ]) {
    assert.match(providersMd, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(bookingsMd, /PROVIDERS\.md/);
  assert.match(bookingsMd, /Head of BD owns the Miami supplier pipeline/);
});
