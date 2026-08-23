import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const app = await readFile(new URL("../components/SaluApp.tsx", import.meta.url), "utf8");
const workspace = await readFile(new URL("../components/ProviderWorkspace.tsx", import.meta.url), "utf8");
const signIn = await readFile(new URL("../components/SignIn.tsx", import.meta.url), "utf8");
const config = await readFile(new URL("../auth/config.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const providerMd = await readFile(new URL("../PROVIDER.md", import.meta.url), "utf8");
const bookingsMd = await readFile(new URL("../BOOKINGS.md", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0004_provider_workspace.sql", import.meta.url), "utf8");
const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const routes = await readFile(new URL("../domain/routes.ts", import.meta.url), "utf8");

test("wires provider sign-in, live queue APIs, and a labeled demo fallback", () => {
  for (const term of [
    "/api/provider/requests",
    "/api/provider/requests/accept",
    "/api/provider/requests/decline",
    "/api/provider/requests/propose",
    "/api/provider/schedule",
    "Continue as Tide & Tone",
    "TIDE & TONE RECOVERY · FABRICATED DEMO",
    "Labeled demo · sign in as a provider",
    "IN-APP QUEUE",
  ]) {
    assert.match(app + workspace + signIn, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(config, /id: "provider-development"/);
  assert.match(worker, /\/api\/provider\//);
  assert.doesNotMatch(worker, /pathname\.startsWith\("\/api\/provider"\)(?!\/)/);
  assert.match(schema, /export const appointmentRequests/);
  assert.match(schema, /export const providerAccounts/);
  assert.match(schema, /export const providerAssignments/);
  assert.match(schema, /export const providerBlocks/);
  assert.match(migration, /CREATE TABLE `appointment_requests`/);
  assert.match(example, /SALU_PROVIDER_EMAILS/);
  assert.match(routes, /\/provider\/signin/);
  assert.match(app, /Awaiting provider/);
});

test("documents what works without Connect", () => {
  for (const term of [
    "role=provider",
    "Continue as Tide & Tone",
    "drizzle/0004_provider_workspace.sql",
    "appointment_requests",
    "in-app queue",
    "Stripe Connect",
    "demo",
  ]) {
    assert.match(providerMd, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(bookingsMd, /PROVIDER\.md/);
});
