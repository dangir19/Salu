import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {resetPaymentMemory, rememberMember} from "../payments/ledger.ts";
import {
  resetBookingMemory,
  createMemberBooking,
  createScheduledMemberBooking,
  assignMemberBooking,
  BookingError,
} from "../bookings/service.ts";
import {resetProviderMemory, submitApplication, updateApplicationStatus} from "../providers/service.ts";
import {resetProviderWorkspaceMemory, blockProviderTime} from "../provider/service.ts";
import {resetSchedulingMemory, replaceWeeklyAvailability, upsertOverride} from "../db/scheduling.ts";
import {getFreeSlots, blockDateToYmd, schedulingProviderId} from "../scheduling/slots.ts";
import {liveServiceId} from "../providers/catalog.ts";
import type {Member, ProviderAccount} from "../domain/types.ts";

// Monday 2026-09-28 (EDT, UTC-4) — fixed anchor so expectations are stable.
const MONDAY = "2026-09-28";
const TUESDAY = "2026-09-29";
const FROM_MONDAY = `${MONDAY}T00:00:00-04:00`;
const TO_TUESDAY = `${TUESDAY}T00:00:00-04:00`;
const MONDAY_9AM = `${MONDAY}T09:00:00-04:00`;
const MONDAY_10AM = `${MONDAY}T10:00:00-04:00`;
const MONDAY_11AM = `${MONDAY}T11:00:00-04:00`;

async function seedMember(id = "member_sched"): Promise<Member> {
  resetMemberMemory();
  resetPaymentMemory();
  resetBookingMemory();
  resetProviderMemory();
  resetProviderWorkspaceMemory();
  resetSchedulingMemory();
  return rememberMember({
    id,
    email: `${id}@joinsalu.com`,
    displayName: "Sched Tester",
    householdId: `hh_${id}`,
    planId: "platinum",
  });
}

async function seedApprovedProvider(name: string, email: string) {
  const application = await submitApplication({
    fullName: name,
    email,
    licenseType: "LMT",
    licenseNumber: "MA12345",
    mobileAtHome: true,
    neighborhoods: ["Brickell"],
    rateAsk: "$150 / visit",
    insuranceAttested: true,
  });
  await updateApplicationStatus({id: application.id, status: "approved"});
  const serviceId = liveServiceId(application.id, "deep-tissue");
  const accountId = schedulingProviderId(application.id);
  return {application, serviceId, accountId};
}

function stubAccount(accountId: string, serviceId: string): ProviderAccount {
  return {
    id: accountId,
    email: "provider@example.com",
    displayName: "Test Provider",
    practiceId: accountId.replace(/^prov_app_/, ""),
    practiceName: "Test Provider",
    status: "approved",
    serviceIds: [serviceId],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function mondayHours(accountId: string) {
  await replaceWeeklyAvailability(accountId, [{dayOfWeek: 1, startMinutes: 540, endMinutes: 1020}]);
}

test("generates slots from weekly availability in America/New_York", async () => {
  const member = await seedMember();
  void member;
  const {serviceId, accountId} = await seedApprovedProvider("Ava Stone", "ava.stone@example.com");
  await mondayHours(accountId);

  const slots = await getFreeSlots({serviceId, fromISO: FROM_MONDAY, toISO: TO_TUESDAY, durationMinutes: 60});
  assert.equal(slots.length, 8);
  assert.equal(slots[0]!.startISO, MONDAY_9AM);
  assert.equal(slots[0]!.providerId, accountId);
  assert.equal(slots[0]!.providerName, "Ava Stone");
  assert.equal(slots[0]!.serviceId, serviceId);
  assert.equal(slots[7]!.startISO, `${MONDAY}T16:00:00-04:00`);
  assert.ok(slots[0]!.endISO.endsWith("-04:00"));
  assert.ok(slots[0]!.label.includes("Mon Sep 28"));
});

test("skips days without weekly windows and closed overrides", async () => {
  await seedMember();
  const {serviceId, accountId} = await seedApprovedProvider("Ava Stone", "ava.stone@example.com");
  await mondayHours(accountId);

  // Tuesday has no windows, so nothing is emitted there.
  const wide = await getFreeSlots({
    serviceId,
    fromISO: FROM_MONDAY,
    toISO: `${TUESDAY}T23:59:00-04:00`,
    durationMinutes: 60,
  });
  assert.ok(wide.every((slot) => slot.startISO.startsWith(MONDAY)));

  // Closing Monday via override removes every slot.
  await upsertOverride(accountId, {date: MONDAY, isClosed: true, note: "Holiday"});
  const closed = await getFreeSlots({serviceId, fromISO: FROM_MONDAY, toISO: TO_TUESDAY, durationMinutes: 60});
  assert.equal(closed.length, 0);
});

test("a custom override window replaces the weekly window", async () => {
  await seedMember();
  const {serviceId, accountId} = await seedApprovedProvider("Ava Stone", "ava.stone@example.com");
  await mondayHours(accountId);
  await upsertOverride(accountId, {date: MONDAY, startMinutes: 600, endMinutes: 720, isClosed: false});

  const slots = await getFreeSlots({serviceId, fromISO: FROM_MONDAY, toISO: TO_TUESDAY, durationMinutes: 60});
  assert.equal(slots.length, 2);
  assert.equal(slots[0]!.startISO, MONDAY_10AM);
  assert.equal(slots[1]!.startISO, MONDAY_11AM);
});

test("whole-day blocks remove the day", async () => {
  await seedMember();
  const {serviceId, accountId} = await seedApprovedProvider("Ava Stone", "ava.stone@example.com");
  await mondayHours(accountId);
  await blockProviderTime({provider: stubAccount(accountId, serviceId), date: MONDAY, note: "Day off"});

  const slots = await getFreeSlots({serviceId, fromISO: FROM_MONDAY, toISO: TO_TUESDAY, durationMinutes: 60});
  assert.equal(slots.length, 0);
});

test("blockDateToYmd parses ISO and free-text labels", () => {
  const ref = Date.parse("2026-09-21T12:00:00-04:00"); // a Monday
  assert.equal(blockDateToYmd("2026-09-28", ref), "2026-09-28");
  assert.equal(blockDateToYmd("Today · 4:00 PM", ref), "2026-09-21");
  assert.equal(blockDateToYmd("Tomorrow · 6:00 PM", ref), "2026-09-22");
  assert.equal(blockDateToYmd("Friday · 6:30 PM", ref), "2026-09-25");
  assert.equal(blockDateToYmd("Monday · 9:00 AM", ref), "2026-09-21");
});

test("overlapping bookings are subtracted from free slots", async () => {
  const member = await seedMember();
  const {serviceId, accountId} = await seedApprovedProvider("Ava Stone", "ava.stone@example.com");
  await mondayHours(accountId);

  await createMemberBooking({
    member,
    serviceId,
    date: "Mon Sep 28 · 10:00 AM – 11:00 AM",
    mode: "At home",
    providerId: accountId,
    startsAt: MONDAY_10AM,
    slotEnd: MONDAY_11AM,
    enforceCredits: false,
  });

  const slots = await getFreeSlots({serviceId, fromISO: FROM_MONDAY, toISO: TO_TUESDAY, durationMinutes: 60});
  assert.equal(slots.length, 7);
  assert.ok(!slots.some((slot) => slot.startISO === MONDAY_10AM));
  assert.ok(slots.some((slot) => slot.startISO === MONDAY_11AM));
});

test("booking the same slot twice is rejected with 409", async () => {
  const member = await seedMember();
  const {serviceId, accountId} = await seedApprovedProvider("Ava Stone", "ava.stone@example.com");
  await mondayHours(accountId);

  const first = await createScheduledMemberBooking({
    member,
    serviceId,
    providerId: accountId,
    slotStart: MONDAY_10AM,
    enforceCredits: false,
  });
  assert.equal(first.booking.providerId, accountId);
  assert.equal(first.booking.startsAt, MONDAY_10AM);
  assert.equal(first.booking.assignment, "assigned");

  await assert.rejects(
    () =>
      createScheduledMemberBooking({
        member,
        serviceId,
        providerId: accountId,
        slotStart: MONDAY_10AM,
        enforceCredits: false,
      }),
    (error: unknown) => error instanceof BookingError && error.status === 409,
  );
});

test("booking a slot creates a linked assigned request for the provider", async () => {
  const member = await seedMember();
  const {serviceId, accountId} = await seedApprovedProvider("Ava Stone", "ava.stone@example.com");
  await mondayHours(accountId);

  const result = await createScheduledMemberBooking({
    member,
    serviceId,
    providerId: accountId,
    slotStart: MONDAY_11AM,
    enforceCredits: false,
  });

  const provider = await import("../provider/service.ts");
  const request = await provider.requestForBooking(result.booking.id);
  assert.ok(request);
  assert.equal(request!.status, "assigned");
  assert.equal(request!.assignedProviderId, accountId);

  const jobs = await provider.listJobsForProvider(stubAccount(accountId, serviceId));
  assert.ok(jobs.some((job) => job.bookingId === result.booking.id));
});

test("assignment picks the provider with the fewest bookings that day", async () => {
  const member = await seedMember();
  const first = await seedApprovedProvider("Early Bird", "early.bird@example.com");
  const second = await seedApprovedProvider("Late Comer", "late.comer@example.com");
  await mondayHours(first.accountId);
  await mondayHours(second.accountId);

  // Load the first provider with a 10:00 booking.
  await createMemberBooking({
    member,
    serviceId: first.serviceId,
    date: "Mon Sep 28 · 10:00 AM – 11:00 AM",
    mode: "At home",
    providerId: first.accountId,
    startsAt: MONDAY_10AM,
    slotEnd: MONDAY_11AM,
    enforceCredits: false,
  });

  // 10:00 is taken for Early Bird, so Late Comer gets it.
  const atTen = await assignMemberBooking({member, serviceId: first.serviceId, startISO: MONDAY_10AM, enforceCredits: false});
  assert.equal(atTen.provider.id, second.accountId);
  assert.equal(atTen.booking.providerId, second.accountId);

  // 11:00 is free for both; both now have one booking that day,
  // so the tie-break goes to the earliest created provider.
  const atEleven = await assignMemberBooking({member, serviceId: first.serviceId, startISO: MONDAY_11AM, enforceCredits: false});
  assert.equal(atEleven.provider.id, first.accountId);
});

test("assignment returns 409 when nobody is free", async () => {
  const member = await seedMember();
  const {serviceId, accountId} = await seedApprovedProvider("Ava Stone", "ava.stone@example.com");
  await mondayHours(accountId);

  // Tuesday has no availability windows, so the slot cannot be served.
  await assert.rejects(
    () => assignMemberBooking({member, serviceId, startISO: `${TUESDAY}T10:00:00-04:00`, enforceCredits: false}),
    (error: unknown) => error instanceof BookingError && error.status === 409,
  );
});
