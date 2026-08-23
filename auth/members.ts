import type {Member} from "../domain/types";

const memory = new Map<string, Member>();

function mergeMember(existing: Member | undefined, member: Member, preferIncomingBilling = false): Member {
  return {
    ...existing,
    ...member,
    id: existing?.id ?? member.id,
    householdId: existing?.householdId ?? member.householdId,
    planId: preferIncomingBilling
      ? (member.planId ?? existing?.planId ?? "member")
      : (existing?.planId ?? member.planId ?? "member"),
    createdAt: existing?.createdAt ?? member.createdAt ?? new Date().toISOString(),
    stripeCustomerId: member.stripeCustomerId ?? existing?.stripeCustomerId,
    stripeSubscriptionId: member.stripeSubscriptionId ?? existing?.stripeSubscriptionId,
    membershipStatus: member.membershipStatus ?? existing?.membershipStatus,
  };
}

export function memoryUpsertMember(member: Member, preferIncomingBilling = false): Member {
  const existing =
    memory.get(member.id) ??
    [...memory.values()].find((row) => row.email === member.email);
  const next = mergeMember(existing, member, preferIncomingBilling);
  if (existing && existing.id !== next.id) memory.delete(existing.id);
  memory.set(next.id, next);
  return next;
}

export function memoryGetMember(id: string): Member | null {
  return memory.get(id) ?? null;
}

export function memoryGetMemberByEmail(email: string): Member | null {
  const normalized = email.trim().toLowerCase();
  return [...memory.values()].find((row) => row.email === normalized) ?? null;
}

export function memoryGetMemberByStripeCustomer(customerId: string): Member | null {
  return [...memory.values()].find((row) => row.stripeCustomerId === customerId) ?? null;
}

export function resetMemberMemory(): void {
  memory.clear();
}

export async function upsertMemberRecord(member: Member): Promise<Member> {
  try {
    const persisted = await persistWithD1(member);
    if (persisted) return persisted;
  } catch {
    // D1 is optional until hosting.json binds DB and migrations apply.
  }
  return memoryUpsertMember(member);
}

export async function getMemberRecord(id: string): Promise<Member | null> {
  try {
    const persisted = await (await import("../db/members")).getMemberById(id);
    if (persisted) return persisted;
  } catch {
    // Fall through to memory.
  }
  return memoryGetMember(id);
}

export async function findMemberRecord(input: {
  id?: string | null;
  email?: string | null;
  stripeCustomerId?: string | null;
}): Promise<Member | null> {
  if (input.id) {
    const byId = await getMemberRecord(input.id);
    if (byId) return byId;
  }
  if (input.stripeCustomerId) {
    try {
      const persisted = await (await import("../db/members")).getMemberByStripeCustomerId(input.stripeCustomerId);
      if (persisted) return persisted;
    } catch {
      // Fall through to memory.
    }
    const fromMemory = memoryGetMemberByStripeCustomer(input.stripeCustomerId);
    if (fromMemory) return fromMemory;
  }
  if (input.email) {
    try {
      const persisted = await (await import("../db/members")).getMemberByEmail(input.email);
      if (persisted) return persisted;
    } catch {
      // Fall through to memory.
    }
    return memoryGetMemberByEmail(input.email);
  }
  return null;
}

export async function updateMemberBilling(memberId: string, patch: Partial<Member>): Promise<Member | null> {
  const current = await findMemberRecord({id: memberId, email: patch.email, stripeCustomerId: patch.stripeCustomerId});
  if (!current) return null;
  const next: Member = {
    ...current,
    ...patch,
    id: current.id,
    email: patch.email ?? current.email,
    planId: patch.planId ?? current.planId,
    stripeCustomerId: patch.stripeCustomerId ?? current.stripeCustomerId,
    stripeSubscriptionId:
      patch.stripeSubscriptionId === "" ? undefined : (patch.stripeSubscriptionId ?? current.stripeSubscriptionId),
    membershipStatus: patch.membershipStatus ?? current.membershipStatus,
  };

  try {
    const persisted = await (await import("../db/members")).patchMemberBilling(current.id, next);
    if (persisted) return persisted;
  } catch {
    // D1 is optional.
  }
  return memoryUpsertMember(next, true);
}

async function persistWithD1(member: Member): Promise<Member | null> {
  const mod = await import("../db/members");
  return mod.upsertMember(member);
}
