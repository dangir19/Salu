import type {Member} from "../domain/types";
import {isCreditTopupAmount, isPaidPlanId, planNameFromId, type PaidPlanId} from "./catalog";
import {planIdFromPriceId, priceIdForPlan, type StripeEnv} from "./env";
import {setMemberMembership} from "./ledger";
import {
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  retrieveSubscription,
  subscriptionItemId,
  subscriptionPriceId,
  updateSubscription,
  type StripeCustomer,
} from "./stripe";

export class NotConfiguredError extends Error {
  missing: string[];
  constructor(message: string, missing: string[]) {
    super(message);
    this.name = "NotConfiguredError";
    this.missing = missing;
  }
}

export type CheckoutRequest = {
  kind: "membership" | "credits";
  planId?: string;
  credits?: number;
};

export type CheckoutResponse = {
  url?: string | null;
  demo?: boolean;
  updated?: boolean;
  canceled?: boolean;
  planId?: string;
  message: string;
};

async function ensureCustomer(env: StripeEnv, member: Member): Promise<StripeCustomer> {
  if (member.stripeCustomerId) {
    return {id: member.stripeCustomerId, object: "customer"};
  }
  const customer = await createCustomer(env.STRIPE_SECRET_KEY, {
    email: member.email,
    name: member.displayName,
    memberId: member.id,
  });
  await setMemberMembership({
    member,
    planId: (member.planId as "member" | PaidPlanId) || "member",
    stripeCustomerId: customer.id,
    stripeSubscriptionId: member.stripeSubscriptionId,
    membershipStatus: member.membershipStatus ?? "none",
  });
  return customer;
}

export async function startCheckout(
  env: StripeEnv,
  member: Member,
  request: CheckoutRequest,
  origin: string,
): Promise<CheckoutResponse> {
  if (request.kind === "credits") {
    return startCreditCheckout(env, member, request.credits ?? 100, origin);
  }
  return startMembershipCheckout(env, member, request.planId ?? "member", origin);
}

async function startCreditCheckout(
  env: StripeEnv,
  member: Member,
  credits: number,
  origin: string,
): Promise<CheckoutResponse> {
  if (!isCreditTopupAmount(credits)) {
    throw new Error("Choose 100, 200 or 500 Credits.");
  }
  const customer = await ensureCustomer(env, member);
  const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
    mode: "payment",
    customer: customer.id,
    client_reference_id: member.id,
    success_url: `${origin}/credits?checkout=success`,
    cancel_url: `${origin}/credits?checkout=cancel`,
    metadata: {kind: "credits", memberId: member.id, credits: String(credits)},
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: credits * 100,
          product_data: {
            name: `Salu Credits · ${credits}`,
            description: "Customer wallet funds for the Salu marketplace. 1 Credit = $1. Not Salu revenue.",
          },
        },
      },
    ],
  });
  return {
    url: session.url,
    message: `Continue to Stripe to add ${credits} Credits.`,
  };
}

async function startMembershipCheckout(
  env: StripeEnv,
  member: Member,
  planId: string,
  origin: string,
): Promise<CheckoutResponse> {
  if (planId === "member") {
    return cancelToMember(env, member);
  }
  if (!isPaidPlanId(planId)) {
    throw new Error("Choose Member, Gold or Platinum.");
  }

  const priceId = priceIdForPlan(env, planId);
  if (!priceId) {
    const missingKey = `STRIPE_${planId.toUpperCase()}_PRICE_ID`;
    throw new NotConfiguredError(
      `Salu ${planNameFromId(planId)} checkout is not configured yet — Daniel needs to add ${missingKey} before taking live cards.`,
      [missingKey],
    );
  }

  const customer = await ensureCustomer(env, member);
  if (member.stripeSubscriptionId) {
    const subscription = await retrieveSubscription(env.STRIPE_SECRET_KEY, member.stripeSubscriptionId);
    const currentPrice = subscriptionPriceId(subscription);
    if (planIdFromPriceId(env, currentPrice) === planId) {
      return {url: null, updated: false, planId, message: `You are already on Salu ${planNameFromId(planId)}.`};
    }
    const itemId = subscriptionItemId(subscription);
    if (itemId) {
      await updateSubscription(env.STRIPE_SECRET_KEY, subscription.id, {
        items: [{id: itemId, price: priceId}],
        proration_behavior: "create_prorations",
        metadata: {memberId: member.id, planId},
        cancel_at_period_end: false,
      });
      await setMemberMembership({
        member: {...member, stripeCustomerId: customer.id},
        planId,
        stripeCustomerId: customer.id,
        stripeSubscriptionId: subscription.id,
        membershipStatus: "active",
      });
      return {
        url: null,
        updated: true,
        planId,
        message: `Stripe is moving you to Salu ${planNameFromId(planId)}. Credits follow the paid invoice.`,
      };
    }
  }

  const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
    mode: "subscription",
    customer: customer.id,
    client_reference_id: member.id,
    success_url: `${origin}/credits?checkout=success`,
    cancel_url: `${origin}/plans?checkout=cancel`,
    metadata: {kind: "membership", memberId: member.id, planId},
    subscription_data: {
      metadata: {memberId: member.id, planId},
    },
    line_items: [{price: priceId, quantity: 1}],
  });

  return {
    url: session.url,
    planId,
    message: `Continue to Stripe for Salu ${planNameFromId(planId)}.`,
  };
}

async function cancelToMember(env: StripeEnv, member: Member): Promise<CheckoutResponse> {
  if (member.stripeSubscriptionId && env.STRIPE_SECRET_KEY) {
    await updateSubscription(env.STRIPE_SECRET_KEY, member.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    await setMemberMembership({
      member,
      planId: (member.planId as PaidPlanId) || "member",
      membershipStatus: member.membershipStatus ?? "active",
    });
    return {
      url: null,
      canceled: true,
      planId: member.planId,
      message: "Stripe will keep Gold or Platinum through the paid period, then return you to Member. Existing Credits stay in your wallet.",
    };
  }

  await setMemberMembership({
    member,
    planId: "member",
    membershipStatus: "none",
    stripeSubscriptionId: null,
  });
  return {
    url: null,
    updated: true,
    planId: "member",
    message: "You are on Salu Member. Buy Credits whenever you like.",
  };
}

export async function startBillingPortal(env: StripeEnv, member: Member, origin: string): Promise<CheckoutResponse> {
  if (!member.stripeCustomerId) {
    throw new Error("No Stripe customer is on file yet.");
  }
  const session = await createPortalSession(env.STRIPE_SECRET_KEY, {
    customer: member.stripeCustomerId,
    returnUrl: `${origin}/profile`,
  });
  return {url: session.url, message: "Continue to Stripe to manage your membership."};
}
