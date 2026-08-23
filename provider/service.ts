import type {
  AppointmentRequest,
  Booking,
  Member,
  ProviderAccount,
  ProviderAssignment,
  ProviderBlock,
} from "../domain/types";
import {parseLiveServiceId} from "../providers/catalog";
import {
  DEMO_PROVIDER_USER,
  demoAccountFromPractice,
  normalizeEmail,
  parseProviderEmails,
  practiceForEmail,
  practiceForService,
  TIDE_TONE_PRACTICE,
} from "./catalog";

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export type UiAppointmentRequest = {
  id: string;
  bookingId: string;
  memberDisplayName: string;
  serviceName: string;
  practiceName: string;
  date: string;
  mode: string;
  creditsCharged: number;
  status: AppointmentRequest["status"];
  proposedDate?: string;
  note?: string;
  walkthrough?: boolean;
};

export type UiProviderJob = {
  id: string;
  requestId: string;
  bookingId: string;
  serviceName: string;
  memberDisplayName: string;
  date: string;
  mode: string;
  status: "accepted" | "proposed";
  proposedDate?: string;
};

const accountMemory = new Map<string, ProviderAccount>();
const requestMemory = new Map<string, AppointmentRequest>();
const assignmentMemory = new Map<string, ProviderAssignment>();
const blockMemory = new Map<string, ProviderBlock>();

export function resetProviderWorkspaceMemory(): void {
  accountMemory.clear();
  requestMemory.clear();
  assignmentMemory.clear();
  blockMemory.clear();
}

export function toUiRequest(request: AppointmentRequest): UiAppointmentRequest {
  return {
    id: request.id,
    bookingId: request.bookingId,
    memberDisplayName: request.memberDisplayName,
    serviceName: request.serviceName,
    practiceName: request.practiceName,
    date: request.date,
    mode: request.mode,
    creditsCharged: request.creditsCharged,
    status: request.status,
    proposedDate: request.proposedDate,
    note: request.note,
    walkthrough: request.walkthrough,
  };
}

function sortByCreated<T extends {createdAt: string; id: string}>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function rememberAccount(account: ProviderAccount): ProviderAccount {
  accountMemory.set(account.email, account);
  accountMemory.set(account.id, account);
  return account;
}

async function persistAccount(account: ProviderAccount): Promise<ProviderAccount> {
  rememberAccount(account);
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    await db.upsertProviderAccountRow(account);
  } catch {
    // D1 is optional until the provider workspace migration is applied.
  }
  return account;
}

async function storedAccountByEmail(email: string): Promise<ProviderAccount | null> {
  const normalized = normalizeEmail(email);
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    const persisted = await db.getProviderAccountByEmail(normalized);
    if (persisted) return rememberAccount(persisted);
  } catch {
    // Fall through to memory.
  }
  return accountMemory.get(normalized) ?? [...accountMemory.values()].find((row) => row.email === normalized) ?? null;
}

async function persistRequest(request: AppointmentRequest): Promise<void> {
  requestMemory.set(request.id, request);
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    const existing = await db.getAppointmentRequestById(request.id);
    if (existing) {
      await db.updateAppointmentRequest(request.id, request);
    } else {
      await db.insertAppointmentRequest(request);
    }
  } catch {
    // D1 is optional.
  }
}

async function storedRequest(id: string): Promise<AppointmentRequest | null> {
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    const persisted = await db.getAppointmentRequestById(id);
    if (persisted) {
      requestMemory.set(persisted.id, persisted);
      return persisted;
    }
  } catch {
    // Fall through to memory.
  }
  return requestMemory.get(id) ?? null;
}

async function storedRequestByBooking(bookingId: string): Promise<AppointmentRequest | null> {
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    const persisted = await db.getAppointmentRequestByBookingId(bookingId);
    if (persisted) {
      requestMemory.set(persisted.id, persisted);
      return persisted;
    }
  } catch {
    // Fall through to memory.
  }
  return [...requestMemory.values()].find((row) => row.bookingId === bookingId) ?? null;
}

async function allRequests(): Promise<AppointmentRequest[]> {
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    const persisted = await db.listAppointmentRequests();
    if (persisted) {
      for (const row of persisted) requestMemory.set(row.id, row);
      return persisted;
    }
  } catch {
    // Memory fallback.
  }
  return sortByCreated([...requestMemory.values()]);
}

async function persistAssignment(assignment: ProviderAssignment): Promise<void> {
  assignmentMemory.set(assignment.id, assignment);
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    await db.insertProviderAssignment(assignment);
  } catch {
    // D1 is optional.
  }
}

async function persistBlock(block: ProviderBlock): Promise<void> {
  blockMemory.set(block.id, block);
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    await db.insertProviderBlock(block);
  } catch {
    // D1 is optional.
  }
}

async function listStoredBlocks(providerId: string): Promise<ProviderBlock[]> {
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    const persisted = await db.listBlocksForProvider(providerId);
    if (persisted) {
      for (const row of persisted) blockMemory.set(row.id, row);
      return persisted;
    }
  } catch {
    // Memory fallback.
  }
  return sortByCreated([...blockMemory.values()].filter((row) => row.providerId === providerId));
}

export function requestMatchesProvider(request: AppointmentRequest, provider: ProviderAccount): boolean {
  if (request.practiceId === provider.practiceId) return true;
  if (provider.serviceIds.includes(request.serviceId)) return true;
  const live = parseLiveServiceId(request.serviceId);
  return Boolean(live && live.applicationId === provider.practiceId);
}

async function resolveApprovedPractice(email: string): Promise<ProviderAccount | null> {
  try {
    const [{listApplicationsForEmail}, {liveServiceId, serviceKeysForLicense}] = await Promise.all([
      import("../providers/service"),
      import("../providers/catalog"),
    ]);
    const rows = await listApplicationsForEmail(email);
    const approved = rows.find((row) => row.status === "approved");
    if (!approved) return null;
    const keys = serviceKeysForLicense(approved.licenseType);
    const serviceIds = keys.map((key) => liveServiceId(approved.id, key));
    const now = new Date().toISOString();
    return {
      id: `prov_app_${approved.id}`,
      email,
      displayName: approved.fullName,
      practiceId: approved.id,
      practiceName: approved.fullName,
      status: "approved",
      serviceIds,
      createdAt: approved.createdAt ?? now,
      updatedAt: now,
    };
  } catch {
    return null;
  }
}

export async function resolveProviderAccount(input: {
  id?: string | null;
  email?: string | null;
  displayName?: string | null;
  memberId?: string | null;
  allowlistedEmails?: string[];
}): Promise<ProviderAccount | null> {
  const email = normalizeEmail(input.email ?? "");
  if (!email) return null;

  const existing = await storedAccountByEmail(email);
  if (existing) {
    if (input.memberId && existing.memberId !== input.memberId) {
      return persistAccount({...existing, memberId: input.memberId, updatedAt: new Date().toISOString()});
    }
    return existing;
  }

  const demo = practiceForEmail(email);
  if (demo) {
    return persistAccount({
      ...demoAccountFromPractice(demo, email, input.displayName ?? undefined),
      memberId: input.memberId ?? undefined,
      id: email === DEMO_PROVIDER_USER.email ? DEMO_PROVIDER_USER.id : demoAccountFromPractice(demo, email).id,
    });
  }

  const recruited = await resolveApprovedPractice(email);
  if (recruited) {
    return persistAccount({...recruited, memberId: input.memberId ?? undefined});
  }

  if (input.allowlistedEmails?.includes(email)) {
    return persistAccount({
      ...demoAccountFromPractice(TIDE_TONE_PRACTICE, email, input.displayName ?? undefined, "approved"),
      memberId: input.memberId ?? undefined,
    });
  }

  return null;
}

export async function createRequestFromBooking(input: {
  booking: Booking;
  member: Member;
}): Promise<AppointmentRequest | null> {
  const existing = await storedRequestByBooking(input.booking.id);
  if (existing) {
    if (existing.status === "cancelled" && input.booking.status !== "cancelled") {
      const reopened: AppointmentRequest = {
        ...existing,
        date: input.booking.date,
        mode: input.booking.mode,
        status: "open",
        assignedProviderId: undefined,
        proposedDate: undefined,
        updatedAt: new Date().toISOString(),
      };
      await persistRequest(reopened);
      return reopened;
    }
    if (input.booking.status === "cancelled" && existing.status !== "cancelled") {
      return cancelRequestForBooking(input.booking.id);
    }
    if (existing.date !== input.booking.date || existing.mode !== input.booking.mode) {
      const next: AppointmentRequest = {
        ...existing,
        date: input.booking.date,
        mode: input.booking.mode,
        updatedAt: new Date().toISOString(),
      };
      await persistRequest(next);
      return next;
    }
    return existing;
  }

  const practice = practiceForService(input.booking.serviceId);
  if (!practice) return null;

  const now = new Date().toISOString();
  const request: AppointmentRequest = {
    id: `req_${crypto.randomUUID()}`,
    bookingId: input.booking.id,
    memberId: input.member.id,
    memberDisplayName: input.member.displayName,
    serviceId: input.booking.serviceId,
    serviceName: input.booking.serviceName,
    practiceId: practice.id,
    practiceName: practice.name,
    date: input.booking.date,
    mode: input.booking.mode,
    creditsCharged: input.booking.creditsCharged,
    status: input.booking.status === "cancelled" ? "cancelled" : "open",
    createdAt: now,
    updatedAt: now,
  };
  await persistRequest(request);
  return request;
}

export async function requestForBooking(bookingId: string): Promise<AppointmentRequest | null> {
  return storedRequestByBooking(bookingId);
}

export async function cancelRequestForBooking(bookingId: string): Promise<AppointmentRequest | null> {
  const existing = await storedRequestByBooking(bookingId);
  if (!existing) return null;
  if (existing.status === "cancelled") return existing;
  const next: AppointmentRequest = {
    ...existing,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  };
  await persistRequest(next);
  return next;
}

export async function listInboxForProvider(provider: ProviderAccount): Promise<AppointmentRequest[]> {
  const rows = await allRequests();
  return rows.filter((row) =>
    requestMatchesProvider(row, provider) && (row.status === "open" || row.status === "proposed")
  );
}

export async function listJobsForProvider(provider: ProviderAccount): Promise<AppointmentRequest[]> {
  const rows = await allRequests();
  return rows.filter((row) =>
    row.assignedProviderId === provider.id && (row.status === "accepted" || row.status === "proposed")
  );
}

export async function acceptRequest(input: {
  provider: ProviderAccount;
  requestId: string;
}): Promise<AppointmentRequest> {
  const request = await storedRequest(input.requestId);
  if (!request || !requestMatchesProvider(request, input.provider)) {
    throw new ProviderError("That request is not in your queue.", 404);
  }
  if (request.status === "cancelled") throw new ProviderError("That reservation was cancelled.");
  if (request.status === "declined") throw new ProviderError("That request was already declined.");
  if (request.status === "accepted" && request.assignedProviderId !== input.provider.id) {
    throw new ProviderError("Another provider already accepted this request.");
  }

  const blocks = await listStoredBlocks(input.provider.id);
  if (blocks.some((block) => block.date === request.date)) {
    throw new ProviderError("That time is blocked on your calendar.");
  }

  const now = new Date().toISOString();
  const next: AppointmentRequest = {
    ...request,
    status: "accepted",
    assignedProviderId: input.provider.id,
    updatedAt: now,
  };
  await persistRequest(next);
  if (request.status !== "accepted") {
    await persistAssignment({
      id: `asg_${crypto.randomUUID()}`,
      requestId: request.id,
      bookingId: request.bookingId,
      providerId: input.provider.id,
      practiceId: input.provider.practiceId,
      status: "accepted",
      createdAt: now,
    });
  }
  return next;
}

export async function declineRequest(input: {
  provider: ProviderAccount;
  requestId: string;
}): Promise<AppointmentRequest> {
  const request = await storedRequest(input.requestId);
  if (!request || !requestMatchesProvider(request, input.provider)) {
    throw new ProviderError("That request is not in your queue.", 404);
  }
  if (request.status === "accepted" && request.assignedProviderId === input.provider.id) {
    throw new ProviderError("Accepted jobs stay on your calendar. Ask the member to cancel if the visit cannot happen.");
  }
  if (request.status === "cancelled") throw new ProviderError("That reservation was cancelled.");

  const now = new Date().toISOString();
  const next: AppointmentRequest = {
    ...request,
    status: "declined",
    assignedProviderId: undefined,
    updatedAt: now,
  };
  await persistRequest(next);
  await persistAssignment({
    id: `asg_${crypto.randomUUID()}`,
    requestId: request.id,
    bookingId: request.bookingId,
    providerId: input.provider.id,
    practiceId: input.provider.practiceId,
    status: "declined",
    createdAt: now,
  });
  return next;
}

export async function proposeRequestTime(input: {
  provider: ProviderAccount;
  requestId: string;
  date: string;
}): Promise<AppointmentRequest> {
  const request = await storedRequest(input.requestId);
  if (!request || !requestMatchesProvider(request, input.provider)) {
    throw new ProviderError("That request is not in your queue.", 404);
  }
  if (request.status === "cancelled") throw new ProviderError("That reservation was cancelled.");
  if (request.status === "accepted" && request.assignedProviderId !== input.provider.id) {
    throw new ProviderError("Another provider already accepted this request.");
  }
  const date = input.date.trim();
  if (!date) throw new ProviderError("Choose a time to propose.");

  const now = new Date().toISOString();
  const next: AppointmentRequest = {
    ...request,
    status: "proposed",
    assignedProviderId: input.provider.id,
    proposedDate: date,
    updatedAt: now,
  };
  await persistRequest(next);
  await persistAssignment({
    id: `asg_${crypto.randomUUID()}`,
    requestId: request.id,
    bookingId: request.bookingId,
    providerId: input.provider.id,
    practiceId: input.provider.practiceId,
    status: "proposed",
    proposedDate: date,
    createdAt: now,
  });
  return next;
}

export async function blockProviderTime(input: {
  provider: ProviderAccount;
  date: string;
  note?: string;
}): Promise<ProviderBlock> {
  const date = input.date.trim();
  if (!date) throw new ProviderError("Choose a time to block.");
  const existing = await listStoredBlocks(input.provider.id);
  if (existing.some((block) => block.date === date)) {
    throw new ProviderError("That time is already blocked.");
  }
  const jobs = await listJobsForProvider(input.provider);
  if (jobs.some((job) => job.status === "accepted" && job.date === date)) {
    throw new ProviderError("You already accepted a visit at that time.");
  }
  const block: ProviderBlock = {
    id: `blk_${crypto.randomUUID()}`,
    providerId: input.provider.id,
    practiceId: input.provider.practiceId,
    date,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  await persistBlock(block);
  return block;
}

export async function unblockProviderTime(input: {
  provider: ProviderAccount;
  blockId: string;
}): Promise<ProviderBlock> {
  let block = blockMemory.get(input.blockId) ?? null;
  if (!block) {
    try {
      const db = await import("../db/provider");
      await db.ensureProviderWorkspaceSchema();
      block = await db.getProviderBlockById(input.blockId);
    } catch {
      block = null;
    }
  }
  if (!block || block.providerId !== input.provider.id) {
    throw new ProviderError("That block is not on your calendar.", 404);
  }
  blockMemory.delete(block.id);
  try {
    const db = await import("../db/provider");
    await db.ensureProviderWorkspaceSchema();
    await db.deleteProviderBlock(block.id);
  } catch {
    // Memory already cleared.
  }
  return block;
}

export async function listProviderBlocks(provider: ProviderAccount): Promise<ProviderBlock[]> {
  return listStoredBlocks(provider.id);
}

export async function ensureWalkthroughRequest(provider: ProviderAccount): Promise<AppointmentRequest | null> {
  const inbox = await listInboxForProvider(provider);
  if (inbox.length) return null;
  const jobs = await listJobsForProvider(provider);
  if (jobs.length) return null;

  const serviceId = provider.serviceIds[0] ?? TIDE_TONE_PRACTICE.serviceIds[0] ?? "deep-tissue";
  const practice = practiceForService(serviceId) ?? {id: provider.practiceId, name: provider.practiceName};
  const now = new Date().toISOString();
  const request: AppointmentRequest = {
    id: `req_walkthrough_${provider.id}`,
    bookingId: `b_walkthrough_${provider.id}`,
    memberId: "member_walkthrough",
    memberDisplayName: "Ava Ruiz",
    serviceId,
    serviceName: serviceId === "deep-tissue" ? "Deep Tissue Massage" : "Sports Massage",
    practiceId: practice.id,
    practiceName: practice.name,
    date: "Tomorrow · 6:00 PM",
    mode: "At home · Brickell",
    creditsCharged: 120,
    status: "open",
    walkthrough: true,
    note: "Labeled walkthrough request · not a live membership",
    createdAt: now,
    updatedAt: now,
  };
  await persistRequest(request);
  return request;
}

export function providerEmailsFromEnv(raw?: string): string[] {
  return parseProviderEmails(raw);
}
