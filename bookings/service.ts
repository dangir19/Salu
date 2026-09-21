import type {Booking, Member} from "../domain/types";
import {
  InsufficientCreditsError,
  restoreBookingCredits,
  spendBookingCredits,
} from "../payments/ledger";
import {
  getOrgBilling,
  restoreOrgBookingCredits,
  spendOrgBookingCredits,
} from "../payments/org-ledger";
import {
  creditsForService,
  durationMinutesForService,
  findCatalogPackage,
  findCatalogService,
} from "./catalog";

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

/** Single-flight slot reservations while a booking is being written (D1-less fallback). */
type MemorySlotClaim = {
  providerId: string;
  startsAt: string;
  slotEnd: string;
  bookingId: string;
  createdAt: number;
};

const slotClaimsMemory = new Map<string, MemorySlotClaim>();
/** Client retry keys: `${memberId}\n${idempotencyKey}` -> bookingId. */
const idempotencyMemory = new Map<string, string>();
/** Per-key FIFO so concurrent retries/racers serialize instead of interleaving. */
const keyLocks = new Map<string, Promise<void>>();

const SLOT_CLAIM_TTL_MS = 10 * 60 * 1000;

export function resetBookingMemory(): void {
  memory.clear();
  lineItemsMemory.clear();
  slotClaimsMemory.clear();
  idempotencyMemory.clear();
  keyLocks.clear();
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

function claimKeyFor(providerId: string, startsAt: string): string {
  return `${providerId}\n${startsAt}`;
}

function idempotencyMapKey(memberId: string, key: string): string {
  return `${memberId}\n${key}`;
}

/** Serialize async work per key so concurrent retries and racers line up. */
async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prior.then(() => gate);
  keyLocks.set(key, chained);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (keyLocks.get(key) === chained) keyLocks.delete(key);
  }
}

function overlapsInterval(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** In-memory overlap check mirroring CLAIM_SLOT_SQL for the D1-less fallback. */
function memorySlotBlocked(input: {
  providerId: string;
  startsAt: string;
  slotEnd: string;
  excludeBookingId?: string;
}): boolean {
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.slotEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true; // fail closed
  for (const booking of memory.values()) {
    if (booking.providerId !== input.providerId) continue;
    if (input.excludeBookingId && booking.id === input.excludeBookingId) continue;
    if (booking.status !== "confirmed" && booking.status !== "held") continue;
    if (!booking.startsAt) continue;
    const bStart = Date.parse(booking.startsAt);
    if (!Number.isFinite(bStart)) continue;
    const bEndRaw = booking.slotEnd ? Date.parse(booking.slotEnd) : NaN;
    const bEnd = Number.isFinite(bEndRaw) ? bEndRaw : bStart;
    if (overlapsInterval(start, end, bStart, bEnd)) return true;
  }
  const now = Date.now();
  for (const claim of slotClaimsMemory.values()) {
    if (claim.providerId !== input.providerId) continue;
    if (now - claim.createdAt > SLOT_CLAIM_TTL_MS) continue;
    const cStart = Date.parse(claim.startsAt);
    const cEnd = Date.parse(claim.slotEnd);
    if (Number.isFinite(cStart) && Number.isFinite(cEnd) && overlapsInterval(start, end, cStart, cEnd)) return true;
  }
  return false;
}

function sweepStaleMemoryClaims(nowMs: number): void {
  for (const [key, claim] of slotClaimsMemory) {
    if (nowMs - claim.createdAt > SLOT_CLAIM_TTL_MS) slotClaimsMemory.delete(key);
  }
}

export type SlotClaimRef = {providerId: string; startsAt: string; bookingId: string};

/**
 * Atomically reserve [startsAt, slotEnd) for a provider while the booking is
 * written. Uses the D1 slot_claims table when available (single-statement
 * check-and-insert, safe across workers) and the in-process store otherwise.
 * Throws a 409 BookingError when another booking or claim already holds an
 * overlapping interval. Bookings without a concrete provider slot skip this.
 */
async function claimSlot(input: {
  providerId?: string;
  startsAt?: string;
  slotEnd?: string;
  excludeBookingId?: string;
}): Promise<SlotClaimRef | null> {
  const providerId = input.providerId?.trim();
  const startsAt = input.startsAt?.trim();
  if (!providerId || !startsAt) return null;
  const startMs = Date.parse(startsAt);
  if (!Number.isFinite(startMs)) throw new BookingError("Choose a time for this reservation.");
  const endRaw = input.slotEnd?.trim() ? Date.parse(input.slotEnd.trim()) : NaN;
  const slotEnd = new Date(Number.isFinite(endRaw) ? endRaw : startMs).toISOString();
  const bookingId = `claim_${crypto.randomUUID()}`;
  const key = claimKeyFor(providerId, startsAt);

  const claimed = await withKeyLock(key, async () => {
    const db = await import("../db/bookings").catch(() => null);
    if (db) {
      await db.ensureBookingsSchema().catch(() => false);
      const d1 = await db
        .claimSlot({
          providerId,
          startsAt,
          slotEnd,
          bookingId,
          excludeBookingId: input.excludeBookingId,
          nowMs: Date.now(),
        })
        .catch(() => null);
      // null = D1 unavailable: fall through to the in-process store.
      if (d1 !== null) return d1;
    }
    sweepStaleMemoryClaims(Date.now());
    if (memorySlotBlocked({providerId, startsAt, slotEnd, excludeBookingId: input.excludeBookingId})) return false;
    slotClaimsMemory.set(key, {providerId, startsAt, slotEnd, bookingId, createdAt: Date.now()});
    return true;
  });

  if (!claimed) {
    throw new BookingError("That time was just taken. Pick another slot.", 409);
  }
  return {providerId, startsAt, bookingId};
}

async function releaseSlotClaim(ref: SlotClaimRef): Promise<void> {
  const key = claimKeyFor(ref.providerId, ref.startsAt);
  await withKeyLock(key, async () => {
    const current = slotClaimsMemory.get(key);
    if (current && current.bookingId === ref.bookingId) slotClaimsMemory.delete(key);
    try {
      const db = await import("../db/bookings");
      await db.releaseSlotClaim(ref);
    } catch {
      // Memory already released; D1 cleanup is best-effort.
    }
  });
}

/** Run fn while holding the slot claim; the claim is always released after. */
async function withSlotClaim<T>(
  input: {providerId?: string; startsAt?: string; slotEnd?: string; excludeBookingId?: string},
  fn: () => Promise<T>,
): Promise<T> {
  const claim = await claimSlot(input);
  if (!claim) return fn();
  try {
    return await fn();
  } finally {
    await releaseSlotClaim(claim).catch(() => {});
  }
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

async function persistBooking(booking: Booking, opts?: {idempotencyKey?: string}): Promise<void> {
  memory.set(booking.id, booking);
  const db = await import("../db/bookings").catch(() => null);
  if (!db) return; // D1 unavailable: memory only.
  try {
    await db.ensureBookingsSchema();
    const existing = await db.getBookingById(booking.id);
    if (existing) {
      await db.updateBooking(booking.id, booking);
    } else {
      await db.insertBooking(booking, opts?.idempotencyKey ? {idempotencyKey: opts.idempotencyKey} : undefined);
    }
  } catch (error) {
    // Cross-worker idempotency race: the winning request already stored this
    // key. Rethrown so the caller can replay the winner instead of
    // fabricating a second booking.
    if (error instanceof db.DuplicateIdempotencyKeyError) throw error;
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

async function findIdempotentBooking(memberId: string, key: string): Promise<Booking | null> {
  const mapKey = idempotencyMapKey(memberId, key);
  const id = idempotencyMemory.get(mapKey);
  if (id) {
    const booking = await storedBooking(id);
    if (booking) return booking;
    idempotencyMemory.delete(mapKey);
  }
  try {
    const db = await import("../db/bookings");
    await db.ensureBookingsSchema();
    const row = await db.getBookingByIdempotencyKey(memberId, key);
    if (row) {
      memory.set(row.id, row);
      idempotencyMemory.set(mapKey, row.id);
      return row;
    }
  } catch {
    // Memory only.
  }
  return null;
}

/** Replay an idempotent scheduled retry: the original booking, never a second charge. */
async function replayScheduledIdempotentBooking(
  member: Member,
  idempotencyKey: string,
): Promise<{
  booking: Booking;
  provider: {id: string; name: string};
  creditsApplied: boolean;
  availableCredits: number;
} | null> {
  const existing = await findIdempotentBooking(member.id, idempotencyKey);
  if (!existing) return null;
  const replayed = await replayIdempotentBooking(member, existing);
  let name = existing.provider;
  try {
    const {listApplications} = await import("../providers/service");
    const applications = await listApplications({status: "approved"});
    const match = applications.find((application) => `prov_app_${application.id}` === existing.providerId);
    if (match) name = match.fullName;
  } catch {
    // Fall back to the stored provider name.
  }
  return {
    booking: {...replayed.booking, assignment: "assigned" as const},
    provider: {id: existing.providerId ?? "", name},
    creditsApplied: replayed.creditsApplied,
    availableCredits: replayed.availableCredits,
  };
}
/** Replay an idempotent retry: the original booking, never a second charge. */
async function replayIdempotentBooking(member: Member, booking: Booking) {
  const availableCredits = booking.orgId
    ? (await getOrgBilling(booking.orgId)).wallet.availableCredits
    : (await import("../payments/ledger").then((mod) => mod.getMemberBilling(member))).wallet.availableCredits;
  return {
    booking: await attachRequest(booking),
    creditsApplied: false as const,
    availableCredits,
  };
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

export type CreateMemberBookingInput = {
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
  /**
   * Client retry key. Repeat requests with the same key return the original
   * booking instead of double-booking / double-charging. One key per member;
   * reuse a key only for retries of the same request.
   */
  idempotencyKey?: string;
};

export async function createMemberBooking(input: CreateMemberBookingInput): Promise<{
  booking: Booking;
  creditsApplied: boolean;
  availableCredits: number;
}> {
  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey) {
    // One key lock per (member, key): identical retries serialize and the
    // second caller replays the first caller's booking instead of charging
    // again.
    return withKeyLock(idempotencyMapKey(input.member.id, idempotencyKey), () =>
      createIdempotentMemberBooking(input, idempotencyKey),
    );
  }
  const booking = await buildBooking(input);
  return finalizeBooking(input, booking);
}

async function createIdempotentMemberBooking(input: CreateMemberBookingInput, idempotencyKey: string) {
  const existing = await findIdempotentBooking(input.member.id, idempotencyKey);
  if (existing) return replayIdempotentBooking(input.member, existing);
  const booking = await buildBooking(input);
  return finalizeBooking(input, booking, idempotencyKey);
}

/** Validate + price + assemble the booking record (no side effects). */
async function buildBooking(input: CreateMemberBookingInput): Promise<Booking> {
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
  return {
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
}

/**
 * Charge the wallet/org and persist the booking under an atomic slot claim.
 * The claim is released once the booking row is written, so the D1 overlap
 * check (claim vs. bookings table) covers the window in between.
 */
async function finalizeBooking(
  input: CreateMemberBookingInput,
  booking: Booking,
  idempotencyKey?: string,
): Promise<{booking: Booking; creditsApplied: boolean; availableCredits: number}> {
  const db = await import("../db/bookings").catch(() => null);
  return withSlotClaim(
    {providerId: input.providerId, startsAt: input.startsAt, slotEnd: input.slotEnd},
    async () => {
      let creditsApplied = false;
      let availableCredits = 0;
      try {
        if (input.orgId) {
          const spent = await spendOrgBookingCredits({
            orgId: input.orgId,
            credits: booking.creditsCharged,
            bookingId: booking.id,
            label: booking.serviceName,
            enforce: input.enforceCredits,
          });
          creditsApplied = spent.applied;
          availableCredits = spent.availableCredits;
        } else {
          const spent = await spendBookingCredits({
            member: input.member,
            credits: booking.creditsCharged,
            bookingId: booking.id,
            label: booking.serviceName,
            enforce: input.enforceCredits && !booking.packageName,
          });
          creditsApplied = spent.applied;
          availableCredits = spent.availableCredits;
        }
        await persistBooking(booking, idempotencyKey ? {idempotencyKey} : undefined);
      } catch (error) {
        // Lost a cross-worker idempotency race after charging: void our own
        // charge so the member is not billed for a booking that was never
        // created, then replay the winning request.
        if (
          idempotencyKey && db && error instanceof db.DuplicateIdempotencyKeyError
          && creditsApplied && booking.creditsCharged > 0
        ) {
          try {
            if (input.orgId) {
              await restoreOrgBookingCredits({
                orgId: input.orgId,
                credits: booking.creditsCharged,
                bookingId: booking.id,
                label: "Duplicate booking request voided",
              });
            } else {
              await restoreBookingCredits({
                member: input.member,
                credits: booking.creditsCharged,
                bookingId: booking.id,
                label: "Duplicate booking request voided",
              });
            }
          } catch {
            // Best effort; the duplicate-key error proves the original
            // charge exists and a refund can be issued manually.
          }
          const winner = await findIdempotentBooking(input.member.id, idempotencyKey);
          if (winner) return replayIdempotentBooking(input.member, winner);
        }
        throw error;
      }

      if (idempotencyKey) idempotencyMemory.set(idempotencyMapKey(input.member.id, idempotencyKey), booking.id);

      if (input.orgId) {
        const label = booking.recipientName ? `${booking.serviceName} · ${booking.recipientName}` : booking.serviceName;
        const lineItem: BookingLineItem = {
          id: `bli_${crypto.randomUUID()}`,
          bookingId: booking.id,
          label,
          quantity: 1,
          unitCredits: booking.creditsCharged,
          totalCredits: booking.creditsCharged,
          createdAt: booking.createdAt,
        };
        const items = lineItemsMemory.get(booking.id) ?? [];
        lineItemsMemory.set(booking.id, [...items, lineItem]);
        try {
          const orgsDb = await import("../db/orgs");
          await orgsDb.ensureOrgsSchema();
          await orgsDb.insertLineItem(lineItem);
        } catch {
          // Line items persist when D1 is available; the booking itself is already stored.
        }
      }
      const withRequest = await attachRequest(booking);
      return {booking: withRequest, creditsApplied, availableCredits};
    },
  );
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
  /**
   * New concrete slot for bookings that hold a provider time. Required when
   * the booking has a startsAt; the slot is re-verified free and claimed, and
   * the old slot is released.
   */
  startsAt?: string;
  slotEnd?: string;
}): Promise<Booking> {
  const booking = await storedBooking(input.bookingId);
  if (!booking || booking.memberId !== input.member.id) {
    throw new BookingError("That reservation is not on your calendar.", 404);
  }
  if (booking.status !== "confirmed" && booking.status !== "held") {
    throw new BookingError("Only upcoming reservations can be moved.");
  }

  // Bookings holding a real provider slot cannot be moved by relabelling the
  // display date: the new slot must be verified free and claimed atomically.
  if (booking.startsAt) {
    if (!booking.providerId) {
      throw new BookingError("That reservation cannot be moved to a new slot.", 400);
    }
    const newStart = input.startsAt?.trim();
    if (!newStart) {
      throw new BookingError("That reservation holds a real time slot. Pick a new open slot to move it.", 400);
    }
    const startMs = Date.parse(newStart);
    if (!Number.isFinite(startMs)) throw new BookingError("Choose a new time for this reservation.");
    if (startMs < Date.now()) throw new BookingError("That time has already passed. Pick a future slot.", 400);
    if (booking.startsAt && Date.parse(booking.startsAt) === startMs) {
      return attachRequest(booking); // no-op
    }
    const {getFreeSlots} = await import("../scheduling/slots");
    const durationMinutes = durationMinutesForService(booking.serviceId);
    const slots = await getFreeSlots({
      providerId: booking.providerId,
      serviceId: booking.serviceId,
      fromISO: new Date(startMs).toISOString(),
      toISO: new Date(startMs + durationMinutes * 60000).toISOString(),
      durationMinutes,
    });
    const slot = slots.find((candidate) => Date.parse(candidate.startISO) === startMs);
    if (!slot) throw new BookingError("That time was just taken. Pick another slot.", 409);

    return withSlotClaim(
      {providerId: booking.providerId, startsAt: slot.startISO, slotEnd: slot.endISO, excludeBookingId: booking.id},
      async () => {
        const next: Booking = {
          ...booking,
          date: slot.label,
          startsAt: slot.startISO,
          slotEnd: slot.endISO,
          updatedAt: new Date().toISOString(),
        };
        await persistBooking(next);
        return attachRequest(next);
      },
    );
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

  // Refunds restore what was actually charged. A booking that never debited
  // the wallet (free item, waived charge, failed spend) must not mint
  // credits: only refund when a matching negative "booking" entry exists.
  // Org bookings refund to the org wallet, never to the member.
  if (booking.orgId) {
    const orgBilling = await getOrgBilling(booking.orgId);
    const orgWasCharged = orgBilling.transactions.some(
      (row) => row.bookingId === booking.id && row.kind === "booking" && row.credits < 0,
    );
    const orgRestored = orgWasCharged
      ? await restoreOrgBookingCredits({
        orgId: booking.orgId,
        credits: booking.creditsCharged,
        bookingId: booking.id,
        label: `Refund · ${booking.serviceName}`,
      })
      : {transaction: null, applied: false, availableCredits: orgBilling.wallet.availableCredits};
    return {
      booking: await attachRequest(next),
      creditsApplied: orgRestored.applied,
      availableCredits: orgRestored.availableCredits,
    };
  }
  const billing = await import("../payments/ledger").then((mod) => mod.getMemberBilling(input.member));
  const wasCharged = billing.transactions.some(
    (row) => row.bookingId === booking.id && row.kind === "booking" && row.credits < 0,
  );
  const restored = wasCharged
    ? await restoreBookingCredits({
      member: input.member,
      credits: booking.creditsCharged,
      bookingId: booking.id,
      label: `Refund · ${booking.serviceName}`,
    })
    : {transaction: null, applied: false, availableCredits: billing.wallet.availableCredits};
  return {booking: await attachRequest(next), creditsApplied: restored.applied, availableCredits: restored.availableCredits};
}

export {InsufficientCreditsError};

/**
 * Book a concrete free slot with a specific provider. The slot is verified
 * free, then claimed atomically while the booking is written; two members
 * racing for the same time resolve to exactly one booking (409 for the
 * loser). Past times are rejected outright.
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
  /** Client retry key: retries with the same key replay the original booking. */
  idempotencyKey?: string;
}): Promise<{booking: Booking; provider: {id: string; name: string}; creditsApplied: boolean; availableCredits: number}> {
  const {schedulingProviderId, getFreeSlots} = await import("../scheduling/slots");
  const service = findCatalogService(input.serviceId);
  if (!service) throw new BookingError("That service is not on the Salu menu.", 404);

  const durationMinutes = durationMinutesForService(input.serviceId);
  const startMs = Date.parse(input.slotStart);
  if (!Number.isFinite(startMs)) throw new BookingError("Choose a time for this reservation.");
  if (startMs < Date.now()) throw new BookingError("That time has already passed. Pick a future slot.", 400);

  const accountId = schedulingProviderId(input.providerId);

  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey) {
    // Idempotent retries must replay the original booking even though the
    // slot is now (correctly) taken by it — check before the free-slot lookup.
    const replayed = await replayScheduledIdempotentBooking(input.member, idempotencyKey);
    if (replayed) return replayed;
  }

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
    idempotencyKey: input.idempotencyKey,
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
  const {listApplications} = await import("../providers/service");
  const service = findCatalogService(input.serviceId);
  if (!service) throw new BookingError("That service is not on the Salu menu.", 404);

  const durationMinutes = durationMinutesForService(input.serviceId);
  const startMs = Date.parse(input.startISO);
  if (!Number.isFinite(startMs)) throw new BookingError("Choose a time for this reservation.");
  if (startMs < Date.now()) throw new BookingError("That time has already passed. Pick a future slot.", 400);

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
