import {desc, eq, sql} from "drizzle-orm";
import type {ProviderApplication, ProviderApplicationStatus} from "../domain/types";
import {getDb} from "./index";
import {providerApplications} from "./schema";

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
  }
}

function applicationFromRow(row: typeof providerApplications.$inferSelect): ProviderApplication {
  return {
    id: row.id,
    businessName: row.businessName,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone ?? undefined,
    services: parseList(row.services),
    neighborhoods: parseList(row.neighborhoods),
    licenseAttested: Boolean(row.licenseAttested),
    insuranceAttested: Boolean(row.insuranceAttested),
    rateExpectation: row.rateExpectation,
    website: row.website ?? undefined,
    notes: row.notes ?? undefined,
    status: row.status as ProviderApplicationStatus,
    reviewNote: row.reviewNote ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function withProvidersDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | null> {
  try {
    return await fn(getDb());
  } catch {
    return null;
  }
}

export async function ensureProviderApplicationsSchema(): Promise<boolean> {
  return Boolean(await withProvidersDb(async (db) => {
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS provider_applications (
      id text PRIMARY KEY NOT NULL,
      business_name text NOT NULL,
      contact_name text NOT NULL,
      email text NOT NULL,
      phone text,
      services text NOT NULL,
      neighborhoods text NOT NULL,
      license_attested integer DEFAULT 0 NOT NULL,
      insurance_attested integer DEFAULT 0 NOT NULL,
      rate_expectation text NOT NULL,
      website text,
      notes text,
      status text NOT NULL,
      review_note text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    try {
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS provider_applications_status_idx ON provider_applications (status)`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS provider_applications_email_idx ON provider_applications (email)`));
    } catch {
      // Index already exists, or the D1 dialect rejected IF NOT EXISTS.
    }
    return true;
  }));
}

export async function listProviderApplications(status?: ProviderApplicationStatus): Promise<ProviderApplication[] | null> {
  return withProvidersDb(async (db) => {
    const rows = status
      ? await db
        .select()
        .from(providerApplications)
        .where(eq(providerApplications.status, status))
        .orderBy(desc(providerApplications.createdAt))
      : await db.select().from(providerApplications).orderBy(desc(providerApplications.createdAt));
    return rows.map(applicationFromRow);
  });
}

export async function listApprovedProviderApplications(): Promise<ProviderApplication[] | null> {
  return listProviderApplications("approved");
}

export async function getProviderApplicationById(id: string): Promise<ProviderApplication | null> {
  return withProvidersDb(async (db) => {
    const rows = await db.select().from(providerApplications).where(eq(providerApplications.id, id)).limit(1);
    return rows[0] ? applicationFromRow(rows[0]) : null;
  });
}

export async function listProviderApplicationsByEmail(email: string): Promise<ProviderApplication[] | null> {
  return withProvidersDb(async (db) => {
    const rows = await db
      .select()
      .from(providerApplications)
      .where(eq(providerApplications.email, email))
      .orderBy(desc(providerApplications.createdAt));
    return rows.map(applicationFromRow);
  });
}

export async function insertProviderApplication(application: ProviderApplication): Promise<boolean> {
  return Boolean(await withProvidersDb(async (db) => {
    await db.insert(providerApplications).values({
      id: application.id,
      businessName: application.businessName,
      contactName: application.contactName,
      email: application.email,
      phone: application.phone ?? null,
      services: JSON.stringify(application.services),
      neighborhoods: JSON.stringify(application.neighborhoods),
      licenseAttested: application.licenseAttested ? 1 : 0,
      insuranceAttested: application.insuranceAttested ? 1 : 0,
      rateExpectation: application.rateExpectation,
      website: application.website ?? null,
      notes: application.notes ?? null,
      status: application.status,
      reviewNote: application.reviewNote ?? null,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
    });
    return true;
  }));
}

export async function updateProviderApplication(
  id: string,
  patch: Pick<ProviderApplication, "status" | "reviewNote" | "updatedAt">,
): Promise<ProviderApplication | null> {
  return withProvidersDb(async (db) => {
    const rows = await db.select().from(providerApplications).where(eq(providerApplications.id, id)).limit(1);
    const current = rows[0];
    if (!current) return null;
    const next = {
      status: patch.status,
      reviewNote: patch.reviewNote === "" ? null : (patch.reviewNote ?? current.reviewNote),
      updatedAt: patch.updatedAt,
    };
    await db.update(providerApplications).set(next).where(eq(providerApplications.id, id));
    return applicationFromRow({...current, ...next});
  });
}
