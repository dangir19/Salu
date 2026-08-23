import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {handleBookingsFetch} from "../bookings/handlers.ts";
import {creditsForService} from "../bookings/catalog.ts";
import {
  BookingError,
  cancelMemberBooking,
  createMemberBooking,
  InsufficientCreditsError,
  listMemberBookings,
  rescheduleMemberBooking,
  resetBookingMemory,
  toUiBooking,
} from "../bookings/service.ts";
import {applyCreditEntry, rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import {resetProviderWorkspaceMemory} from "../provider/service.ts";
import type {Member} from "../domain/types.ts";

async function seedMember(id = "member_ava"): Promise<Member> {
  resetMemberMemory();
  resetPaymentMemory();
  resetBookingMemory();
  resetProviderWorkspaceMemory();
  return rememberMember({
    id,
    email: `${id}@joinsalu.com`,
    displayName: "Ava Ruiz",
    householdId: `hh_${id}`,
    planId: "platinum",
  });
}

async function fund(member: Member, credits = 200) {
  await applyCreditEntry({
    member,
    credits,
    kind: "contribution",
    label: "Test funding",
  });
}

test("prices marketplace services from the catalog and plan discount", () => {
  assert.equal(creditsForService("deep-tissue", "member"), 150);
  assert.equal(creditsForService("deep-tissue", "gold"), 135);
  assert.equal(creditsForService("deep-tissue", "platinum"), 120);
  assert.equal(creditsForService("missing", "platinum"), null);
});

test("creates a confirmed booking and deducts Credits from the wallet", async () => {
  const member = await seedMember();
  await fund(member, 200);

  const result = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home · Brickell",
    enforceCredits: true,
  });

  assert.equal(result.booking.status, "confirmed");
  assert.equal(result.booking.memberId, member.id);
  assert.equal(result.booking.creditsCharged, 120);
  assert.equal(result.creditsApplied, true);
  assert.equal(result.availableCredits, 80);
  assert.equal(toUiBooking(result.booking).status, "Upcoming");

  const listed = await listMemberBookings(member.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, result.booking.id);
});

test("rejects a booking when Stripe enforcement is on and Credits are short", async () => {
  const member = await seedMember();
  await fund(member, 50);

  await assert.rejects(
    () => createMemberBooking({
      member,
      serviceId: "deep-tissue",
      date: "Today · 5:00 PM",
      mode: "At home",
      enforceCredits: true,
    }),
    (error: unknown) => error instanceof InsufficientCreditsError,
  );

  assert.equal((await listMemberBookings(member.id)).length, 0);
});

test("persists a demo booking without debiting an empty wallet when enforcement is off", async () => {
  const member = await seedMember();
  const result = await createMemberBooking({
    member,
    serviceId: "facial",
    date: "Thursday · 3:00 PM",
    mode: "At home",
    enforceCredits: false,
  });

  assert.equal(result.booking.creditsCharged, 120);
  assert.equal(result.creditsApplied, false);
  assert.equal((await listMemberBookings(member.id)).length, 1);
});

test("uses a package session instead of Credits", async () => {
  const member = await seedMember();
  const result = await createMemberBooking({
    member,
    serviceId: "sports-massage",
    date: "Tomorrow · 7:30 PM",
    mode: "At home",
    packageName: "Runner Recovery Pack",
    enforceCredits: true,
  });

  assert.equal(result.booking.creditsCharged, 0);
  assert.equal(result.booking.packageName, "Runner Recovery Pack");
  assert.equal(result.booking.packageItem, "Sports Massage");
  assert.equal(result.creditsApplied, false);
});

test("reschedules without touching the Credit ledger", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const created = await createMemberBooking({
    member,
    serviceId: "stretch",
    date: "Tomorrow · 8:00 PM",
    mode: "At home",
    enforceCredits: true,
  });

  const moved = await rescheduleMemberBooking({
    member,
    bookingId: created.booking.id,
    date: "Friday · 8:00 PM",
  });

  assert.equal(moved.date, "Friday · 8:00 PM");
  assert.equal(moved.creditsCharged, created.booking.creditsCharged);
  assert.equal(created.availableCredits, 120);
});

test("cancels an upcoming booking and restores Credits once", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home",
    enforceCredits: true,
  });

  const first = await cancelMemberBooking({member, bookingId: created.booking.id});
  const replay = await cancelMemberBooking({member, bookingId: created.booking.id});

  assert.equal(first.booking.status, "cancelled");
  assert.equal(first.creditsApplied, true);
  assert.equal(first.availableCredits, 200);
  assert.equal(replay.creditsApplied, false);
  assert.equal(replay.availableCredits, 200);
  assert.equal(toUiBooking(first.booking).status, "Cancelled");
});

test("does not let one member cancel another member's reservation", async () => {
  const owner = await seedMember("member_ava");
  await fund(owner, 200);
  const created = await createMemberBooking({
    member: owner,
    serviceId: "facial",
    date: "Thursday · 3:00 PM",
    mode: "At home",
    enforceCredits: true,
  });

  const other = await rememberMember({
    id: "member_other",
    email: "other@joinsalu.com",
    displayName: "Other Member",
    planId: "member",
  });

  await assert.rejects(
    () => cancelMemberBooking({member: other, bookingId: created.booking.id}),
    (error: unknown) => error instanceof BookingError && error.status === 404,
  );
  assert.equal((await listMemberBookings(other.id)).length, 0);
  assert.equal((await listMemberBookings(owner.id))[0]?.status, "confirmed");
});

test("booking API stays demo without a member session and does not need Stripe secrets", async () => {
  const listed = await handleBookingsFetch(new Request("http://localhost/api/bookings"));
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    source: "demo",
    bookings: [],
    message: "Sign in to keep appointments on the server. This local preview still uses labeled demo bookings.",
  });

  const created = await handleBookingsFetch(new Request("http://localhost/api/bookings", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({serviceId: "deep-tissue", date: "Tomorrow · 6:00 PM", mode: "At home"}),
  }));
  assert.equal(created.status, 401);
  const body = await created.json() as {source: string};
  assert.equal(body.source, "demo");
});
