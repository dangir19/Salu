import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {resetCredentialMemory} from "../auth/credentials.ts";
import {resetBookingMemory, createMemberBooking, listBookingLineItems} from "../bookings/service.ts";
import {resetOrgLedgerMemory, getOrgBilling, applyOrgCreditEntry, spendOrgBookingCredits, restoreOrgBookingCredits} from "../payments/org-ledger.ts";
import {
  BusinessError,
  addStaffMember,
  createRecurringOrder,
  getMemberOrgs,
  listStaffMembers,
  nyISO,
  placeOrgOrder,
  requireOrgRole,
  resetBusinessMemory,
  signupBusiness,
  updateOrgStatus,
} from "../business/service.ts";
import type {Member} from "../domain/types.ts";

function resetAll(): void {
  resetMemberMemory();
  resetCredentialMemory();
  resetBookingMemory();
  resetOrgLedgerMemory();
  resetBusinessMemory();
}

let counter = 0;
async function signup(ipSuffix: string) {
  counter += 1;
  return signupBusiness({
    orgName: `Sunrise Senior Living ${counter}`,
    orgType: "senior_facility",
    contactName: "Marta Alvarez",
    contactEmail: `marta${counter}@sunrise.example`,
    contactPhone: "305-555-0100",
    password: "correct-horse-battery-staple",
    ip: `10.0.0.${ipSuffix}`,
  });
}

async function seedActiveOrg() {
  const result = await signup("7");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("signup failed");
  return result;
}

test("signupBusiness creates a pending org, admin membership, and a zero wallet", async () => {
  resetAll();
  const result = await signup("1");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("signup failed");
  assert.equal(result.org.status, "pending");
  assert.equal(result.org.orgType, "senior_facility");
  assert.equal(result.member.email, "marta1@sunrise.example");

  const orgs = await getMemberOrgs(result.member.id);
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0]!.org.id, result.org.id);
  assert.equal(orgs[0]!.role, "admin");
  assert.equal(orgs[0]!.availableCredits, 0);

  const billing = await getOrgBilling(result.org.id);
  assert.equal(billing.wallet.availableCredits, 0);
  assert.deepEqual(billing.transactions, []);
});

test("signupBusiness rejects a duplicate contact email with 409", async () => {
  resetAll();
  const first = await signup("2");
  assert.equal(first.ok, true);
  const second = await signupBusiness({
    orgName: "Another Business",
    orgType: "hotel",
    contactName: "Marta Alvarez",
    contactEmail: "marta2@sunrise.example",
    password: "correct-horse-battery-staple",
    ip: "10.0.0.3",
  });
  assert.equal(second.ok, false);
  if (second.ok) throw new Error("expected failure");
  assert.equal(second.status, 409);
});

test("signupBusiness validates the org name and type", async () => {
  resetAll();
  const missing = await signupBusiness({
    orgName: "   ",
    contactName: "Marta Alvarez",
    contactEmail: "novalid4@sunrise.example",
    password: "correct-horse-battery-staple",
    ip: "10.0.0.4",
  });
  assert.equal(missing.ok, false);
  if (missing.ok) throw new Error("expected failure");
  assert.equal(missing.status, 400);

  const unknown = await signupBusiness({
    orgName: "Type Test",
    orgType: "spaceship",
    contactName: "Marta Alvarez",
    contactEmail: "novalid5@sunrise.example",
    password: "correct-horse-battery-staple",
    ip: "10.0.0.5",
  });
  assert.equal(unknown.ok, true);
  if (!unknown.ok) throw new Error("signup failed");
  assert.equal(unknown.org.orgType, "other");
});

test("requireOrgRole rejects non-members (404) and pending orgs (403)", async () => {
  resetAll();
  const result = await seedActiveOrg();

  await assert.rejects(
    requireOrgRole("member_stranger", result.org.id),
    (error: unknown) => error instanceof BusinessError && error.status === 404,
  );
  await assert.rejects(
    requireOrgRole(result.member.id, result.org.id),
    (error: unknown) =>
      error instanceof BusinessError &&
      error.status === 403 &&
      error.message === "This business account is pending approval.",
  );
});

test("placeOrgOrder for a pending org throws 403 before touching slots", async () => {
  resetAll();
  const result = await seedActiveOrg();
  await assert.rejects(
    placeOrgOrder({
      member: result.member,
      orgId: result.org.id,
      serviceId: "deep-tissue",
      slotStart: new Date(Date.now() + 86400000).toISOString(),
      enforceCredits: false,
    }),
    (error: unknown) => error instanceof BusinessError && error.status === 403,
  );
});

test("createRecurringOrder rejects an invalid weekday and bad date range", async () => {
  resetAll();
  const result = await seedActiveOrg();
  await updateOrgStatus(result.org.id, "active");
  await assert.rejects(
    createRecurringOrder({
      member: result.member,
      orgId: result.org.id,
      serviceId: "deep-tissue",
      weekday: 7,
      timeLocal: "09:00",
      startDate: "2026-10-05",
      endDate: "2026-11-05",
      enforceCredits: false,
    }),
    (error: unknown) => error instanceof BusinessError && error.status === 400,
  );
  await assert.rejects(
    createRecurringOrder({
      member: result.member,
      orgId: result.org.id,
      serviceId: "deep-tissue",
      weekday: 1,
      timeLocal: "9:00",
      startDate: "2026-10-05",
      endDate: "2026-11-05",
      enforceCredits: false,
    }),
    (error: unknown) => error instanceof BusinessError && error.status === 400,
  );
  await assert.rejects(
    createRecurringOrder({
      member: result.member,
      orgId: result.org.id,
      serviceId: "deep-tissue",
      weekday: 1,
      timeLocal: "09:00",
      startDate: "2026-11-05",
      endDate: "2026-10-05",
      enforceCredits: false,
    }),
    (error: unknown) => error instanceof BusinessError && error.status === 400,
  );
});

test("org ledger top-up, spend, and restore round-trip with idempotency", async () => {
  resetAll();
  const result = await seedActiveOrg();
  const orgId = result.org.id;

  const topup = await applyOrgCreditEntry({orgId, credits: 200, kind: "topup", label: "Demo top-up"});
  assert.ok(topup);
  assert.equal((await getOrgBilling(orgId)).wallet.availableCredits, 200);

  const spent = await spendOrgBookingCredits({
    orgId,
    credits: 150,
    bookingId: "b_demo",
    label: "Deep Tissue Massage",
    enforce: true,
  });
  assert.equal(spent.applied, true);
  assert.equal(spent.availableCredits, 50);

  const repeat = await spendOrgBookingCredits({
    orgId,
    credits: 150,
    bookingId: "b_demo",
    label: "Deep Tissue Massage",
    enforce: true,
  });
  assert.equal(repeat.applied, false);
  assert.equal(repeat.availableCredits, 50);

  const restored = await restoreOrgBookingCredits({
    orgId,
    credits: 150,
    bookingId: "b_demo",
    label: "Refund · Deep Tissue Massage",
  });
  assert.equal(restored.applied, true);
  assert.equal(restored.availableCredits, 200);
});

test("createMemberBooking with orgId writes a booking line item and sets org fields", async () => {
  resetAll();
  const result = await seedActiveOrg();
  const member = result.member;

  const created = await createMemberBooking({
    member,
    serviceId: "deep-tissue",
    date: "Friday · 7:00 PM",
    mode: "At home",
    enforceCredits: false,
    orgId: result.org.id,
    recipientName: "Ruth Goldstein",
    recipientRoom: "Apt 4B",
  });
  assert.equal(created.booking.orgId, result.org.id);
  assert.equal(created.booking.recipientName, "Ruth Goldstein");
  assert.equal(created.booking.recipientRoom, "Apt 4B");
  assert.equal(created.creditsApplied, false);

  const items = await listBookingLineItems(created.booking.id);
  assert.ok(items);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.label, "Deep Tissue Massage · Ruth Goldstein");
  assert.equal(items[0]!.quantity, 1);
  assert.equal(items[0]!.totalCredits, created.booking.creditsCharged);
  assert.equal(items[0]!.unitCredits, created.booking.creditsCharged);
});

test("createMemberBooking rejects packages for org orders", async () => {
  resetAll();
  const result = await seedActiveOrg();
  await assert.rejects(
    createMemberBooking({
      member: result.member,
      serviceId: "deep-tissue",
      date: "Friday · 7:00 PM",
      mode: "At home",
      packageName: "Reset Ritual",
      enforceCredits: false,
      orgId: result.org.id,
    }),
    (error: unknown) => error instanceof Error && /member-only|personal memberships/i.test(error.message),
  );
});

test("nyISO maps a New York wall time to UTC correctly across DST", async () => {
  resetAll();
  // 2026-07-06 is in EDT (UTC-4); 2026-01-05 is in EST (UTC-5).
  assert.equal(nyISO("2026-07-06", "09:00"), "2026-07-06T13:00:00.000Z");
  assert.equal(nyISO("2026-01-05", "09:00"), "2026-01-05T14:00:00.000Z");
  assert.throws(() => nyISO("2026-03-08", "02:30"), /does not exist/);
});

test("addStaffMember requires an existing Salu account", async () => {
  resetAll();
  const result = await seedActiveOrg();
  await updateOrgStatus(result.org.id, "active");
  await assert.rejects(
    addStaffMember({adminMember: result.member, orgId: result.org.id, email: "ghost@example.com"}),
    (error: unknown) => error instanceof BusinessError && error.status === 404,
  );
  const staff = await listStaffMembers(result.org.id);
  assert.equal(staff.length, 1);
  assert.equal(staff[0]!.role, "admin");
});

test("getMemberOrgs returns an empty list for members with no businesses", async () => {
  resetAll();
  const member: Member = {
    id: "member_lonely",
    email: "lonely@example.com",
    displayName: "Lonely Lou",
    planId: "member",
  };
  const orgs = await getMemberOrgs(member.id);
  assert.deepEqual(orgs, []);
});
