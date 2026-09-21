import type {Booking, Member} from "../domain/types";
import {registerNativeAccount} from "../auth/credentials";
import {
  assignMemberBooking,
  createScheduledMemberBooking,
  listBookingLineItems,
  listOrgBookings,
} from "../bookings/service";
import {getOrgBilling} from "../payments/org-ledger";

export class BusinessError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BusinessError";
    this.status = status;
  }
}

export type OrgType = "senior_facility" | "hotel" | "corporate" | "other";
export type OrgRole = "admin" | "staff";

export type Org = {
  id: string;
  name: string;
  orgType: OrgType;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  address: string | null;
  billingEmail: string | null;
  status: string;
  stripeCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OrgMembership = {org: Org; role: OrgRole; availableCredits: number};

type StoredOrgMember = {
  id: string;
  orgId: string;
  memberId: string;
  role: OrgRole;
  createdAt: string;
};

type StoredRecurringOrder = {
  id: string;
  orgId: string;
  serviceId: string;
  providerId: string | null;
  recipientName: string | null;
  recipientRoom: string | null;
  weekday: number;
  timeLocal: string;
  startDate: string;
  endDate: string;
  status: string;
  createdBy: string;
  createdAt: string;
};

// Service-layer memory fallback (D1 write-through when available), mirroring
// the bookings service pattern.
const orgs = new Map<string, Org>();
const memberships = new Map<string, StoredOrgMember>();
const recurringOrders = new Map<string, StoredRecurringOrder>();

export function resetBusinessMemory(): void {
  orgs.clear();
  memberships.clear();
  recurringOrders.clear();
}

const ORG_TYPES: OrgType[] = ["senior_facility", "hotel", "corporate", "other"];

function membershipKey(orgId: string, memberId: string): string {
  return `${orgId}:${memberId}`;
}

function rowToOrg(row: {
  id: string;
  name: string;
  orgType: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  address: string | null;
  billingEmail: string | null;
  status: string;
  stripeCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}): Org {
  return {
    ...row,
    orgType: (ORG_TYPES as string[]).includes(row.orgType) ? (row.orgType as OrgType) : "other",
  };
}

function orgRow(org: Org) {
  return {
    id: org.id,
    name: org.name,
    orgType: org.orgType,
    contactName: org.contactName,
    contactEmail: org.contactEmail,
    contactPhone: org.contactPhone,
    address: org.address,
    billingEmail: org.billingEmail,
    status: org.status,
    stripeCustomerId: org.stripeCustomerId,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

async function storedOrg(orgId: string): Promise<Org | null> {
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    const row = await db.getOrganizationById(orgId);
    if (row) {
      const org = rowToOrg(row);
      orgs.set(org.id, org);
      return org;
    }
  } catch {
    // Fall through to memory.
  }
  return orgs.get(orgId) ?? null;
}

async function storedMembership(orgId: string, memberId: string): Promise<StoredOrgMember | null> {
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    const row = await db.getMembershipForMember(orgId, memberId);
    if (row) {
      const member: StoredOrgMember = {
        id: row.id,
        orgId: row.orgId,
        memberId: row.memberId,
        role: row.role === "admin" ? "admin" : "staff",
        createdAt: row.createdAt,
      };
      memberships.set(membershipKey(orgId, memberId), member);
      return member;
    }
  } catch {
    // Fall through to memory.
  }
  return memberships.get(membershipKey(orgId, memberId)) ?? null;
}

async function storedMembershipsForMember(memberId: string): Promise<StoredOrgMember[]> {
  const rows: StoredOrgMember[] = [];
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    const persisted = await db.getMembershipsForMember(memberId);
    if (persisted) {
      for (const row of persisted) {
        const member: StoredOrgMember = {
          id: row.id,
          orgId: row.orgId,
          memberId: row.memberId,
          role: row.role === "admin" ? "admin" : "staff",
          createdAt: row.createdAt,
        };
        memberships.set(membershipKey(member.orgId, member.memberId), member);
        rows.push(member);
      }
      return rows;
    }
  } catch {
    // Fall through to memory.
  }
  for (const member of memberships.values()) {
    if (member.memberId === memberId) rows.push(member);
  }
  return rows;
}

async function storedRecurringOrders(orgId: string): Promise<StoredRecurringOrder[]> {
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    const persisted = await db.listRecurringOrders(orgId);
    if (persisted) {
      const rows = persisted.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        serviceId: row.serviceId,
        providerId: row.providerId,
        recipientName: row.recipientName,
        recipientRoom: row.recipientRoom,
        weekday: row.weekday,
        timeLocal: row.timeLocal,
        startDate: row.startDate,
        endDate: row.endDate,
        status: row.status,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      }));
      for (const row of rows) recurringOrders.set(row.id, row);
      return rows;
    }
  } catch {
    // Fall through to memory.
  }
  return [...recurringOrders.values()]
    .filter((row) => row.orgId === orgId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function publicOrg(org: Org): Omit<Org, "stripeCustomerId"> {
  const rest: Omit<Org, "stripeCustomerId"> = {...org};
  delete (rest as Partial<Org>).stripeCustomerId;
  return rest;
}

/** Approve, suspend, or otherwise change an org's status (admin path). */
export async function updateOrgStatus(orgId: string, status: "pending" | "active" | "suspended"): Promise<Org> {
  const org = await storedOrg(orgId);
  if (!org) throw new BusinessError("That business was not found.", 404);
  const next: Org = {...org, status, updatedAt: new Date().toISOString()};
  orgs.set(orgId, next);
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    const row = await db.updateOrganizationStatus(orgId, status);
    if (row) orgs.set(orgId, rowToOrg(row));
  } catch {
    // Memory fallback.
  }
  return orgs.get(orgId) ?? next;
}

export async function signupBusiness(input: {
  orgName?: string | null;
  orgType?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  address?: string | null;
  billingEmail?: string | null;
  password?: string | null;
  ip?: string | null;
}): Promise<{ok: true; org: Org; member: Member} | {ok: false; error: string; status: number}> {
  const orgName = (input.orgName ?? "").trim();
  const contactName = (input.contactName ?? "").trim();
  if (!orgName) return {ok: false, error: "Name your business to get started.", status: 400};
  if (!contactName) return {ok: false, error: "Add a contact name for this business.", status: 400};
  const orgType: OrgType = (ORG_TYPES as string[]).includes(input.orgType ?? "")
    ? (input.orgType as OrgType)
    : "other";

  const account = await registerNativeAccount({
    email: input.contactEmail,
    password: input.password,
    displayName: contactName,
    ip: input.ip,
  });
  if (!account.ok) return {ok: false, error: account.error, status: account.status};
  const member = account.member;

  const now = new Date().toISOString();
  const org: Org = {
    id: `org_${crypto.randomUUID()}`,
    name: orgName,
    orgType,
    contactName,
    contactEmail: member.email,
    contactPhone: input.contactPhone?.trim() || null,
    address: input.address?.trim() || null,
    billingEmail: input.billingEmail?.trim() || null,
    status: "pending",
    stripeCustomerId: null,
    createdAt: now,
    updatedAt: now,
  };
  orgs.set(org.id, org);
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    await db.insertOrganization(orgRow(org));
  } catch {
    // Memory remains the source of truth when D1 is unavailable.
  }

  const orgMember: StoredOrgMember = {
    id: `om_${crypto.randomUUID()}`,
    orgId: org.id,
    memberId: member.id,
    role: "admin",
    createdAt: now,
  };
  memberships.set(membershipKey(org.id, member.id), orgMember);
  try {
    const db = await import("../db/orgs");
    await db.insertOrgMember({
      id: orgMember.id,
      orgId: orgMember.orgId,
      memberId: orgMember.memberId,
      role: orgMember.role,
      createdAt: orgMember.createdAt,
    });
  } catch {
    // Memory fallback.
  }

  // Create the org wallet (memory) and its zero-balance row (D1) so billing
  // reads work immediately.
  await getOrgBilling(org.id);
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    await db.upsertOrgWallet(org.id, 0);
  } catch {
    // Memory fallback.
  }

  return {ok: true, org, member};
}

export async function getMemberOrgs(memberId: string): Promise<OrgMembership[]> {
  const rows = await storedMembershipsForMember(memberId);
  const result: OrgMembership[] = [];
  for (const row of rows) {
    const org = await storedOrg(row.orgId);
    if (!org) continue;
    const billing = await getOrgBilling(org.id).catch(() => null);
    result.push({org, role: row.role, availableCredits: billing?.wallet.availableCredits ?? 0});
  }
  return result;
}

/**
 * Throws 404 when the member is not on this org, 403 when their role is not
 * allowed or the org is not approved yet.
 */
export async function requireOrgRole(
  memberId: string,
  orgId: string,
  roles: OrgRole[] = ["admin", "staff"],
): Promise<{org: Org; role: OrgRole}> {
  const org = await storedOrg(orgId);
  if (!org) throw new BusinessError("That business was not found.", 404);
  const membership = await storedMembership(orgId, memberId);
  if (!membership) throw new BusinessError("That business was not found.", 404);
  if (org.status !== "active") {
    throw new BusinessError("This business account is pending approval.", 403);
  }
  if (!roles.includes(membership.role)) {
    throw new BusinessError("You do not have permission for that.", 403);
  }
  return {org, role: membership.role};
}

export async function placeOrgOrder(input: {
  member: Member;
  orgId: string;
  serviceId: string;
  slotStart: string;
  providerId?: string | null;
  mode?: string | null;
  recipientName?: string | null;
  recipientRoom?: string | null;
  enforceCredits: boolean;
}): Promise<{
  booking: Booking;
  provider: {id: string; name: string};
  availableCredits: number;
}> {
  await requireOrgRole(input.member.id, input.orgId);
  const orgFields = {
    orgId: input.orgId,
    recipientName: input.recipientName?.trim() || undefined,
    recipientRoom: input.recipientRoom?.trim() || undefined,
  };
  if (input.providerId) {
    const result = await createScheduledMemberBooking({
      member: input.member,
      serviceId: input.serviceId,
      mode: input.mode ?? undefined,
      providerId: input.providerId,
      slotStart: input.slotStart,
      enforceCredits: input.enforceCredits,
      ...orgFields,
    });
    return result;
  }
  const result = await assignMemberBooking({
    member: input.member,
    serviceId: input.serviceId,
    startISO: input.slotStart,
    mode: input.mode ?? undefined,
    enforceCredits: input.enforceCredits,
    ...orgFields,
  });
  const billing = await getOrgBilling(input.orgId).catch(() => null);
  return {
    booking: result.booking,
    provider: result.provider,
    availableCredits: billing?.wallet.availableCredits ?? 0,
  };
}

export type OrgOrder = {
  booking: Booking;
  lineItems: Array<{id: string; label: string; quantity: number; unitCredits: number; totalCredits: number}>;
  orderedBy: string | null;
};

export type OrgOrderSummary = {
  orderCount: number;
  creditsSpent: number;
  creditsRefunded: number;
};

export async function listOrgOrders(orgId: string): Promise<{orders: OrgOrder[]; summary: OrgOrderSummary}> {
  const bookings = await listOrgBookings(orgId);
  const {findMemberRecord} = await import("../auth/members");
  const orders: OrgOrder[] = [];
  let creditsSpent = 0;
  let creditsRefunded = 0;
  for (const booking of bookings) {
    const items = await listBookingLineItems(booking.id);
    const orderedByMember = await findMemberRecord({id: booking.memberId}).catch(() => null);
    orders.push({
      booking,
      lineItems: items.map((item) => ({
        id: item.id,
        label: item.label,
        quantity: item.quantity,
        unitCredits: item.unitCredits,
        totalCredits: item.totalCredits,
      })),
      orderedBy: orderedByMember?.displayName ?? null,
    });
    if (booking.status === "cancelled") {
      creditsRefunded += booking.creditsCharged;
    } else {
      creditsSpent += booking.creditsCharged;
    }
  }
  return {
    orders,
    summary: {orderCount: bookings.length, creditsSpent, creditsRefunded},
  };
}

const NY_TZ = "America/New_York";

const nyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Convert a New York wall-clock time (YYYY-MM-DD + HH:MM) to an ISO UTC
 * string, handling EST/EDT by measuring the zone offset with Intl.
 */
export function nyISO(dateStr: string, timeStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    throw new BusinessError("That date or time is not valid.");
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const parts = Object.fromEntries(nyFormatter.formatToParts(new Date(asUtc)).map((part) => [part.type, part.value]));
  const partHour = parts.hour === "24" ? 0 : Number(parts.hour);
  const renderedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), partHour, Number(parts.minute));
  const instant = new Date(asUtc + (asUtc - renderedAsUtc));
  const check = Object.fromEntries(nyFormatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const checkHour = check.hour === "24" ? "00" : check.hour;
  const local = `${check.year}-${check.month}-${check.day} ${checkHour}:${check.minute}`;
  if (local !== `${dateStr} ${timeStr}`) {
    throw new BusinessError("That time does not exist on that date (daylight saving change).");
  }
  return instant.toISOString();
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export type RecurringOrderInput = {
  member: Member;
  orgId: string;
  serviceId: string;
  weekday: number;
  timeLocal: string;
  startDate: string;
  endDate: string;
  recipientName?: string | null;
  recipientRoom?: string | null;
  providerId?: string | null;
  enforceCredits: boolean;
};

export type RecurringOrderResult = {
  schedule: StoredRecurringOrder;
  created: Array<{slotStart: string; bookingId: string; provider: {id: string; name: string}}>;
  failed: Array<{slotStart: string; error: string}>;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function createRecurringOrder(input: RecurringOrderInput): Promise<RecurringOrderResult> {
  await requireOrgRole(input.member.id, input.orgId, ["admin"]);
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    throw new BusinessError("Weekday must be 0 (Sunday) through 6 (Saturday).");
  }
  if (!TIME_RE.test(input.timeLocal)) {
    throw new BusinessError("Time must be HH:MM in 24-hour format.");
  }
  if (!DATE_RE.test(input.startDate) || !DATE_RE.test(input.endDate)) {
    throw new BusinessError("Start and end dates must be YYYY-MM-DD.");
  }
  if (input.endDate < input.startDate) {
    throw new BusinessError("The end date must be on or after the start date.");
  }
  const rangeDays = Math.round((Date.parse(input.endDate) - Date.parse(input.startDate)) / 86400000);
  if (rangeDays > 26 * 7) {
    throw new BusinessError("A recurring order can span at most 26 weeks.");
  }

  const now = new Date().toISOString();
  const schedule: StoredRecurringOrder = {
    id: `ro_${crypto.randomUUID()}`,
    orgId: input.orgId,
    serviceId: input.serviceId,
    providerId: input.providerId ?? null,
    recipientName: input.recipientName?.trim() || null,
    recipientRoom: input.recipientRoom?.trim() || null,
    weekday: input.weekday,
    timeLocal: input.timeLocal,
    startDate: input.startDate,
    endDate: input.endDate,
    status: "active",
    createdBy: input.member.id,
    createdAt: now,
  };
  recurringOrders.set(schedule.id, schedule);
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    await db.insertRecurringOrder(schedule);
  } catch {
    // Memory fallback.
  }

  const slotStarts: string[] = [];
  for (let date = input.startDate; date <= input.endDate; date = addDays(date, 1)) {
    const [y, m, d] = date.split("-").map(Number);
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === input.weekday) {
      slotStarts.push(nyISO(date, input.timeLocal));
    }
    if (slotStarts.length >= 26) break;
  }

  const created: RecurringOrderResult["created"] = [];
  const failed: RecurringOrderResult["failed"] = [];
  for (const slotStart of slotStarts) {
    try {
      const order = await placeOrgOrder({
        member: input.member,
        orgId: input.orgId,
        serviceId: input.serviceId,
        slotStart,
        providerId: input.providerId,
        recipientName: input.recipientName,
        recipientRoom: input.recipientRoom,
        enforceCredits: input.enforceCredits,
      });
      created.push({slotStart, bookingId: order.booking.id, provider: order.provider});
    } catch (error) {
      failed.push({slotStart, error: error instanceof Error ? error.message : "Could not place this order."});
    }
  }
  return {schedule, created, failed};
}

export async function listRecurringOrders(orgId: string): Promise<StoredRecurringOrder[]> {
  return storedRecurringOrders(orgId);
}

export type StaffMemberDisplay = {
  memberId: string;
  email: string | null;
  displayName: string | null;
  role: OrgRole;
};

async function storedOrgMembers(orgId: string): Promise<StoredOrgMember[]> {
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    const persisted = await db.listOrgMembers(orgId);
    if (persisted) {
      const rows = persisted.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        memberId: row.memberId,
        role: row.role === "admin" ? ("admin" as OrgRole) : ("staff" as OrgRole),
        createdAt: row.createdAt,
      }));
      for (const row of rows) memberships.set(membershipKey(row.orgId, row.memberId), row);
      return rows;
    }
  } catch {
    // Fall through to memory.
  }
  return [...memberships.values()]
    .filter((row) => row.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listStaffMembers(orgId: string): Promise<StaffMemberDisplay[]> {
  const rows = await storedOrgMembers(orgId);
  const {findMemberRecord} = await import("../auth/members");
  const displays: StaffMemberDisplay[] = [];
  for (const row of rows) {
    const member = await findMemberRecord({id: row.memberId}).catch(() => null);
    displays.push({
      memberId: row.memberId,
      email: member?.email ?? null,
      displayName: member?.displayName ?? null,
      role: row.role,
    });
  }
  return displays;
}

export async function addStaffMember(input: {
  adminMember: Member;
  orgId: string;
  email: string;
}): Promise<Member> {
  await requireOrgRole(input.adminMember.id, input.orgId, ["admin"]);
  const {findMemberRecord} = await import("../auth/members");
  const member = await findMemberRecord({email: input.email.trim().toLowerCase()});
  if (!member) {
    throw new BusinessError("No Salu account with that email — ask them to sign up first.", 404);
  }
  const existing = await storedMembership(input.orgId, member.id);
  if (!existing) {
    const row: StoredOrgMember = {
      id: `om_${crypto.randomUUID()}`,
      orgId: input.orgId,
      memberId: member.id,
      role: "staff",
      createdAt: new Date().toISOString(),
    };
    memberships.set(membershipKey(input.orgId, member.id), row);
    try {
      const db = await import("../db/orgs");
      await db.insertOrgMember({
        id: row.id,
        orgId: row.orgId,
        memberId: row.memberId,
        role: row.role,
        createdAt: row.createdAt,
      });
    } catch {
      // Memory fallback.
    }
  }
  return member;
}
