import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {resetBookingMemory, createMemberBooking, cancelMemberBooking, listMemberBookings} from "../bookings/service.ts";
import {handleProviderFetch} from "../provider/handlers.ts";
import {
  acceptRequest,
  blockProviderTime,
  declineRequest,
  ensureWalkthroughRequest,
  listInboxForProvider,
  listJobsForProvider,
  listProviderBlocks,
  proposeRequestTime,
  ProviderError,
  requestForBooking,
  resetProviderWorkspaceMemory,
  resolveProviderAccount,
} from "../provider/service.ts";
import {applyCreditEntry, rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import {liveServiceId} from "../providers/catalog.ts";
import {resetProviderMemory, submitApplication, updateApplicationStatus} from "../providers/service.ts";
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

async function seedProvider() {
  return resolveProviderAccount({
    email: "tide@localhost",
    displayName: "Sofia Alvarez",
    memberId: "provider_tide_tone",
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

test("demo Tide & Tone email resolves to a provider account distinct from the member row", async () => {
  resetProviderWorkspaceMemory();
  const provider = await seedProvider();
  assert.ok(provider);
  assert.equal(provider.email, "tide@localhost");
  assert.equal(provider.practiceId, "tide-tone");
  assert.equal(provider.status, "demo");
  assert.ok(provider.serviceIds.includes("deep-tissue"));
});

test("member bookings open an assignable request the practice can accept", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const provider = await seedProvider();
  assert.ok(provider);

  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home · Brickell",
    enforceCredits: true,
  });

  assert.equal(created.booking.assignment, "unassigned");
  const opened = await requestForBooking(created.booking.id);
  assert.ok(opened);
  assert.equal(opened.status, "open");
  assert.equal(opened.practiceId, "tide-tone");
  assert.equal(opened.memberDisplayName, "Ava Ruiz");

  const inbox = await listInboxForProvider(provider);
  assert.equal(inbox.some((row) => row.id === opened.id), true);

  const accepted = await acceptRequest({provider, requestId: opened.id});
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.assignedProviderId, provider.id);

  const listed = await listMemberBookings(member.id);
  assert.equal(listed[0]?.assignment, "accepted");
  assert.equal((await listJobsForProvider(provider)).length, 1);
  assert.equal((await listInboxForProvider(provider)).length, 0);
});

test("decline and propose update the member-facing assignment", async () => {
  const member = await seedMember();
  await fund(member, 400);
  const provider = await seedProvider();
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

  const declined = await declineRequest({provider, requestId: opened.id});
  assert.equal(declined.status, "declined");
  assert.equal((await listMemberBookings(member.id))[0]?.assignment, "declined");

  const second = await createMemberBooking({
    member,
    serviceId: "lymphatic-massage",
    date: "Friday · 3:30 PM",
    mode: "At home · Miami-Dade",
    enforceCredits: true,
  });
  const next = await requestForBooking(second.booking.id);
  assert.ok(next);
  const proposed = await proposeRequestTime({provider, requestId: next.id, date: "Friday · 8:00 PM"});
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.proposedDate, "Friday · 8:00 PM");
  const memberView = (await listMemberBookings(member.id)).find((row) => row.id === second.booking.id);
  assert.equal(memberView?.assignment, "proposed");
  assert.equal(memberView?.proposedDate, "Friday · 8:00 PM");
});

test("demo provider can accept a labeled walkthrough request", async () => {
  resetProviderWorkspaceMemory();
  const provider = await seedProvider();
  assert.ok(provider);
  const seeded = await ensureWalkthroughRequest(provider);
  assert.ok(seeded);
  assert.equal(seeded.walkthrough, true);
  assert.match(seeded.note ?? "", /labeled walkthrough/i);

  const accepted = await acceptRequest({provider, requestId: seeded.id});
  assert.equal(accepted.status, "accepted");
  assert.equal((await listJobsForProvider(provider))[0]?.id, seeded.id);
});

test("blocked time cannot be double-booked and cannot overlap an accepted job", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const provider = await seedProvider();
  assert.ok(provider);

  const block = await blockProviderTime({provider, date: "Tomorrow · 6:00 PM", note: "Training"});
  assert.equal(block.date, "Tomorrow · 6:00 PM");
  assert.equal((await listProviderBlocks(provider)).length, 1);

  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home · Brickell",
    enforceCredits: true,
  });
  const opened = await requestForBooking(created.booking.id);
  assert.ok(opened);

  await assert.rejects(
    () => acceptRequest({provider, requestId: opened.id}),
    (error: unknown) => error instanceof ProviderError && /blocked/i.test(error.message),
  );
});

test("cancelling a member booking closes the provider request", async () => {
  const member = await seedMember();
  await fund(member, 200);
  await seedProvider();

  const created = await createMemberBooking({
    member,
    serviceId: "facial",
    date: "Thursday · 3:00 PM",
    mode: "At home",
    enforceCredits: true,
  });
  const opened = await requestForBooking(created.booking.id);
  assert.ok(opened);
  assert.equal(opened.status, "open");

  await cancelMemberBooking({member, bookingId: created.booking.id});
  const closed = await requestForBooking(created.booking.id);
  assert.equal(closed?.status, "cancelled");
});

test("another practice cannot accept a Tide & Tone request", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Tomorrow · 6:00 PM",
    mode: "At home",
    enforceCredits: true,
  });
  const opened = await requestForBooking(created.booking.id);
  assert.ok(opened);

  const other = await resolveProviderAccount({
    email: "form@localhost",
    displayName: "Form House",
    allowlistedEmails: [],
  });
  const outsider = other ?? {
    id: "prov_form_house",
    email: "form@localhost",
    displayName: "Form House",
    practiceId: "form-house",
    practiceName: "Form House Miami",
    status: "demo" as const,
    serviceIds: ["stretch"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await assert.rejects(
    () => acceptRequest({provider: outsider, requestId: opened.id}),
    (error: unknown) => error instanceof ProviderError && error.status === 404,
  );
});

test("approved Apply email can sign in and accept a live catalog booking", async () => {
  resetProviderMemory();
  const member = await seedMember();
  await fund(member, 200);
  const application = await submitApplication({
    fullName: "Camila Ortega",
    email: "camila.ortega@example.com",
    licenseType: "LMT",
    licenseNumber: "MA12345",
    mobileAtHome: true,
    neighborhoods: ["Brickell"],
    rateAsk: "$150 / visit",
    insuranceAttested: true,
  });
  await updateApplicationStatus({id: application.id, status: "approved"});

  const provider = await resolveProviderAccount({
    email: "camila.ortega@example.com",
    displayName: "Camila Ortega",
  });
  assert.ok(provider);
  assert.equal(provider.status, "approved");
  assert.equal(provider.practiceId, application.id);
  assert.equal(provider.displayName, "Camila Ortega");
  assert.ok(provider.serviceIds.includes(liveServiceId(application.id, "deep-tissue")));

  const created = await createMemberBooking({
    member,
    serviceId: liveServiceId(application.id, "deep-tissue"),
    date: "Tomorrow · 5:00 PM",
    mode: "At home · Brickell",
    enforceCredits: true,
  });
  assert.equal(created.booking.assignment, "unassigned");
  const opened = await requestForBooking(created.booking.id);
  assert.ok(opened);
  assert.equal(opened.practiceId, application.id);

  const accepted = await acceptRequest({provider, requestId: opened.id});
  assert.equal(accepted.status, "accepted");
  assert.equal((await listMemberBookings(member.id))[0]?.assignment, "accepted");
});

test("provider APIs stay demo without a session and do not need Stripe or Connect", async () => {
  const listed = await handleProviderFetch(new Request("http://localhost/api/provider/requests"));
  assert.equal(listed.status, 401);
  const inbox = await listed.json() as {source: string; requests: unknown[]};
  assert.equal(inbox.source, "demo");
  assert.deepEqual(inbox.requests, []);

  const accepted = await handleProviderFetch(new Request("http://localhost/api/provider/requests/accept", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({id: "req_missing"}),
  }));
  assert.equal(accepted.status, 401);
  const body = await accepted.json() as {source: string};
  assert.equal(body.source, "demo");

  const me = await handleProviderFetch(new Request("http://localhost/api/provider/me"));
  assert.equal(me.status, 200);
  const meBody = await me.json() as {source: string; provider: unknown};
  assert.equal(meBody.source, "demo");
  assert.equal(meBody.provider, null);
});
