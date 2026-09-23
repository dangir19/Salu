import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {createBooking} from "../atlas/tools.ts";
import {resetBookingMemory, createMemberBooking, cancelMemberBooking, listMemberBookings} from "../bookings/service.ts";
import {handleProviderFetch} from "../provider/handlers.ts";
import {
  acceptRequest,
  blockProviderTime,
  createAssignedRequestFromBooking,
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
import {
  deleteOverride,
  listAvailability,
  listOverrides,
  replaceWeeklyAvailability,
  resetSchedulingMemory,
  upsertOverride,
} from "../db/scheduling.ts";
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

test("Atlas create_booking opens an assignable provider request", async () => {
  const member = await seedMember();
  await fund(member, 200);
  const provider = await seedProvider();
  assert.ok(provider);

  const result = await createBooking(
    {serviceId: "deep-tissue", date: "Tomorrow · 6:15 PM", mode: "At home · Brickell"},
    {member, planId: "platinum", enforceCredits: true},
  );
  assert.equal(result.source, "server");
  assert.equal(result.booking.assignment, "unassigned");
  const opened = await requestForBooking(result.booking.id);
  assert.ok(opened);
  assert.equal(opened.practiceId, "tide-tone");

  const accepted = await acceptRequest({provider, requestId: opened.id});
  assert.equal(accepted.status, "accepted");
  assert.equal((await listMemberBookings(member.id))[0]?.assignment, "accepted");
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
    resumeUrl: "https://linkedin.com/in/camila-ortega",
    bgCheckConsent: true,
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

test("assigned requests from the scheduling engine reach the provider inbox", async () => {
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
  const assigned = await createAssignedRequestFromBooking({
    booking: created.booking,
    member,
    providerId: provider.id,
  });
  assert.ok(assigned);
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.assignedProviderId, provider.id);

  const inbox = await listInboxForProvider(provider);
  assert.ok(inbox.some((row) => row.id === assigned.id && row.status === "assigned"));

  const accepted = await acceptRequest({provider, requestId: assigned.id});
  assert.equal(accepted.status, "accepted");
  assert.equal((await listMemberBookings(member.id))[0]?.assignment, "accepted");
});

test("provider weekly availability and date overrides round-trip", async () => {
  resetSchedulingMemory();
  const providerId = "prov_availability_test";

  const windows = await replaceWeeklyAvailability(providerId, [
    {dayOfWeek: 1, startMinutes: 540, endMinutes: 780},
    {dayOfWeek: 3, startMinutes: 960, endMinutes: 1200},
  ]);
  assert.equal(windows.length, 2);
  const listed = await listAvailability(providerId);
  assert.deepEqual(listed.map((window) => [window.dayOfWeek, window.startMinutes, window.endMinutes]), [
    [1, 540, 780],
    [3, 960, 1200],
  ]);

  const replaced = await replaceWeeklyAvailability(providerId, [
    {dayOfWeek: 6, startMinutes: 600, endMinutes: 840},
  ]);
  assert.equal(replaced.length, 1);
  assert.equal((await listAvailability(providerId)).length, 1);

  const override = await upsertOverride(providerId, {
    date: "2026-10-05",
    isClosed: true,
    note: "Training day",
  });
  assert.equal(override.date, "2026-10-05");
  assert.equal(override.isClosed, true);
  assert.equal((await listOverrides(providerId)).length, 1);

  const custom = await upsertOverride(providerId, {
    date: "2026-10-05",
    isClosed: false,
    startMinutes: 600,
    endMinutes: 720,
    note: "Half day",
  });
  assert.equal(custom.id, override.id);
  assert.equal(custom.isClosed, false);
  assert.equal((await listOverrides(providerId)).length, 1);

  assert.equal(await deleteOverride(providerId, override.id), true);
  assert.equal((await listOverrides(providerId)).length, 0);
  assert.equal(await deleteOverride(providerId, "ov_missing"), false);
});
