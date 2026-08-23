import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const envFile = await readFile(new URL("../auth/env.ts", import.meta.url), "utf8");
const config = await readFile(new URL("../auth/config.ts", import.meta.url), "utf8");
const identity = await readFile(new URL("../auth/identity.ts", import.meta.url), "utf8");
const types = await readFile(new URL("../domain/types.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const payments = await readFile(new URL("../domain/payments.ts", import.meta.url), "utf8");
const signIn = await readFile(new URL("../components/SignIn.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../components/SaluApp.tsx", import.meta.url), "utf8");
const authMd = await readFile(new URL("../AUTH.md", import.meta.url), "utf8");
const payMd = await readFile(new URL("../NEXT_PAYMENTS.md", import.meta.url), "utf8");
const stripeMd = await readFile(new URL("../STRIPE.md", import.meta.url), "utf8");
const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");

test("documents Auth.js and the exact env keys Daniel must set", () => {
  for (const term of [
    "AUTH_SECRET",
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
    "AUTH_APPLE_ID",
    "AUTH_APPLE_SECRET",
    "AUTH_APPLE_TEAM_ID",
    "AUTH_APPLE_KEY_ID",
    "AUTH_APPLE_PRIVATE_KEY",
    "Why Auth.js",
    "Services ID",
    "OAuth client ID",
  ]) {
    assert.match(authMd, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const key of ["AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_APPLE_ID", "SALU_ADMIN_EMAILS"]) {
    assert.match(example, new RegExp(key));
  }
});

test("registers Google, Apple and a development-only bypass", () => {
  assert.match(config, /from "@auth\/core\/providers\/google"/);
  assert.match(config, /from "@auth\/core\/providers\/apple"/);
  assert.match(config, /id: "development"/);
  assert.match(config, /id: "provider-development"/);
  assert.match(config, /if \(surface\.development\)/);
  assert.match(envFile, /DEV_AUTH_SECRET/);
  assert.match(envFile, /isProductionEnv/);
  assert.match(envFile, /nodeEnv === "production"/);
  assert.match(signIn, /Continue with Google/);
  assert.match(signIn, /Continue with Apple/);
  assert.match(signIn, /coming soon/);
  assert.match(signIn, /signin-soon/);
  assert.match(signIn, /Development only/);
});

test("ships native email and password as the primary Auth.js path", () => {
  assert.match(config, /id: "credentials"/);
  assert.match(config, /verifyNativeLogin/);
  assert.match(schema, /sqliteTable\("member_credentials"/);
  assert.match(signIn, /Sign in with email/);
  assert.match(signIn, /Create account/);
  assert.match(signIn, /\/api\/auth\/register/);
  assert.match(signIn, /Forgot your password/);
  assert.match(authMd, /Native email and password/);
  assert.match(authMd, /PBKDF2-SHA-256/);
  assert.match(authMd, /Password reset later/);
  assert.match(authMd, /\/api\/auth\/register/);
  assert.match(example, /Native email\/password accounts need no extra keys/);
});

test("maps sessions onto the Member domain contract and D1 tables", () => {
  assert.match(types, /export type Member=\{id:ID;email:string;displayName:string/);
  assert.match(types, /authProvider\?:AuthProvider/);
  assert.match(identity, /planId: "member"/);
  assert.match(schema, /sqliteTable\("members"/);
  assert.match(schema, /member_accounts/);
  assert.match(payments, /getDefaultPaymentMethod/);
  assert.match(payments, /return null/);
  assert.match(payMd, /Stripe Connect/);
  assert.match(stripeMd, /Stripe Billing/);
  assert.match(stripeMd, /joinsalu.com\/api\/stripe\/webhook/);
});

test("gates the member shell and stops pretending a Visa is live", () => {
  assert.match(app, /isMemberShell\(page\)/);
  assert.match(app, /<SignIn returnTo=\{returnTo\} surface=\{surface\}\/>/);
  assert.match(app, /PAYMENT_PLACEHOLDER/);
  assert.doesNotMatch(app, /Visa •••• 4242/);
  assert.doesNotMatch(app, /name\.trim\(\)\.toLowerCase\(\)==="daniel"\?"DG"/);
  assert.match(signIn, /Come in\. We’ll take it from here\./);
});
