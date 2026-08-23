import {eq} from "drizzle-orm";
import type {Member, MembershipStatus} from "../domain/types";
import {getDb} from "./index";
import {memberAccounts, members} from "./schema";

function rowToMember(row: typeof members.$inferSelect): Member {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    householdId: row.householdId ?? undefined,
    planId: row.planId,
    authProvider: (row.authProvider as Member["authProvider"]) ?? undefined,
    image: row.image ?? undefined,
    createdAt: row.createdAt,
    stripeCustomerId: row.stripeCustomerId ?? undefined,
    stripeSubscriptionId: row.stripeSubscriptionId ?? undefined,
    membershipStatus: (row.membershipStatus as MembershipStatus | null) ?? undefined,
  };
}

function memberRecord(member: Member, current?: typeof members.$inferSelect) {
  const now = new Date().toISOString();
  return {
    id: current?.id ?? member.id,
    email: member.email,
    displayName: member.displayName,
    householdId: current?.householdId ?? member.householdId ?? null,
    planId: current?.planId ?? member.planId ?? "member",
    image: member.image ?? current?.image ?? null,
    authProvider: member.authProvider ?? current?.authProvider ?? null,
    stripeCustomerId: current?.stripeCustomerId ?? member.stripeCustomerId ?? null,
    stripeSubscriptionId: current?.stripeSubscriptionId ?? member.stripeSubscriptionId ?? null,
    membershipStatus: current?.membershipStatus ?? member.membershipStatus ?? "none",
    createdAt: current?.createdAt ?? member.createdAt ?? now,
    updatedAt: now,
  };
}

export async function upsertMember(member: Member): Promise<Member | null> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return null;
  }

  const existing = await db.select().from(members).where(eq(members.email, member.email)).limit(1);
  const current = existing[0];
  const record = memberRecord(member, current);

  if (current) {
    await db.update(members).set(record).where(eq(members.id, current.id));
  } else {
    await db.insert(members).values(record);
  }

  if (member.authProvider) {
    try {
      await db.insert(memberAccounts).values({
        provider: member.authProvider,
        providerAccountId: member.id,
        memberId: record.id,
        createdAt: record.updatedAt,
      }).onConflictDoNothing();
    } catch {
      // Account link is best-effort until migrations have been applied.
    }
  }

  return rowToMember(record);
}

export async function patchMemberBilling(id: string, patch: Partial<Member>): Promise<Member | null> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return null;
  }

  const rows = await db.select().from(members).where(eq(members.id, id)).limit(1);
  const current = rows[0];
  if (!current) return null;

  const now = new Date().toISOString();
  const record = {
    planId: patch.planId ?? current.planId,
    stripeCustomerId:
      patch.stripeCustomerId === "" ? null : (patch.stripeCustomerId ?? current.stripeCustomerId),
    stripeSubscriptionId:
      patch.stripeSubscriptionId === "" ? null : (patch.stripeSubscriptionId ?? current.stripeSubscriptionId),
    membershipStatus: patch.membershipStatus ?? current.membershipStatus,
    updatedAt: now,
  };
  await db.update(members).set(record).where(eq(members.id, current.id));
  return rowToMember({...current, ...record});
}

export async function getMemberById(id: string): Promise<Member | null> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return null;
  }
  const rows = await db.select().from(members).where(eq(members.id, id)).limit(1);
  return rows[0] ? rowToMember(rows[0]) : null;
}

export async function getMemberByEmail(email: string): Promise<Member | null> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return null;
  }
  const rows = await db.select().from(members).where(eq(members.email, email.toLowerCase())).limit(1);
  return rows[0] ? rowToMember(rows[0]) : null;
}

export async function getMemberByStripeCustomerId(customerId: string): Promise<Member | null> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return null;
  }
  const rows = await db.select().from(members).where(eq(members.stripeCustomerId, customerId)).limit(1);
  return rows[0] ? rowToMember(rows[0]) : null;
}
