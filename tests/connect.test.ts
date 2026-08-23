import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {handleConnectFetch} from "../connect/handlers.ts";
import {bookingGrossCredits, creditsToUsdCents, splitMarketplaceAmount} from "../connect/catalog.ts";
import {
  applyAccountToProvider,
  claimProvider,
  ConnectError,
  findProvider,
  resetConnectMemory,
  settleBookingPayout,
  startConnectOnboarding,
} from "../connect/service.ts";
import {connectStatusFromAccount, connectStatusLabel} from "../connect/status.ts";
import {
  completeMemberBooking,
  createMemberBooking,
  resetBookingMemory,
} from "../bookings/service.ts";
import {applyCreditEntry, getMemberBilling, rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import {applyStripeEvent} from "../payments/webhooks.ts";
import type {StripeEnv} from "../payments/env.ts";
import type {Member} from "../domain/types.ts";
import type {StripeEvent, StripeTransfer} from "../payments/stripe.ts";

const env: StripeEnv = {
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_PUBLISHABLE_KEY: "pk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_GOLD_PRICE_ID: "price_gold",
  STRIPE_PLATINUM_PRICE_ID: "price_platinum",
  STRIPE_CONNECT_CLIENT_ID: "ca_test",
};

const emptyEnv: StripeEnv = {
  STRIPE_SECRET_KEY: "",
  STRIPE_PUBLISHABLE_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  STRIPE_GOLD_PRICE_ID: "",
  STRIPE_PLATINUM_PRICE_ID: "",
  STRIPE_CONNECT_CLIENT_ID: "",
};

async function seedMember(id = "member_tide"): Promise<Member> {
  resetMemberMemory();
  resetPaymentMemory();
  resetBookingMemory();
  resetConnectMemory();
  return rememberMember({
    id,
    email: `${id}@joinsalu.com`,
    displayName: "Tide Partner",
    householdId: `hh_${id}`,
    planId: "platinum",
  });
}

test("splits marketplace volume into commission and net payout", () => {
  assert.deepEqual(splitMarketplaceAmount({grossCredits: 120, commissionRate: 20}), {
    grossAmount: 120,
    commissionAmount: 24,
    netPayout: 96,
    rate: 20,
  });
  assert.equal(creditsToUsdCents(96), 9600);
  assert.equal(bookingGrossCredits({creditsCharged: 0, serviceId: "sports-massage"}), 150);
});

test("maps Express account flags to payout status labels", () => {
  assert.equal(connectStatusFromAccount(null), "not_connected");
  assert.equal(connectStatusFromAccount({details_submitted: true, payouts_enabled: false}), "pending");
  assert.equal(connectStatusFromAccount({payouts_enabled: true, charges_enabled: true}), "payouts_enabled");
  assert.equal(connectStatusLabel("not_connected"), "Not connected");
  assert.equal(connectStatusLabel("pending"), "Pending");
  assert.equal(connectStatusLabel("payouts_enabled"), "Payouts enabled");
});

test("lets an approved catalog practice be claimed once", async () => {
  const member = await seedMember();
  const claimed = await claimProvider({member, providerId: "tide-tone"});
  assert.equal(claimed.id, "tide-tone");
  assert.equal(claimed.status, "approved");
  assert.equal(claimed.memberId, member.id);
  assert.equal(claimed.connectStatus, "not_connected");

  const other = await rememberMember({
    id: "member_other",
    email: "other@joinsalu.com",
    displayName: "Other",
    planId: "member",
  });
  await assert.rejects(
    () => claimProvider({member: other, providerId: "tide-tone"}),
    (error: unknown) => error instanceof ConnectError && error.status === 409,
  );
});

test("onboarding without Stripe keys stays a labeled demo", async () => {
  const member = await seedMember();
  const result = await startConnectOnboarding({
    member,
    providerId: "tide-tone",
    origin: "http://localhost:5173",
    env: emptyEnv,
  });
  assert.equal(result.demo, true);
  assert.equal(result.url, null);
  assert.equal(result.status, "not_connected");
  assert.equal(result.provider.memberId, member.id);
});

test("account.updated enables payouts without calling Stripe", async () => {
  const member = await seedMember();
  const claimed = await claimProvider({member, providerId: "tide-tone"});
  await applyAccountToProvider(claimed, {
    id: "acct_tide",
    object: "account",
    payouts_enabled: false,
    details_submitted: true,
    metadata: {providerId: "tide-tone"},
  });

  const event: StripeEvent = {
    id: "evt_account_ready",
    type: "account.updated",
    data: {
      object: {
        id: "acct_tide",
        object: "account",
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
        metadata: {providerId: "tide-tone"},
      },
    },
  };

  const first = await applyStripeEvent(env, event);
  const replay = await applyStripeEvent(env, event);
  const provider = await findProvider({id: "tide-tone"});

  assert.equal(first.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(provider?.connectStatus, "payouts_enabled");
  assert.equal(provider?.payoutsEnabled, true);
});

test("completing a booking records an estimated payout and leaves the wallet alone", async () => {
  const member = await seedMember();
  await applyCreditEntry({member, credits: 200, kind: "contribution", label: "Test funding"});
  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home · Brickell",
    enforceCredits: true,
  });

  const completed = await completeMemberBooking({member, bookingId: created.booking.id});
  const billing = await getMemberBilling(member);

  assert.equal(completed.booking.status, "completed");
  assert.equal(completed.payout?.status, "estimated");
  assert.equal(completed.payout?.grossAmount, 120);
  assert.equal(completed.payout?.commissionAmount, 24);
  assert.equal(completed.payout?.netPayout, 96);
  assert.equal(billing.wallet.availableCredits, 80);
});

test("creates a transfer for a fulfillable booking when payouts are enabled", async () => {
  const member = await seedMember();
  await applyCreditEntry({member, credits: 200, kind: "contribution", label: "Test funding"});
  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home",
    enforceCredits: true,
  });
  const claimed = await claimProvider({member, providerId: "tide-tone"});
  await applyAccountToProvider(claimed, {
    id: "acct_tide",
    object: "account",
    payouts_enabled: true,
    charges_enabled: true,
    details_submitted: true,
    metadata: {providerId: "tide-tone"},
  });

  let transfers = 0;
  const payout = await settleBookingPayout({
    booking: {...created.booking, status: "completed"},
    env,
    createTransfer: async (_secret, input) => {
      transfers += 1;
      assert.equal(input.destination, "acct_tide");
      assert.equal(input.amountCents, 9600);
      assert.equal(input.commissionAmount, 24);
      return {id: "tr_tide_1", object: "transfer", destination: input.destination, amount: input.amountCents};
    },
  });
  const replay = await settleBookingPayout({
    booking: {...created.booking, status: "completed"},
    env,
    createTransfer: async () => {
      transfers += 1;
      return {id: "tr_should_not", object: "transfer"} satisfies StripeTransfer;
    },
  });

  assert.equal(payout?.status, "paid");
  assert.equal(payout?.stripeTransferId, "tr_tide_1");
  assert.equal(replay?.stripeTransferId, "tr_tide_1");
  assert.equal(transfers, 1);
});

test("connect API stays demo without a member session and does not need Stripe secrets", async () => {
  const listed = await handleConnectFetch(new Request("http://localhost/api/connect/me"));
  assert.equal(listed.status, 200);
  const body = await listed.json() as {signedIn: boolean; status: string; message: string};
  assert.equal(body.signedIn, false);
  assert.equal(body.status, "not_connected");
  assert.match(body.message, /demo payouts/);

  const onboard = await handleConnectFetch(new Request("http://localhost/api/connect/onboard", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({providerId: "tide-tone"}),
  }));
  assert.equal(onboard.status, 401);
});
