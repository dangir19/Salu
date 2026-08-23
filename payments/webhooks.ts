import type {Member, MembershipStatus} from "../domain/types";
import {creditsFromUsdCents, isPaidPlanId, type PlanId} from "./catalog";
import {planIdFromPriceId, type StripeEnv} from "./env";
import {
  applyCreditEntry,
  claimStripeEvent,
  membershipLabel,
  resolveMember,
  setMemberMembership,
} from "./ledger";
import {
  idFromExpandable,
  invoiceSubscriptionId,
  retrieveCustomer,
  retrieveSubscription,
  subscriptionPriceId,
  type StripeAccount,
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeEvent,
  type StripeInvoice,
  type StripeSubscription,
  type StripeTransfer,
} from "./stripe";

export type WebhookResult = {
  eventId: string;
  type: string;
  applied: boolean;
  detail: string;
};

function statusFromSubscription(status?: string): MembershipStatus {
  if (status === "active" || status === "trialing" || status === "past_due" || status === "incomplete" || status === "canceled") {
    return status;
  }
  if (status === "unpaid") return "past_due";
  if (status === "incomplete_expired") return "canceled";
  return "none";
}

function planFromSubscription(env: StripeEnv, subscription: StripeSubscription | null | undefined): PlanId {
  const fromMetadata = subscription?.metadata?.planId;
  if (isPaidPlanId(fromMetadata)) return fromMetadata;
  return planIdFromPriceId(env, subscriptionPriceId(subscription)) ?? "member";
}

async function memberFromCustomer(
  env: StripeEnv,
  customerId: string,
  fallback?: {memberId?: string | null; email?: string | null},
): Promise<Member | null> {
  const existing = await resolveMember({
    memberId: fallback?.memberId,
    email: fallback?.email,
    stripeCustomerId: customerId,
  });
  if (existing) return existing;
  if (!customerId || !env.STRIPE_SECRET_KEY) return null;
  try {
    const customer = await retrieveCustomer(env.STRIPE_SECRET_KEY, customerId);
    return resolveMember({
      memberId: customer.metadata?.memberId ?? fallback?.memberId,
      email: customer.email ?? fallback?.email,
      stripeCustomerId: customer.id,
    });
  } catch {
    return null;
  }
}

async function loadSubscription(env: StripeEnv, subscription: string | StripeSubscription | null | undefined): Promise<StripeSubscription | null> {
  if (!subscription) return null;
  if (typeof subscription === "object") return subscription;
  if (!env.STRIPE_SECRET_KEY) return null;
  try {
    return await retrieveSubscription(env.STRIPE_SECRET_KEY, subscription);
  } catch {
    return null;
  }
}

export async function applyStripeEvent(env: StripeEnv, event: StripeEvent): Promise<WebhookResult> {
  const claimed = await claimStripeEvent(event.id, event.type);
  if (!claimed) {
    return {eventId: event.id, type: event.type, applied: false, detail: "already processed"};
  }

  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(env, event, event.data.object as StripeCheckoutSession);
    case "invoice.paid":
      return handleInvoicePaid(env, event, event.data.object as StripeInvoice);
    case "invoice.payment_failed":
      return handleInvoiceFailed(env, event, event.data.object as StripeInvoice);
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return handleSubscriptionChange(env, event, event.data.object as StripeSubscription);
    case "charge.refunded":
      return handleChargeRefunded(env, event, event.data.object as StripeCharge);
    case "account.updated":
      return handleAccountUpdated(event, event.data.object as StripeAccount);
    case "transfer.created":
    case "transfer.updated":
      return handleTransferEvent(event, event.data.object as StripeTransfer, "paid");
    case "transfer.reversed":
      return handleTransferEvent(event, event.data.object as StripeTransfer, "failed");
    default:
      return {eventId: event.id, type: event.type, applied: false, detail: "ignored"};
  }
}

async function handleCheckoutCompleted(
  env: StripeEnv,
  event: StripeEvent,
  session: StripeCheckoutSession,
): Promise<WebhookResult> {
  const customerId = idFromExpandable(session.customer);
  const member = await memberFromCustomer(env, customerId, {
    memberId: session.metadata?.memberId ?? session.client_reference_id,
  });
  if (!member) {
    return {eventId: event.id, type: event.type, applied: false, detail: "member not found"};
  }

  if (session.mode === "subscription") {
    const subscription = await loadSubscription(env, session.subscription);
    const planId = isPaidPlanId(session.metadata?.planId) ? session.metadata.planId : planFromSubscription(env, subscription);
    await setMemberMembership({
      member,
      planId,
      stripeCustomerId: customerId || member.stripeCustomerId,
      stripeSubscriptionId: idFromExpandable(session.subscription) || subscription?.id,
      membershipStatus: statusFromSubscription(subscription?.status) || "active",
    });
    return {eventId: event.id, type: event.type, applied: true, detail: `membership ${planId}`};
  }

  if (session.mode === "payment" && session.payment_status === "paid") {
    const credits = creditsFromUsdCents(session.amount_total ?? 0);
    if (!credits) {
      return {eventId: event.id, type: event.type, applied: false, detail: "no credits"};
    }
    await applyCreditEntry({
      member,
      credits,
      kind: "topup",
      label: membershipLabel("member", "topup"),
      stripeEventId: event.id,
      stripeObjectId: session.id,
    });
    if (customerId) {
      await setMemberMembership({
        member,
        planId: (member.planId as PlanId) || "member",
        stripeCustomerId: customerId,
        membershipStatus: member.membershipStatus ?? "none",
      });
    }
    return {eventId: event.id, type: event.type, applied: true, detail: `topup ${credits}`};
  }

  return {eventId: event.id, type: event.type, applied: false, detail: "unhandled checkout"};
}

async function handleInvoicePaid(env: StripeEnv, event: StripeEvent, invoice: StripeInvoice): Promise<WebhookResult> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return {eventId: event.id, type: event.type, applied: false, detail: "not a subscription invoice"};
  }

  const customerId = idFromExpandable(invoice.customer);
  const subscription = await loadSubscription(env, invoice.subscription ?? subscriptionId);
  const member = await memberFromCustomer(env, customerId, {
    memberId: subscription?.metadata?.memberId,
  });
  if (!member) {
    return {eventId: event.id, type: event.type, applied: false, detail: "member not found"};
  }

  const planId = planFromSubscription(env, subscription);
  await setMemberMembership({
    member,
    planId,
    stripeCustomerId: customerId || member.stripeCustomerId,
    stripeSubscriptionId: subscriptionId,
    membershipStatus: statusFromSubscription(subscription?.status) || "active",
  });

  const credits = creditsFromUsdCents(invoice.amount_paid ?? 0);
  if (credits) {
    await applyCreditEntry({
      member,
      credits,
      kind: "contribution",
      label: membershipLabel(planId, "contribution"),
      stripeEventId: event.id,
      stripeObjectId: invoice.id,
    });
  }

  return {eventId: event.id, type: event.type, applied: true, detail: `invoice ${credits} ${planId}`};
}

async function handleInvoiceFailed(env: StripeEnv, event: StripeEvent, invoice: StripeInvoice): Promise<WebhookResult> {
  const customerId = idFromExpandable(invoice.customer);
  const member = await memberFromCustomer(env, customerId);
  if (!member) {
    return {eventId: event.id, type: event.type, applied: false, detail: "member not found"};
  }
  await setMemberMembership({
    member,
    planId: (member.planId as PlanId) || "member",
    stripeCustomerId: customerId || member.stripeCustomerId,
    membershipStatus: "past_due",
  });
  return {eventId: event.id, type: event.type, applied: true, detail: "past_due"};
}

async function handleSubscriptionChange(
  env: StripeEnv,
  event: StripeEvent,
  subscription: StripeSubscription,
): Promise<WebhookResult> {
  const customerId = idFromExpandable(subscription.customer);
  const member = await memberFromCustomer(env, customerId, {memberId: subscription.metadata?.memberId});
  if (!member) {
    return {eventId: event.id, type: event.type, applied: false, detail: "member not found"};
  }

  const deleted = event.type === "customer.subscription.deleted" || subscription.status === "canceled";
  const planId = deleted ? "member" : planFromSubscription(env, subscription);
  await setMemberMembership({
    member,
    planId,
    stripeCustomerId: customerId || member.stripeCustomerId,
    stripeSubscriptionId: deleted ? null : subscription.id,
    membershipStatus: deleted ? "canceled" : statusFromSubscription(subscription.status),
  });
  return {eventId: event.id, type: event.type, applied: true, detail: deleted ? "canceled" : planId};
}

async function handleChargeRefunded(env: StripeEnv, event: StripeEvent, charge: StripeCharge): Promise<WebhookResult> {
  const credits = creditsFromUsdCents(charge.amount_refunded ?? 0);
  if (!credits) {
    return {eventId: event.id, type: event.type, applied: false, detail: "no refunded amount"};
  }
  const customerId = idFromExpandable(charge.customer);
  const member = await memberFromCustomer(env, customerId, {memberId: charge.metadata?.memberId});
  if (!member) {
    return {eventId: event.id, type: event.type, applied: false, detail: "member not found"};
  }
  await applyCreditEntry({
    member,
    credits: -credits,
    kind: "refund",
    label: membershipLabel("member", "refund"),
    stripeEventId: event.id,
    stripeObjectId: `${charge.id}:refund`,
  });
  return {eventId: event.id, type: event.type, applied: true, detail: `refund ${credits}`};
}

async function handleAccountUpdated(event: StripeEvent, account: StripeAccount): Promise<WebhookResult> {
  const connect = await import("../connect/service");
  const provider = await connect.syncProviderFromAccount({
    account,
    providerId: account.metadata?.providerId,
  });
  if (!provider) {
    return {eventId: event.id, type: event.type, applied: false, detail: "provider not found"};
  }
  return {
    eventId: event.id,
    type: event.type,
    applied: true,
    detail: `${provider.id} ${provider.connectStatus}`,
  };
}

async function handleTransferEvent(
  event: StripeEvent,
  transfer: StripeTransfer,
  status: "paid" | "failed",
): Promise<WebhookResult> {
  const connect = await import("../connect/service");
  const payout = await connect.applyTransferToPayout({transfer, status});
  if (!payout) {
    return {eventId: event.id, type: event.type, applied: false, detail: "payout not found"};
  }
  return {eventId: event.id, type: event.type, applied: true, detail: `${payout.bookingId} ${payout.status}`};
}
