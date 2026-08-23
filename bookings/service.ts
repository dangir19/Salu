import type {Booking, Member} from "../domain/types";
import {
  InsufficientCreditsError,
  restoreBookingCredits,
  spendBookingCredits,
} from "../payments/ledger";
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
  assignment?: "unassigned" | "accepted" | "proposed" | "declined";
  proposedDate?: string;
};

const memory = new Map<string, Booking>();

export function resetBookingMemory(): void {
  memory.clear();
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
  };
}

function sortBookings(rows: Booking[]): Booking[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
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
        : request.status === "accepted" || request.status === "proposed" || request.status === "declined"
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

export async function listProviderBookings(providerName: string): Promise<Booking[]> {
  try {
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

export async function createMemberBooking(input: {
  member: Member;
  serviceId: string;
  date: string;
  mode: string;
  packageName?: string;
  packageItem?: string;
  availabilityId?: string;
  enforceCredits: boolean;
}): Promise<{booking: Booking; creditsApplied: boolean; availableCredits: number}> {
  const service = findCatalogService(input.serviceId)
    ?? await import("../providers/service").then((mod) => mod.findApprovedCatalogService(input.serviceId));
  if (!service) throw new BookingError("That service is not on the Salu menu.");
  const date = input.date.trim();
  const mode = input.mode.trim();
  if (!date || !mode) throw new BookingError("Choose a time and setting for this reservation.");

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
    availabilityId: input.availabilityId,
    date,
    mode,
    status: "confirmed",
    creditsCharged,
    packageName,
    packageItem,
    createdAt: now,
    updatedAt: now,
  };

  let creditsApplied = false;
  let availableCredits = 0;
  try {
    const spent = await spendBookingCredits({
      member: input.member,
      credits: creditsCharged,
      bookingId: booking.id,
      label: service.name,
      enforce: input.enforceCredits && !packageName,
    });
    creditsApplied = spent.applied;
    availableCredits = spent.availableCredits;
  } catch (error) {
    if (error instanceof InsufficientCreditsError) throw error;
    if (input.enforceCredits && !packageName) throw error;
  }

  await persistBooking(booking);
  const withRequest = await attachRequest(booking);
  return {booking: withRequest, creditsApplied, availableCredits};
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
      const provider = await connect.findProvider({memberId: input.member.id});
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
