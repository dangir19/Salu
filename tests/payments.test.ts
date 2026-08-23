import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {
  CREDIT_TOPUP_AMOUNTS,
  creditsFromUsdCents,
  monthlyCreditsForPlan,
  planIdFromName,
  planNameFromId,
} from "../payments/catalog.ts";
import {paymentsSurface, readStripeEnv} from "../payments/env.ts";
import {getMemberBilling, rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import {signedStripeHeader, verifyStripeSignature} from "../payments/signature.ts";
import type {StripeEnv} from "../payments/env.ts";
import type {StripeEvent} from "../payments/stripe.ts";
import {applyStripeEvent} from "../payments/webhooks.ts";

const env: StripeEnv = {
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_PUBLISHABLE_KEY: "pk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_GOLD_PRICE_ID: "price_gold",
  STRIPE_PLATINUM_PRICE_ID: "price_platinum",
};

async function seedMember() {
  resetMemberMemory();
  resetPaymentMemory();
  return rememberMember({
    id: "member_ava",
    email: "ava@joinsalu.com",
    displayName: "Ava Ruiz",
    householdId: "hh_member_ava",
    planId: "member",
    stripeCustomerId: "cus_ava",
  });
}

test("hides Stripe until secret keys are present", () => {
  const empty = readStripeEnv({
    STRIPE_SECRET_KEY: "",
    STRIPE_PUBLISHABLE_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    STRIPE_GOLD_PRICE_ID: "",
    STRIPE_PLATINUM_PRICE_ID: "",
  });
  const surface = paymentsSurface(empty);
  assert.equal(surface.stripe, false);
  assert.equal(surface.webhook, false);
  assert.equal(surface.goldPrice, false);
});

test("treats configured Stripe env as ready without calling Stripe", () => {
  const surface = paymentsSurface(readStripeEnv(env));
  assert.equal(surface.stripe, true);
  assert.equal(surface.goldPrice, true);
  assert.equal(surface.platinumPrice, true);
  assert.equal(surface.webhook, true);
});

test("keeps Gold and Platinum credit math at one dollar per Credit", () => {
  assert.equal(monthlyCreditsForPlan("gold"), 200);
  assert.equal(monthlyCreditsForPlan("platinum"), 500);
  assert.equal(creditsFromUsdCents(20000), 200);
  assert.equal(creditsFromUsdCents(50000), 500);
  assert.deepEqual([...CREDIT_TOPUP_AMOUNTS], [100, 200, 500]);
  assert.equal(planIdFromName("Gold"), "gold");
  assert.equal(planNameFromId("platinum"), "Platinum");
});

test("verifies Stripe webhook signatures and rejects stale or forged headers", async () => {
  const payload = JSON.stringify({id: "evt_1", type: "ping"});
  const header = await signedStripeHeader("whsec_test", payload, 1_700_000_000);
  assert.equal(
    await verifyStripeSignature({
      payload,
      header,
      secret: "whsec_test",
      nowSeconds: 1_700_000_010,
    }),
    true,
  );
  assert.equal(
    await verifyStripeSignature({
      payload,
      header,
      secret: "whsec_other",
      nowSeconds: 1_700_000_010,
    }),
    false,
  );
  assert.equal(
    await verifyStripeSignature({
      payload,
      header,
      secret: "whsec_test",
      nowSeconds: 1_700_000_000 + 400,
    }),
    false,
  );
});

test("credits the wallet from a paid Credit Checkout and ignores a replay", async () => {
  const member = await seedMember();
  const event: StripeEvent = {
    id: "evt_topup_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_topup_1",
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        amount_total: 10000,
        customer: "cus_ava",
        metadata: {kind: "credits", memberId: member.id},
      },
    },
  };

  const first = await applyStripeEvent(env, event);
  const replay = await applyStripeEvent(env, event);
  const billing = await getMemberBilling(member);

  assert.equal(first.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(billing.wallet.availableCredits, 100);
  assert.equal(billing.transactions[0]?.kind, "topup");
  assert.equal(billing.transactions[0]?.credits, 100);
});

test("activates Gold from invoice.paid using the paid amount as Credits", async () => {
  const member = await seedMember();
  const event: StripeEvent = {
    id: "evt_invoice_gold",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_gold_1",
        object: "invoice",
        customer: "cus_ava",
        subscription: {
          id: "sub_gold",
          object: "subscription",
          status: "active",
          metadata: {memberId: member.id, planId: "gold"},
          items: {data: [{id: "si_1", price: {id: "price_gold", unit_amount: 20000}}]},
        },
        amount_paid: 20000,
        billing_reason: "subscription_create",
      },
    },
  };

  const result = await applyStripeEvent(env, event);
  const billing = await getMemberBilling(member);

  assert.equal(result.applied, true);
  assert.equal(billing.member.planId, "gold");
  assert.equal(billing.member.stripeSubscriptionId, "sub_gold");
  assert.equal(billing.wallet.availableCredits, 200);
  assert.match(billing.transactions[0]?.label ?? "", /Gold monthly contribution/);
});

test("returns the member to Member when the subscription is deleted and keeps Credits", async () => {
  const member = await seedMember();
  await applyStripeEvent(env, {
    id: "evt_invoice_keep",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_keep",
        object: "invoice",
        customer: "cus_ava",
        subscription: {
          id: "sub_keep",
          object: "subscription",
          status: "active",
          metadata: {planId: "platinum", memberId: member.id},
          items: {data: [{price: {id: "price_platinum"}}]},
        },
        amount_paid: 50000,
      },
    },
  });

  await applyStripeEvent(env, {
    id: "evt_sub_deleted",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_keep",
        object: "subscription",
        status: "canceled",
        customer: "cus_ava",
        metadata: {memberId: member.id, planId: "platinum"},
      },
    },
  });

  const billing = await getMemberBilling(member);
  assert.equal(billing.member.planId, "member");
  assert.equal(billing.member.membershipStatus, "canceled");
  assert.equal(billing.wallet.availableCredits, 500);
});

test("debits Credits when Stripe refunds a charge", async () => {
  const member = await seedMember();
  await applyStripeEvent(env, {
    id: "evt_topup_refundable",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_refundable",
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        amount_total: 20000,
        customer: "cus_ava",
        metadata: {memberId: member.id},
      },
    },
  });

  await applyStripeEvent(env, {
    id: "evt_refund",
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_refund",
        object: "charge",
        customer: "cus_ava",
        amount_refunded: 20000,
        metadata: {memberId: member.id},
      },
    },
  });

  const billing = await getMemberBilling(member);
  assert.equal(billing.wallet.availableCredits, 0);
  assert.equal(billing.transactions[0]?.kind, "refund");
});
