import test from "node:test";
import assert from "node:assert/strict";
import {handleAdminFetch, type AdminBookingRow, type AdminMemberRow, type AdminStore} from "../admin/handlers.ts";
import {memoryUpsertMember, resetMemberMemory} from "../auth/members.ts";
import {cancelMemberBooking, createMemberBooking, resetBookingMemory} from "../bookings/service.ts";
import {applyCreditEntry, getMemberBilling, resetPaymentMemory} from "../payments/ledger.ts";
import type {Member} from "../domain/types.ts";

const adminEnv = {SALU_ADMIN_EMAILS: "ops@joinsalu.com"};

function sessionHeaders(email: string) {
  return {
    "oai-authenticated-user-id": `chatgpt_${email.replace(/[^a-z0-9]+/gi, "_")}`,
    "oai-authenticated-user-email": email,
  };
}

function adminRequest(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: sessionHeaders("ops@joinsalu.com"),
    ...init,
  });
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return memoryUpsertMember({
    id: "m_admin_test",
    email: "member@joinsalu.com",
    displayName: "Test Member",
    planId: "gold",
    ...overrides,
  });
}

function makeStore(overrides: Partial<AdminStore> = {}): AdminStore {
  const members: AdminMemberRow[] = [
    {
      id: "m_1",
      email: "a@joinsalu.com",
      displayName: "Ada",
      planId: "gold",
      membershipStatus: "active",
      availableCredits: 150,
      bookingCount: 2,
    },
  ];
  const bookings: AdminBookingRow[] = [
    {
      id: "b_1",
      member: {id: "m_1", displayName: "Ada", email: "a@joinsalu.com"},
      service: {id: "sports-massage", name: "Sports Massage"},
      provider: "Tide & Tone Recovery",
      date: "2026-10-02",
      status: "confirmed",
      creditsCharged: 135,
    },
  ];
  const calls: Array<{method: string; args: unknown[]}> = [];
  const store: AdminStore = {
    async listMembers() {
      return members;
    },
    async listBookings() {
      return bookings;
    },
    async overview() {
      return {
        members: members.length,
        applications: {submitted: 2, approved: 1},
        bookings: {confirmed: 1},
        creditsOutstanding: 150,
      };
    },
    async cancelBooking(id) {
      calls.push({method: "cancelBooking", args: [id]});
      const booking = bookings.find((row) => row.id === id) ?? null;
      if (!booking) return null;
      return {booking: {...booking, status: "cancelled"}, refunded: true, availableCredits: 285};
    },
    async assignProvider(id, providerId) {
      calls.push({method: "assignProvider", args: [id, providerId]});
      const booking = bookings.find((row) => row.id === id) ?? null;
      if (!booking) return null;
      return {...booking, provider: "Assigned Provider", providerId};
    },
    async adjustCredits(memberId, credits, label) {
      calls.push({method: "adjustCredits", args: [memberId, credits, label]});
      const member = members.find((row) => row.id === memberId) ?? null;
      if (!member) return null;
      member.availableCredits += credits;
      return {memberId, availableCredits: member.availableCredits, transactionId: "tx_test"};
    },
    ...overrides,
  };
  return Object.assign(store, {calls});
}

test("rejects admin endpoints without a signed-in admin", async () => {
  const denied = await handleAdminFetch(
    new Request("http://localhost/api/admin/overview"),
    adminEnv,
    makeStore(),
  );
  assert.equal(denied.status, 401);
  const body = (await denied.json()) as {error?: string};
  assert.match(body.error ?? "", /Sign in/);
});

test("rejects signed-in members who are not on the admin allowlist", async () => {
  const denied = await handleAdminFetch(
    new Request("http://localhost/api/admin/members", {headers: sessionHeaders("member@joinsalu.com")}),
    adminEnv,
    makeStore(),
  );
  assert.equal(denied.status, 403);
});

test("returns overview counts for an admin", async () => {
  const res = await handleAdminFetch(adminRequest("/api/admin/overview"), adminEnv, makeStore());
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    source: string;
    opsOpen: boolean;
    overview: {members: number; applications: Record<string, number>; bookings: Record<string, number>; creditsOutstanding: number};
  };
  assert.equal(body.source, "server");
  assert.equal(body.opsOpen, true);
  assert.equal(body.overview.members, 1);
  assert.deepEqual(body.overview.applications, {submitted: 2, approved: 1});
  assert.deepEqual(body.overview.bookings, {confirmed: 1});
  assert.equal(body.overview.creditsOutstanding, 150);
});

test("lists members and bookings for an admin", async () => {
  const store = makeStore();
  const membersRes = await handleAdminFetch(adminRequest("/api/admin/members"), adminEnv, store);
  const membersBody = (await membersRes.json()) as {members: AdminMemberRow[]};
  assert.equal(membersBody.members.length, 1);
  assert.equal(membersBody.members[0]?.availableCredits, 150);
  assert.equal(membersBody.members[0]?.bookingCount, 2);

  const bookingsRes = await handleAdminFetch(adminRequest("/api/admin/bookings"), adminEnv, store);
  const bookingsBody = (await bookingsRes.json()) as {bookings: AdminBookingRow[]};
  assert.equal(bookingsBody.bookings.length, 1);
  assert.equal(bookingsBody.bookings[0]?.creditsCharged, 135);
});

test("validates the credit adjustment endpoint", async () => {
  const store = makeStore();
  const post = (body: unknown) =>
    handleAdminFetch(
      adminRequest("/api/admin/members/credit", {method: "POST", body: JSON.stringify(body)}),
      adminEnv,
      store,
    );

  const zero = await post({memberId: "m_1", credits: 0, label: "no-op"});
  assert.equal(zero.status, 400);

  const fractional = await post({memberId: "m_1", credits: 12.5, label: "nope"});
  assert.equal(fractional.status, 400);

  const unlabeled = await post({memberId: "m_1", credits: 10, label: ""});
  assert.equal(unlabeled.status, 400);

  const unknown = await post({memberId: "m_missing", credits: 10, label: "ghost"});
  assert.equal(unknown.status, 503);

  const ok = await post({memberId: "m_1", credits: 50, label: "Goodwill"});
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as {availableCredits: number; transactionId: string};
  assert.equal(okBody.availableCredits, 200);
  assert.equal(okBody.transactionId, "tx_test");

  const negative = await post({memberId: "m_1", credits: -200, label: "Correction"});
  const negativeBody = (await negative.json()) as {availableCredits: number};
  assert.equal(negativeBody.availableCredits, 0);
});

test("cancels a booking and refunds through the admin endpoint", async () => {
  const store = makeStore() as AdminStore & {calls: Array<{method: string; args: unknown[]}>};
  const res = await handleAdminFetch(
    adminRequest("/api/admin/bookings/cancel", {method: "POST", body: JSON.stringify({id: "b_1"})}),
    adminEnv,
    store,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {booking: AdminBookingRow; refunded: boolean; availableCredits: number};
  assert.equal(body.booking.status, "cancelled");
  assert.equal(body.refunded, true);
  assert.equal(body.availableCredits, 285);
  assert.deepEqual(store.calls[0], {method: "cancelBooking", args: ["b_1"]});

  const missing = await handleAdminFetch(
    adminRequest("/api/admin/bookings/cancel", {method: "POST", body: JSON.stringify({})}),
    adminEnv,
    store,
  );
  assert.equal(missing.status, 400);
});

test("assigns a provider through the admin endpoint", async () => {
  const store = makeStore();
  const res = await handleAdminFetch(
    adminRequest("/api/admin/bookings/assign", {
      method: "POST",
      body: JSON.stringify({id: "b_1", providerId: "tide-tone"}),
    }),
    adminEnv,
    store,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {booking: AdminBookingRow};
  assert.equal(body.booking.providerId, "tide-tone");

  const missing = await handleAdminFetch(
    adminRequest("/api/admin/bookings/assign", {method: "POST", body: JSON.stringify({id: "b_1"})}),
    adminEnv,
    store,
  );
  assert.equal(missing.status, 400);
});

test("returns 404 for unknown admin paths", async () => {
  const res = await handleAdminFetch(adminRequest("/api/admin/nope"), adminEnv, makeStore());
  assert.equal(res.status, 404);
});

test("adjustment entries add and subtract from the wallet like other ledger kinds", async () => {
  resetMemberMemory();
  resetPaymentMemory();
  const member = makeMember();

  const grant = await applyCreditEntry({member, credits: 200, kind: "adjustment", label: "Ops grant"});
  assert.ok(grant);
  assert.equal(grant?.credits, 200);
  assert.equal(grant?.kind, "adjustment");

  const clawback = await applyCreditEntry({member, credits: -50, kind: "adjustment", label: "Ops correction"});
  assert.ok(clawback);

  const snapshot = await getMemberBilling(member);
  assert.equal(snapshot.wallet.availableCredits, 150);
  assert.equal(snapshot.transactions.filter((row) => row.kind === "adjustment").length, 2);
});

test("cancelling a member booking refunds the charged credits to the wallet", async () => {
  resetMemberMemory();
  resetBookingMemory();
  resetPaymentMemory();
  const member = makeMember({id: "m_refund_test", email: "refund@joinsalu.com"});

  await applyCreditEntry({member, credits: 1000, kind: "topup", label: "Test top-up"});
  const created = await createMemberBooking({
    member,
    serviceId: "sports-massage",
    date: "2026-10-02",
    mode: "At home",
    enforceCredits: true,
  });
  assert.equal(created.booking.status, "confirmed");
  assert.ok(created.booking.creditsCharged > 0);
  const afterSpend = await getMemberBilling(member);
  assert.equal(afterSpend.wallet.availableCredits, 1000 - created.booking.creditsCharged);

  const cancelled = await cancelMemberBooking({member, bookingId: created.booking.id});
  assert.equal(cancelled.booking.status, "cancelled");
  assert.equal(cancelled.creditsApplied, true);
  const afterRefund = await getMemberBilling(member);
  assert.equal(afterRefund.wallet.availableCredits, 1000);
  assert.ok(
    afterRefund.transactions.some(
      (row) => row.kind === "refund" && row.bookingId === created.booking.id,
    ),
  );
});
