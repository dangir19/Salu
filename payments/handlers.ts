import {getMemberSession, getMePayload} from "../auth/session";
import type {PaymentMethod} from "../domain/types";
import {NotConfiguredError, startBillingPortal, startCheckout, type CheckoutRequest} from "./checkout";
import {applyStripeEnvToProcess, isStripeReady, paymentsSurface, readStripeEnv, type StripeEnv} from "./env";
import {getMemberBilling, rememberMember} from "./ledger";
import {paymentsConfigChecklist} from "./adminConfig";
import {verifyStripeSignature} from "./signature";
import {
  cardFromPaymentMethod,
  idFromExpandable,
  listCardPaymentMethods,
  retrieveCustomer,
  retrievePaymentMethod,
  type StripeEvent,
} from "./stripe";
import {applyStripeEvent} from "./webhooks";

type RuntimeEnv = Record<string, string | undefined>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

function stripeEnvFrom(request: Request, runtimeEnv: RuntimeEnv): StripeEnv {
  const env = readStripeEnv({
    ...runtimeEnv,
    STRIPE_SECRET_KEY: runtimeEnv.STRIPE_SECRET_KEY,
  });
  applyStripeEnvToProcess(env);
  void request;
  return env;
}

async function paymentMethodForMember(env: StripeEnv, customerId?: string): Promise<PaymentMethod | null> {
  if (!env.STRIPE_SECRET_KEY || !customerId) return null;
  try {
    const customer = await retrieveCustomer(env.STRIPE_SECRET_KEY, customerId);
    const defaultId = idFromExpandable(customer.invoice_settings?.default_payment_method);
    if (defaultId) {
      return cardFromPaymentMethod(await retrievePaymentMethod(env.STRIPE_SECRET_KEY, defaultId));
    }
    const methods = await listCardPaymentMethods(env.STRIPE_SECRET_KEY, customerId);
    return cardFromPaymentMethod(methods[0]);
  } catch {
    return null;
  }
}

export async function handlePaymentsFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const env = stripeEnvFrom(request, runtimeEnv);

  if (url.pathname === "/api/stripe/webhook") {
    return handleStripeWebhook(request, env);
  }
  if (url.pathname === "/api/payments/me") {
    return handlePaymentsMe(request, env);
  }
  if (url.pathname === "/api/payments/checkout" && request.method === "POST") {
    return handleCheckout(request, env);
  }
  if (url.pathname === "/api/payments/portal" && request.method === "POST") {
    return handlePortal(request, env);
  }
  if (url.pathname === "/api/payments/config") {
    return handlePaymentsConfig(request, env, runtimeEnv);
  }
  return new Response("Not found", {status: 404});
}

async function handlePaymentsMe(request: Request, env: StripeEnv): Promise<Response> {
  const session = await getMemberSession(request);
  const surface = paymentsSurface(env);
  if (!session) {
    return json({member: null, surface, wallet: null, paymentMethod: null});
  }

  const member = await rememberMember(session.member);
  const billing = await getMemberBilling(member);
  const paymentMethod = surface.stripe
    ? await paymentMethodForMember(env, member.stripeCustomerId)
    : null;

  return json({
    member,
    surface,
    planId: member.planId,
    membershipStatus: member.membershipStatus ?? "none",
    wallet: billing.wallet,
    transactions: billing.transactions,
    paymentMethod,
  });
}

async function requireMember(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return null;
  return rememberMember(session.member);
}

async function handleCheckout(request: Request, env: StripeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({error: "Sign in to continue."}, 401);
  if (!isStripeReady(env)) {
    return json({
      demo: true,
      url: null,
      notConfigured: true,
      missing: ["STRIPE_SECRET_KEY"],
      message: "Stripe is not connected yet. This local preview still uses labeled demo Credits.",
    }, 503);
  }

  let body: CheckoutRequest;
  try {
    body = (await request.json()) as CheckoutRequest;
  } catch {
    return json({error: "Choose a membership or Credit amount."}, 400);
  }

  try {
    const result = await startCheckout(env, member, body, new URL(request.url).origin);
    return json(result);
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return json({error: error.message, notConfigured: true, missing: error.missing}, 503);
    }
    const message = error instanceof Error ? error.message : "Stripe could not start checkout.";
    return json({error: message}, 400);
  }
}

async function handlePortal(request: Request, env: StripeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({error: "Sign in to continue."}, 401);
  if (!isStripeReady(env)) {
    return json({
      demo: true,
      url: null,
      notConfigured: true,
      missing: ["STRIPE_SECRET_KEY"],
      message: "Stripe Billing is not connected yet.",
    }, 503);
  }
  try {
    const result = await startBillingPortal(env, member, new URL(request.url).origin);
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe portal is unavailable.";
    return json({error: message}, 400);
  }
}

async function handleStripeWebhook(request: Request, env: StripeEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", {status: 405});
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    return json({error: "Stripe webhook is not configured."}, 503);
  }

  const payload = await request.text();
  const header = request.headers.get("stripe-signature") ?? "";
  const valid = await verifyStripeSignature({
    payload,
    header,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  if (!valid) {
    return json({error: "Invalid Stripe signature."}, 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return json({error: "Invalid Stripe event."}, 400);
  }

  const result = await applyStripeEvent(env, event);
  return json(result);
}

async function handlePaymentsConfig(
  request: Request,
  env: StripeEnv,
  runtimeEnv: RuntimeEnv,
): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", {status: 405});
  const me = await getMePayload(request, undefined, runtimeEnv);
  if (!me.member) return json({error: "Sign in to continue."}, 401);
  if (!me.admin) return json({error: "Admin access required."}, 403);
  // Presence only: key values are never returned.
  return json(paymentsConfigChecklist(env));
}
