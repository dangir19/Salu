import type {PaymentsSurface} from "../domain/types";
import {isPaidPlanId, type PaidPlanId} from "./catalog";

export type StripeEnv = {
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_GOLD_PRICE_ID: string;
  STRIPE_PLATINUM_PRICE_ID: string;
};

type EnvRecord = Record<string, string | undefined>;

function readValue(sources: EnvRecord[], key: string): string {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function tryProcessEnv(): EnvRecord {
  return (globalThis as {process?: {env?: EnvRecord}}).process?.env ?? {};
}

export function readStripeEnv(overrides: EnvRecord = {}): StripeEnv {
  const sources = [overrides, tryProcessEnv()];
  return {
    STRIPE_SECRET_KEY: readValue(sources, "STRIPE_SECRET_KEY"),
    STRIPE_PUBLISHABLE_KEY: readValue(sources, "STRIPE_PUBLISHABLE_KEY"),
    STRIPE_WEBHOOK_SECRET: readValue(sources, "STRIPE_WEBHOOK_SECRET"),
    STRIPE_GOLD_PRICE_ID: readValue(sources, "STRIPE_GOLD_PRICE_ID"),
    STRIPE_PLATINUM_PRICE_ID: readValue(sources, "STRIPE_PLATINUM_PRICE_ID"),
  };
}

export function paymentsSurface(env: StripeEnv = readStripeEnv()): PaymentsSurface {
  return {
    stripe: Boolean(env.STRIPE_SECRET_KEY),
    goldPrice: Boolean(env.STRIPE_GOLD_PRICE_ID),
    platinumPrice: Boolean(env.STRIPE_PLATINUM_PRICE_ID),
    webhook: Boolean(env.STRIPE_WEBHOOK_SECRET),
    publishable: Boolean(env.STRIPE_PUBLISHABLE_KEY),
  };
}

export function isStripeReady(env: StripeEnv = readStripeEnv()): boolean {
  return paymentsSurface(env).stripe;
}

export function priceIdForPlan(env: StripeEnv, planId: PaidPlanId): string {
  return planId === "gold" ? env.STRIPE_GOLD_PRICE_ID : env.STRIPE_PLATINUM_PRICE_ID;
}

export function planIdFromPriceId(env: StripeEnv, priceId: string | null | undefined): PaidPlanId | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_GOLD_PRICE_ID) return "gold";
  if (priceId === env.STRIPE_PLATINUM_PRICE_ID) return "platinum";
  return isPaidPlanId(priceId) ? priceId : null;
}

export function applyStripeEnvToProcess(env: StripeEnv): void {
  process.env.STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY;
  process.env.STRIPE_PUBLISHABLE_KEY = env.STRIPE_PUBLISHABLE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_GOLD_PRICE_ID = env.STRIPE_GOLD_PRICE_ID;
  process.env.STRIPE_PLATINUM_PRICE_ID = env.STRIPE_PLATINUM_PRICE_ID;
}
