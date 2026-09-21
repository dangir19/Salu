import type {Booking, Member} from "../domain/types";
import {
  InsufficientCreditsError,
  restoreBookingCredits,
  spendBookingCredits,
} from "../payments/ledger";
import {spendOrgBookingCredits} from "../payments/org-ledger";
import {creditsForService, findCatalogPackage, findCatalogService} from "./catalog";

export class BookingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BookingError";
    this.status = status;
  }
}

export type UiBookingStatus = "Upcoming" | "Completed" | "Cancelled";

export type UiBooking = {
  id: string;
  serviceId: string;
  serviceName: string;
  provider: string;
  date: string;
  mode: string;
  credits: number;
  status: UiBookingStatus;
  packageName?: string;
  packageItem?: string;
  assignment?: "unassigned" | "accepted" | "proposed" | "declined" | "assigned";
  proposedDate?: string;
  source?: string;
};

const memory = new Map<string, Booking>();

export type BookingLineItem = {
  id: string;
  bookingId: string;
  label: string;
  quantity: number;
  unitCredits: number;
  totalCredits: number;
  createdAt: string;
};

const lineItemsMemory = new Map<string, BookingLineItem[]>();

export function resetBookingMemory(): void {
  memory.clear();
  lineItemsMemory.clear();
}

export function toUiBooking(booking: Booking): UiBooking {
  return {
    id: booking.id,
    serviceId: booking.serviceId,
    serviceName: booking.serviceName,
    provider: booking.provider,
    date: booking.date,
    mode: booking.mode,
    credits: booking.creditsCharged,
    status: booking.status === "cancelled" ? "Cancelled" : booking.status === "completed" ? "Completed" : "Upcoming",
    packageName: booking.packageName,
    packageItem: booking.packageItem,
    assignment: booking.assignment,
    proposedDate: booking.proposedDate,
    source: booking.source ?? "web",
  };
}

function sortBookings(rows: Booking[]): Booking[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function wrapProviderError(error: unknown, fallback: string): never {
  if (error instanceof BookingError) throw error;
  if (error instanceof Error) {
    const status = "status" in error && typeof (error as {status?: unknown}).status === "number"
      ? (error as {status: number}).status
      : 400;
    throw new BookingError(error.message || fallback, status);
  }
  throw new BookingError(fallback);
}

async function attachRequest(booking: Booking): Promise<Booking> {
  try {
    const provider = await import("../provider/service");
    if (booking.status === "cancelled") {
      await provider.cancelRequestForBooking(booking.id);
    } else {
      const {findMemberRecord} = await import("../auth/members");
      const member = await findMemberRecord({id: booking.memberId});
      if (member) await provider.createRequestFromBooking({booking, member});
    }
    const request = await provider.requestForBooking(booking.id);
    if (!request) return booking;
    return {
      ...booking,
      assignment: request.status === "open" || request.status === "cancelled"
        ? "unassigned"
        : request.status === "accepted" || request.status === "proposed" || request.status === "declined" || request.status === "assigned"
          ? request.status
          : "unassigned",
      proposedDate: request.proposedDate,
    };
  } catch {
    return booking;
  }
}

async function attachRequests(rows: Booking[]): Promise<Booking[]> {
  return Promise.all(rows.map(attachRequest));
}

async function persistBooking(booking: Booking): Promise<void> {
  memory.set(booking.id, booking);
  try {
    const db = await import("../db/bookings");
    await db.ensureBookingsSchema();
    const existing = await db.getBookingById(booking.id);
    if (existing) {
      await db.updateBooking(booking.id, booking);
    } else {
      await db.insertBooking(booking);
    }
  } catch {
    // D1 is optional until the bookings migration is applied.
  }
}

async function storedBooking(id: string): Promise<Booking | null> {
  try {
    const db = await import("../db/bookings");
    await db.ensureBookingsSchema();
    const persisted = await db.getBookingById(id);
    if (persisted) {
      memory.set(persisted.id, persisted);
      return persisted;
    }
  } catch {
    // Fall through to memory.
  }
  return memory.get(id) ?? null;
}

/**
 * Bookings that hold a real time slot for one provider, keyed by the
 * provider account id used by the scheduling engine. Used for overlap
 * checks when generating free slots.
 */
export async function listScheduledBookingsForProvider(providerId: string): Promise<Booking[]> {
  try {
    const db = await import("../db/bookings");
    await db.ensureBookingsSchema();
    const persisted = await db.listBookingsForProviderId(providerId);
    if (persisted) {
      for (const row of persisted) memory.set(row.id, row);
      return persisted.filter((row) => row.status !== "cancelled" && row.status !== "completed" && row.startsAt);
    }
  } catch {
    // Memory fallback.
  }
  return sortBookings(
    [...memory.values()].filter(
      (row) => row.providerId === providerId && row.status !== "cancelled" && row.status !== "completed" && row.startsAt,
    ),
  );
}

export async function listProviderBookings(providerName: string): Promise<Booking[]> {  try {
    const db = await import("../db/bookings");
    await db.ensureBookingsSchema();
    const persisted = await db.listBookingsForProvider(providerName);
    if (persisted) {
      for (const row of persisted) memory.set(row.id, row);
      return persisted;
    }
  } catch {
    // Memory fallback.
  }
  return sortBookings([...memory.values()].filter((row) => row.provider === providerName));
}

export async function listMemberBookings(memberId: string): Promise<Booking[]> {
  try {
    const db = await import("../db/bookings");
    await db.ensureBookingsSchema();
    const persisted = await db.listBookingsForMember(memberId);
    if (persisted) {
      for (const row of persisted) memory.set(row.id, row);
      return attachRequests(persisted);
    }
  } catch {
    // Memory fallback.
  }
  return attachRequests(sortBookings([...memory.values()].filter((row) => row.memberId === memberId)));
}

/** Bookings charged to an organization's wallet (no assignment requests attached). */
export async function listOrgBookings(orgId: string): Promise<Booking[]> {
  try {
    const db = await import("../db/bookings");
    await db.ensureBookingsSchema();
    const orgsDb = await import("../db/orgs");
    await orgsDb.ensureOrgsSchema();
    const persisted = await orgsDb.listBookingsForOrg(orgId);
    if (persisted) {
      for (const row of persisted) memory.set(row.id, row);
      return sortBookings(persisted);
    }
  } catch {
    // Memory fallback.
  }
  return sortBookings([...memory.values()].filter((row) => row.orgId === orgId));
}

export async function createMemberBooking(input: {
  member: Member;
  serviceId: string;
  date: string;
  mode: string;
  packageName?: string;
  packageItem?: string;
  availabilityId?: string;
  providerId?: string;
  startsAt?: string;
  slotEnd?: string;
  enforceCredits: boolean;
  orgId?: string;
  recipientName?: string;
  recipientRoom?: string;
  /** Where the booking was made: "web" (default) or "mcp" (member's AI assistant). */
  source?: string;
}): Promise<{booking: Booking; creditsApplied: boolean; availableCredits: number}> {
  const service = findCatalogService(input.serviceId)
    ?? await import("../providers/service").then((mod) => mod.findApprovedCatalogService(input.serviceId));
  if (!service) throw new BookingError("That service is not on the Salu menu.");
  const date = input.date.trim();
  const mode = input.mode.trim();
  if (!date || !mode) throw new BookingError("Choose a time and setting for this reservation.");
  if (input.orgId && input.packageName) {
    throw new BookingError("Packages are for personal memberships — business orders use the org wallet.");
  }

  let creditsCharged = creditsForService(service.id, input.member.planId) ?? service.standardPrice;
  let packageName: string | undefined;
  let packageItem: string | undefined;
  if (input.packageName) {
    const pack = findCatalogPackage(input.packageName);
    if (!pack) throw new BookingError("That package is not on the Salu menu.");
    const item = pack.items.find((entry) => entry.label === service.name);
    if (!item) throw new BookingError(`${service.name} is not part of ${pack.name}.`);
    if (input.packageItem && input.packageItem !== item.label) {
      throw new BookingError("That package session does not match this service.");
    }
    creditsCharged = 0;
    packageName = pack.name;
    packageItem = item.label;
  }

  const now = new Date().toISOString();
  const booking: Booking = {
    id: `b_${crypto.randomUUID()}`,
    memberId: input.member.id,
    serviceId: service.id,
    serviceName: service.name,
    provider: service.provider,
    providerId: input.providerId,
    availabilityId: input.availabilityId,
    date,
    startsAt: input.startsAt,
    slotEnd: input.slotEnd,
    mode,
    status: "confirmed",
    creditsCharged,
    packageName,
    packageItem,
    orgId: input.orgId,
    recipientName: input.recipientName?.trim() || undefined,
    recipientRoom: input.recipientRoom?.trim() || undefined,
    source: input.source ?? "web",
    createdAt: now,
    updatedAt: now,
  };

  let creditsApplied = false;
  let availableCredits = 0;
  try {
    if (input.orgId) {
      const spent = await spendOrgBookingCredits({
        orgId: input.orgId,
        credits: creditsCharged,
        bookingId: booking.id,
        label: service.name,
        enforce: input.enforceCredits,
      });
      creditsApplied = spent.applied;
      availableCredits = spent.availableCredits;
    } else {
      const spent = await spendBookingCredits({
        member: input.member,
        credits: creditsCharged,
        bookingId: booking.id,
        label: service.name,
        enforce: input.enforceCredits && !packageName,
      });
      creditsApplied = spent.applied;
      availableCredits = spent.availableCredits;
    }
  } catch (error) {
    if (error instanceof InsufficientCreditsError) throw error;
    if (input.enforceCredits && !packageName) throw error;
  }

  await persistBooking(booking);
  if (input.orgId) {
    const label = booking.recipientName ? `${service.name} · ${booking.recipientName}` : service.name;
    const lineItem: BookingLineItem = {
      id: `bli_${crypto.randomUUID()}`,
      bookingId: booking.id,
      label,
      quantity: 1,
      unitCredits: creditsCharged,
      totalCredits: creditsCharged,
      createdAt: now,
    };
    const items = lineItemsMemory.get(booking.id) ?? [];
    lineItemsMemory.set(booking.id, [...items, lineItem]);
    try {
      const db = await import("../db/orgs");
      await db.ensureOrgsSchema();
      await db.insertLineItem(lineItem);
    } catch {
      // Line items persist when D1 is available; the booking itself is already stored.
    }
  }
  const withRequest = await attachRequest(booking);
  return {booking: withRequest, creditsApplied, availableCredits};
}

/** Invoice-ready line items for a booking: D1 first, memory fallback. */
export async function listBookingLineItems(bookingId: string): Promise<BookingLineItem[]> {
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    const persisted = await db.listLineItemsForBooking(bookingId);
    if (persisted && persisted.length) {
      lineItemsMemory.set(bookingId, persisted);
      return persisted;
    }
  } catch {
    // Memory fallback.
  }
  return lineItemsMemory.get(bookingId) ?? [];
}

export async function acceptProposedBookingTime(input: {
  member: Member;
  bookingId: string;
}): Promise<{booking: Booking; creditsApplied: false; availableCredits: number}> {
  const booking = await storedBooking(input.bookingId);
  if (!booking || booking.memberId !== input.member.id) {
    throw new BookingError("That reservation is not on your calendar.", 404);
  }
  if (booking.status !== "confirmed" && booking.status !== "held") {
    throw new BookingError("Only upcoming reservations can accept a proposed time.");
  }

  const provider = await import("../provider/service");
  const request = await provider.requestForBooking(booking.id);
  if (!request || request.status !== "proposed" || !request.proposedDate) {
    throw new BookingError("There is no proposed time waiting on this reservation.");
  }

  try {
    await provider.acceptProposedTimeForMember({memberId: input.member.id, bookingId: booking.id});
  } catch (error) {
    wrapProviderError(error, "That proposed time could not be accepted.");
  }

  const next: Booking = {
    ...booking,
    date: request.proposedDate,
    updatedAt: new Date().toISOString(),
  };
  await persistBooking(next);
  const billing = await import("../payments/ledger").then((mod) => mod.getMemberBilling(input.member));
  return {
    booking: await attachRequest(next),
    creditsApplied: false,
    availableCredits: billing.wallet.availableCredits,
  };
}

export async function declineProposedBookingTime(input: {
  member: Member;
  bookingId: string;
}): Promise<{booking: Booking; creditsApplied: false; availableCredits: number}> {
  const booking = await storedBooking(input.bookingId);
  if (!booking || booking.memberId !== input.member.id) {
    throw new BookingError("That reservation is not on your calendar.", 404);
  }
  if (booking.status !== "confirmed" && booking.status !== "held") {
    throw new BookingError("Only upcoming reservations can decline a proposed time.");
  }

  const provider = await import("../provider/service");
  const request = await provider.requestForBooking(booking.id);
  if (!request || request.status !== "proposed") {
    throw new BookingError("There is no proposed time waiting on this reservation.");
  }

  try {
    await provider.declineProposedTimeForMember({memberId: input.member.id, bookingId: booking.id});
  } catch (error) {
    wrapProviderError(error, "That proposed time could not be declined.");
  }

  const billing = await import("../payments/ledger").then((mod) => mod.getMemberBilling(input.member));
  return {
    booking: await attachRequest(booking),
    creditsApplied: false,
    availableCredits: billing.wallet.availableCredits,
  };
}

export async function rescheduleMemberBooking(input: {
  member: Member;
  bookingId: string;
  date: string;
}): Promise<Booking> {
  const booking = await storedBooking(input.bookingId);
  if (!booking || booking.memberId !== input.member.id) {
    throw new BookingError("That reservation is not on your calendar.", 404);
  }
  if (booking.status !== "confirmed" && booking.status !== "held") {
    throw new BookingError("Only upcoming reservations can be moved.");
  }
  const date = input.date.trim();
  if (!date) throw new BookingError("Choose a new time for this reservation.");
  const next: Booking = {...booking, date, updatedAt: new Date().toISOString()};
  await persistBooking(next);
  return attachRequest(next);
}

export async function completeMemberBooking(input: {
  member: Member;
  bookingId: string;
}): Promise<{booking: Booking; payout: import("../domain/types").ProviderPayout | null}> {
  const booking = await storedBooking(input.bookingId);
  if (!booking) {
    throw new BookingError("That reservation is not on the calendar.", 404);
  }
  const ownsBooking = booking.memberId === input.member.id;
  let providerOwns = false;
  if (!ownsBooking) {
    try {
      const connect = await import("../connect/service");
      let provider = await connect.findProvider({memberId: input.member.id});
      if (!provider) {
        const {resolveProviderAccount} = await import("../provider/service");
        const account = await resolveProviderAccount({
          id: input.member.id,
          email: input.member.email,
          displayName: input.member.displayName,
          memberId: input.member.id,
        });
        if (account && (account.practiceName === booking.provider || account.practiceId === booking.serviceId)) {
          provider = await connect.claimProvider({
            member: input.member,
            providerId: account.practiceId,
            practiceName: account.practiceName,
          });
        }
      }
      providerOwns = Boolean(provider && provider.name === booking.provider);
    } catch {
      providerOwns = false;
    }
  }
  if (!ownsBooking && !providerOwns) {
    throw new BookingError("That reservation is not on your calendar.", 404);
  }
  if (booking.status === "cancelled") {
    throw new BookingError("A cancelled reservation cannot be completed.");
  }

  const next: Booking = booking.status === "completed"
    ? booking
    : {
      ...booking,
      status: "completed",
      updatedAt: new Date().toISOString(),
    };
  if (next !== booking) await persistBooking(next);

  let payout = null;
  try {
    const connect = await import("../connect/service");
    const {readStripeEnv} = await import("../payments/env");
    payout = await connect.settleBookingPayout({booking: next, env: readStripeEnv()});
  } catch {
    payout = null;
  }
  return {booking: next, payout};
}

export async function cancelMemberBooking(input: {
  member: Member;
  bookingId: string;
}): Promise<{booking: Booking; creditsApplied: boolean; availableCredits: number}> {
  const booking = await storedBooking(input.bookingId);
  if (!booking || booking.memberId !== input.member.id) {
    throw new BookingError("That reservation is not on your calendar.", 404);
  }
  if (booking.status === "cancelled") {
    const billing = await import("../payments/ledger").then((mod) => mod.getMemberBilling(input.member));
    return {booking, creditsApplied: false, availableCredits: billing.wallet.availableCredits};
  }
  if (booking.status !== "confirmed" && booking.status !== "held") {
    throw new BookingError("Only upcoming reservations can be cancelled.");
  }

  const next: Booking = {
    ...booking,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  };
  await persistBooking(next);

  const restored = await restoreBookingCredits({
    member: input.member,
    credits: booking.creditsCharged,
    bookingId: booking.id,
    label: `Refund · ${booking.serviceName}`,
  });
  return {booking: await attachRequest(next), creditsApplied: restored.applied, availableCredits: restored.availableCredits};
}

export {InsufficientCreditsError};

/**
 * Book a concrete free slot with a specific provider. Re-verifies the slot
 * against the scheduling engine right before writing so two members cannot
 * take the same time (409 on conflict).
 */
export async function createScheduledMemberBooking(input: {
  member: Member;
  serviceId: string;
  mode?: string;
  providerId: string;
  slotStart: string;
  packageName?: string;
  packageItem?: string;
  enforceCredits: boolean;
  orgId?: string;
  recipientName?: string;
  recipientRoom?: string;
  /** Where the booking was made: "web" (default) or "mcp" (member's AI assistant). */
  source?: string;
}): Promise<{booking: Booking; provider: {id: string; name: string}; creditsApplied: boolean; availableCredits: number}> {
  const {schedulingProviderId, getFreeSlots} = await import("../scheduling/slots");
  const {durationMinutesForService, findCatalogService} = await import("./catalog");
  const service = findCatalogService(input.serviceId);
  if (!service) throw new BookingError("That service is not on the Salu menu.", 404);

  const durationMinutes = durationMinutesForService(input.serviceId);
  const startMs = Date.parse(input.slotStart);
  if (!Number.isFinite(startMs)) throw new BookingError("Choose a time for this reservation.");

  const accountId = schedulingProviderId(input.providerId);
  const slots = await getFreeSlots({
    providerId: accountId,
    serviceId: input.serviceId,
    fromISO: new Date(startMs).toISOString(),
    toISO: new Date(startMs + durationMinutes * 60000).toISOString(),
    durationMinutes,
  });
  const slot = slots.find((candidate) => Date.parse(candidate.startISO) === startMs);
  if (!slot) {
    throw new BookingError("That time was just taken. Pick another slot.", 409);
  }

  const result = await createMemberBooking({
    member: input.member,
    serviceId: input.serviceId,
    date: slot.label,
    mode: input.mode?.trim() || slot.mode,
    packageName: input.packageName,
    packageItem: input.packageItem,
    providerId: accountId,
    startsAt: slot.startISO,
    slotEnd: slot.endISO,
    enforceCredits: input.enforceCredits,
    orgId: input.orgId,
    recipientName: input.recipientName,
    recipientRoom: input.recipientRoom,
    source: input.source ?? "web",
  });

  const provider = await import("../provider/service");
  await provider.createAssignedRequestFromBooking({
    booking: result.booking,
    member: input.member,
    providerId: accountId,
  });

  return {
    booking: {...result.booking, assignment: "assigned" as const},
    provider: {id: accountId, name: slot.providerName},
    creditsApplied: result.creditsApplied,
    availableCredits: result.availableCredits,
  };
}

/**
 * Assignment engine: given a service and an exact start time, find every
 * approved provider offering that service with the slot free, then pick the
 * one with the fewest bookings that day (tie-break: earliest created).
 */
export async function assignMemberBooking(input: {
  member: Member;
  serviceId: string;
  startISO: string;
  mode?: string;
  enforceCredits: boolean;
  orgId?: string;
  recipientName?: string;
  recipientRoom?: string;
}): Promise<{booking: Booking; provider: {id: string; name: string}}> {
  const {getFreeSlots, nyDayOf} = await import("../scheduling/slots");
  const {durationMinutesForService, findCatalogService} = await import("./catalog");
  const {listApplications} = await import("../providers/service");
  const service = findCatalogService(input.serviceId);
  if (!service) throw new BookingError("That service is not on the Salu menu.", 404);

  const durationMinutes = durationMinutesForService(input.serviceId);
  const startMs = Date.parse(input.startISO);
  if (!Number.isFinite(startMs)) throw new BookingError("Choose a time for this reservation.");

  // Live service ids are per application (live~<appId>~<key>), so expand the
  // request to every approved provider offering the same service key.
  const {parseLiveServiceId} = await import("../providers/catalog");
  const {schedulingProviderId} = await import("../scheduling/slots");
  const {listApprovedCatalog} = await import("../providers/service");
  const catalog = await listApprovedCatalog();
  const live = parseLiveServiceId(input.serviceId);
  const targets: Array<{providerId: string; serviceId: string}> = [];
  if (live) {
    for (const provider of catalog.providers) {
      const match = catalog.services.find(
        (service) => service.providerId === provider.id && parseLiveServiceId(service.id)?.serviceKey === live.serviceKey,
      );
      if (match) targets.push({providerId: schedulingProviderId(provider.id), serviceId: match.id});
    }
  } else {
    targets.push({providerId: "", serviceId: input.serviceId});
  }

  const slots: Array<import("../scheduling/slots").FreeSlot> = [];
  for (const target of targets) {
    const found = await getFreeSlots({
      providerId: target.providerId || undefined,
      serviceId: target.serviceId,
      fromISO: new Date(startMs).toISOString(),
      toISO: new Date(startMs + durationMinutes * 60000).toISOString(),
      durationMinutes,
    });
    slots.push(...found);
  }
  const candidates = slots.filter((slot) => Date.parse(slot.startISO) === startMs);
  if (!candidates.length) {
    throw new BookingError("No provider is free at that time. Pick another slot.", 409);
  }

  const day = nyDayOf(startMs);
  const applications = await listApplications({status: "approved"}).catch(() => []);
  const createdAtByAccount = new Map(
    applications.map((application) => [`prov_app_${application.id}`, application.createdAt ?? ""]),
  );
  const ranked = await Promise.all(
    candidates.map(async (slot) => {
      const dayBookings = (await listScheduledBookingsForProvider(slot.providerId)).filter(
        (booking) => booking.startsAt && nyDayOf(Date.parse(booking.startsAt)) === day,
      );
      return {
        slot,
        dayCount: dayBookings.length,
        createdAt: createdAtByAccount.get(slot.providerId) ?? "",
      };
    }),
  );
  ranked.sort(
    (a, b) => a.dayCount - b.dayCount || a.createdAt.localeCompare(b.createdAt) || a.slot.providerId.localeCompare(b.slot.providerId),
  );
  const winner = ranked[0]!.slot;

  const result = await createScheduledMemberBooking({
    member: input.member,
    serviceId: winner.serviceId,
    mode: input.mode,
    providerId: winner.providerId,
    slotStart: winner.startISO,
    enforceCredits: input.enforceCredits,
    orgId: input.orgId,
    recipientName: input.recipientName,
    recipientRoom: input.recipientRoom,
  });
  return {booking: result.booking, provider: result.provider};
}
