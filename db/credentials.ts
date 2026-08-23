import {eq, sql} from "drizzle-orm";
import {getDb} from "./index";
import {memberCredentials} from "./schema";

export type CredentialRow = typeof memberCredentials.$inferSelect;

export async function withCredentialsDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | null> {
  try {
    return await fn(getDb());
  } catch {
    return null;
  }
}

export async function ensureCredentialsSchema(): Promise<boolean> {
  return Boolean(
    await withCredentialsDb(async (db) => {
      await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS member_credentials (
        email text PRIMARY KEY NOT NULL,
        member_id text NOT NULL,
        password_hash text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL
      )`));
      try {
        await db.run(
          sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS member_credentials_member_id_idx ON member_credentials (member_id)`),
        );
      } catch {
        // Index already exists, or the D1 dialect rejected IF NOT EXISTS.
      }
      return true;
    }),
  );
}

export async function getCredentialByEmail(email: string): Promise<CredentialRow | null> {
  await ensureCredentialsSchema();
  return withCredentialsDb(async (db) => {
    const rows = await db
      .select()
      .from(memberCredentials)
      .where(eq(memberCredentials.email, email))
      .limit(1);
    const row = rows[0];
    return row ?? null;
  });
}

export async function insertCredential(row: CredentialRow): Promise<CredentialRow | null> {
  await ensureCredentialsSchema();
  return withCredentialsDb(async (db) => {
    await db.insert(memberCredentials).values(row);
    return row;
  });
}
