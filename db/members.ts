import {eq} from "drizzle-orm";
import type {Member} from "../domain/types";
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
  };
}

export async function upsertMember(member: Member): Promise<Member | null> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return null;
  }

  const now = new Date().toISOString();
  const existing = await db.select().from(members).where(eq(members.email, member.email)).limit(1);
  const current = existing[0];
  const record = {
    id: current?.id ?? member.id,
    email: member.email,
    displayName: member.displayName,
    householdId: current?.householdId ?? member.householdId ?? null,
    planId: current?.planId ?? member.planId ?? "member",
    image: member.image ?? current?.image ?? null,
    authProvider: member.authProvider ?? current?.authProvider ?? null,
    createdAt: current?.createdAt ?? member.createdAt ?? now,
    updatedAt: now,
  };

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
        createdAt: now,
      }).onConflictDoNothing();
    } catch {
      // Account link is best-effort until migrations have been applied.
    }
  }

  return rowToMember(record);
}
