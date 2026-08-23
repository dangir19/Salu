import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const stripeMd = await readFile(new URL("../STRIPE.md", import.meta.url), "utf8");
const nextPay = await readFile(new URL("../NEXT_PAYMENTS.md", import.meta.url), "utf8");
const connectMd = await readFile(new URL("../CONNECT.md", import.meta.url), "utf8");
const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const payments = await readFile(new URL("../domain/payments.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../components/SaluApp.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

test("documents Stripe Dashboard steps, webhook URL, and secrets for Daniel", () => {
  for (const term of [
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_GOLD_PRICE_ID",
    "STRIPE_PLATINUM_PRICE_ID",
    "https://joinsalu.com/api/stripe/webhook",
    "dashboard.stripe.com",
    "When Daniel must sign into Stripe",
    "Salu Gold",
    "Salu Platinum",
    "$200",
    "$500",
    "invoice.paid",
    "checkout.session.completed",
    "Stripe Connect",
    "customer liabilities",
  ]) {
    assert.match(stripeMd, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const key of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_GOLD_PRICE_ID",
    "STRIPE_PLATINUM_PRICE_ID",
    "STRIPE_CONNECT_CLIENT_ID",
  ]) {
    assert.match(example, new RegExp(key));
  }
});

test("documents Connect transfers and never treats wallet funding as revenue", () => {
  assert.match(nextPay, /Stripe Connect/);
  assert.match(nextPay, /customer liabilities/);
  assert.match(connectMd, /Separate charges and transfers/);
  assert.match(connectMd, /destination charges/);
  assert.match(connectMd, /account.updated/);
  assert.match(connectMd, /Set up payouts/);
  assert.match(payments, /getDefaultPaymentMethod/);
  assert.match(payments, /return null/);
  assert.match(payments, /Stripe Connect/);
});

test("wires Checkout, webhooks, and a labeled demo fallback", () => {
  assert.match(app, /\/api\/payments\/checkout/);
  assert.match(app, /\/api\/payments\/me/);
  assert.match(app, /Add 100 demo Credits/);
  assert.match(app, /Stripe Billing is not connected yet/);
  assert.match(app, /PAYMENT_PLACEHOLDER/);
  assert.match(worker, /\/api\/payments/);
  assert.match(worker, /\/api\/stripe/);
  assert.match(schema, /stripe_customer_id/);
  assert.match(schema, /credit_transactions/);
  assert.match(schema, /stripe_events/);
  assert.match(schema, /stripe_connect_account_id/);
  assert.match(app, /Set up payouts/);
});
