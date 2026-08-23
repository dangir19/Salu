import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {handleBookingsFetch} from "../bookings/handlers.ts";
import {creditsForService} from "../bookings/catalog.ts";
import {
  acceptProposedBookingTime,
  BookingError,
  cancelMemberBooking,
  createMemberBooking,
  declineProposedBookingTime,
  InsufficientCreditsError,
  listMemberBookings,
  rescheduleMemberBooking,
  resetBookingMemory,
  toUiBooking,
} from "../bookings/service.ts";
import {applyCreditEntry, getMemberBilling, rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import {
  listInboxForProvider,
  listJobsForProvider,
  proposeRequestTime,
  requestForBooking,
  resetProviderWorkspaceMemory,
  resolveProviderAccount,
} from "../provider/service.ts";
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

test("member can accept a proposed time without moving Credits", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const provider = await resolveProviderAccount({
    email: "tide@localhost",
    displayName: "Sofia Alvarez",
    memberId: "provider_tide_tone",
  });
  assert.ok(provider);

  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home · Brickell",
    enforceCredits: true,
  });
  const opened = await requestForBooking(created.booking.id);
  assert.ok(opened);
  await proposeRequestTime({provider, requestId: opened.id, date: "Friday · 8:00 PM"});
  const before = await getMemberBilling(member);

  const accepted = await acceptProposedBookingTime({member, bookingId: created.booking.id});
  const after = await getMemberBilling(member);
  const request = await requestForBooking(created.booking.id);
  const memberView = (await listMemberBookings(member.id))[0];

  assert.equal(accepted.creditsApplied, false);
  assert.equal(accepted.availableCredits, before.wallet.availableCredits);
  assert.equal(after.wallet.availableCredits, before.wallet.availableCredits);
  assert.equal(accepted.booking.date, "Friday · 8:00 PM");
  assert.equal(accepted.booking.assignment, "accepted");
  assert.equal(accepted.booking.creditsCharged, created.booking.creditsCharged);
  assert.equal(request?.status, "accepted");
  assert.equal(request?.date, "Friday · 8:00 PM");
  assert.equal(request?.assignedProviderId, provider.id);
  assert.equal(request?.proposedDate, undefined);
  assert.equal(memberView?.assignment, "accepted");
  assert.equal(memberView?.date, "Friday · 8:00 PM");
  assert.equal((await listJobsForProvider(provider)).some((row) => row.id === opened.id), true);
  assert.equal((await listInboxForProvider(provider)).some((row) => row.id === opened.id), false);
});

test("member can decline a proposed time and the request reopens without refunding Credits", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const provider = await resolveProviderAccount({
    email: "tide@localhost",
    displayName: "Sofia Alvarez",
    memberId: "provider_tide_tone",
  });
  assert.ok(provider);

  const created = await createMemberBooking({
    member,
    serviceId: "sports-massage",
    date: "Tomorrow · 7:30 PM",
    mode: "At home · Miami Beach",
    enforceCredits: true,
  });
  const opened = await requestForBooking(created.booking.id);
  assert.ok(opened);
  await proposeRequestTime({provider, requestId: opened.id, date: "Friday · 8:00 PM"});
  const before = await getMemberBilling(member);

  const declined = await declineProposedBookingTime({member, bookingId: created.booking.id});
  const after = await getMemberBilling(member);
  const request = await requestForBooking(created.booking.id);
  const memberView = (await listMemberBookings(member.id))[0];

  assert.equal(declined.creditsApplied, false);
  assert.equal(declined.availableCredits, before.wallet.availableCredits);
  assert.equal(after.wallet.availableCredits, before.wallet.availableCredits);
  assert.equal(declined.booking.date, "Tomorrow · 7:30 PM");
  assert.equal(declined.booking.assignment, "unassigned");
  assert.equal(request?.status, "open");
  assert.equal(request?.date, "Tomorrow · 7:30 PM");
  assert.equal(request?.assignedProviderId, undefined);
  assert.equal(request?.proposedDate, undefined);
  assert.equal(memberView?.assignment, "unassigned");
  assert.equal(memberView?.proposedDate, undefined);
  assert.equal((await listInboxForProvider(provider)).some((row) => row.id === opened.id), true);
});

test("rejects accept and decline when the provider has not proposed a time", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home · Brickell",
    enforceCredits: true,
  });

  await assert.rejects(
    () => acceptProposedBookingTime({member, bookingId: created.booking.id}),
    (error: unknown) => error instanceof BookingError && /no proposed time/i.test(error.message),
  );
  await assert.rejects(
    () => declineProposedBookingTime({member, bookingId: created.booking.id}),
    (error: unknown) => error instanceof BookingError && /no proposed time/i.test(error.message),
  );
});

test("does not let a member accept or decline another member's proposed time", async () => {
  const owner = await seedMember("member_ava");
  await fund(owner, 200);
  const provider = await resolveProviderAccount({
    email: "tide@localhost",
    displayName: "Sofia Alvarez",
    memberId: "provider_tide_tone",
  });
  assert.ok(provider);
  const created = await createMemberBooking({
    member: owner,
    serviceId: "facial",
    date: "Thursday · 3:00 PM",
    mode: "At home",
    enforceCredits: true,
  });
  const opened = await requestForBooking(created.booking.id);
  assert.ok(opened);
  await proposeRequestTime({provider, requestId: opened.id, date: "Friday · 4:00 PM"});

  const other = await rememberMember({
    id: "member_other",
    email: "other@joinsalu.com",
    displayName: "Other Member",
    planId: "member",
  });

  await assert.rejects(
    () => acceptProposedBookingTime({member: other, bookingId: created.booking.id}),
    (error: unknown) => error instanceof BookingError && error.status === 404,
  );
  await assert.rejects(
    () => declineProposedBookingTime({member: other, bookingId: created.booking.id}),
    (error: unknown) => error instanceof BookingError && error.status === 404,
  );
  assert.equal((await requestForBooking(created.booking.id))?.status, "proposed");
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

  const accepted = await handleBookingsFetch(new Request("http://localhost/api/bookings/accept-proposal", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({id: "b_missing"}),
  }));
  assert.equal(accepted.status, 401);
  assert.equal(((await accepted.json()) as {source: string}).source, "demo");

  const declined = await handleBookingsFetch(new Request("http://localhost/api/bookings/decline-proposal", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({id: "b_missing"}),
  }));
  assert.equal(declined.status, 401);
  assert.equal(((await declined.json()) as {source: string}).source, "demo");
});
