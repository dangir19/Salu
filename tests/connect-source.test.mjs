import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const connectMd = await readFile(new URL("../CONNECT.md", import.meta.url), "utf8");
const stripeMd = await readFile(new URL("../STRIPE.md", import.meta.url), "utf8");
const app = await readFile(new URL("../components/SaluApp.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0005_connect.sql", import.meta.url), "utf8");
const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");

test("documents Express onboarding, transfers, and webhook events for Daniel", () => {
  for (const term of [
    "Stripe Connect Express",
    "Separate charges and transfers",
    "destination charges",
    "account.updated",
    "transfer.created",
    "Set up payouts",
    "Payouts enabled",
    "STRIPE_CONNECT_CLIENT_ID",
    "https://joinsalu.com/api/stripe/webhook",
    "customer liabilities",
    "PlatformCommission",
  ]) {
    assert.match(connectMd, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(stripeMd, /account.updated/);
  assert.match(example, /STRIPE_CONNECT_CLIENT_ID/);
});

test("wires Connect APIs, provider payouts UI, and D1 tables", () => {
  assert.match(app, /\/api\/connect\/me/);
  assert.match(app, /\/api\/connect\/onboard/);
  assert.match(app, /Set up payouts/);
  assert.match(app, /Payouts enabled/);
  assert.match(app, /Not connected/);
  assert.match(worker, /\/api\/connect/);
  assert.match(schema, /export const providers/);
  assert.match(schema, /stripeConnectAccountId/);
  assert.match(schema, /export const providerPayouts/);
  assert.match(migration, /CREATE TABLE `providers`/);
  assert.match(migration, /CREATE TABLE `provider_payouts`/);
});
