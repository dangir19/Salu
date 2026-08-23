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
  };
}

function sortBookings(rows: Booking[]): Booking[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
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

export async function listMemberBookings(memberId: string): Promise<Booking[]> {
  try {
    const db = await import("../db/bookings");
    await db.ensureBookingsSchema();
    const persisted = await db.listBookingsForMember(memberId);
    if (persisted) {
      for (const row of persisted) memory.set(row.id, row);
      return persisted;
    }
  } catch {
    // Memory fallback.
  }
  return sortBookings([...memory.values()].filter((row) => row.memberId === memberId));
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
  const service = findCatalogService(input.serviceId);
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
  return {booking, creditsApplied, availableCredits};
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
  return next;
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
  return {booking: next, creditsApplied: restored.applied, availableCredits: restored.availableCredits};
}

export {InsufficientCreditsError};
