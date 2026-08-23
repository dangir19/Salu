import type {Member} from "../domain/types";

const memory = new Map<string, Member>();

export function memoryUpsertMember(member: Member): Member {
  const existing = [...memory.values()].find((row) => row.email === member.email);
  const next: Member = {
    ...existing,
    ...member,
    id: existing?.id ?? member.id,
    householdId: existing?.householdId ?? member.householdId,
    planId: existing?.planId ?? member.planId ?? "member",
    createdAt: existing?.createdAt ?? member.createdAt ?? new Date().toISOString(),
  };
  memory.set(next.id, next);
  return next;
}

export function memoryGetMember(id: string): Member | null {
  return memory.get(id) ?? null;
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

async function persistWithD1(member: Member): Promise<Member | null> {
  const mod = await import("../db/members");
  return mod.upsertMember(member);
}
