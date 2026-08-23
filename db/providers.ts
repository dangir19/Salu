import {desc, eq, sql} from "drizzle-orm";
import type {ProviderApplication, ProviderApplicationStatus, ProviderDocStatus, ProviderLicenseType} from "../domain/types";
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
    fullName: row.fullName,
    email: row.email,
    phone: row.phone ?? undefined,
    licenseType: row.licenseType as ProviderLicenseType,
    licenseNumber: row.licenseNumber,
    mobileAtHome: Boolean(row.mobileAtHome),
    neighborhoods: parseList(row.neighborhoods),
    rateAsk: row.rateAsk,
    insuranceAttested: Boolean(row.insuranceAttested),
    docsLicenseProof: row.docsLicenseProof as ProviderDocStatus,
    docsInsurance: row.docsInsurance as ProviderDocStatus,
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
      full_name text NOT NULL,
      email text NOT NULL,
      phone text,
      license_type text NOT NULL,
      license_number text NOT NULL,
      mobile_at_home integer DEFAULT 0 NOT NULL,
      neighborhoods text NOT NULL,
      rate_ask text NOT NULL,
      insurance_attested integer DEFAULT 0 NOT NULL,
      docs_license_proof text DEFAULT 'missing' NOT NULL,
      docs_insurance text DEFAULT 'missing' NOT NULL,
      notes text,
      status text NOT NULL,
      review_note text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    try {
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS provider_applications_status_idx ON provider_applications (status)`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS provider_applications_email_idx ON provider_applications (email)`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS provider_applications_license_type_idx ON provider_applications (license_type)`));
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
      fullName: application.fullName,
      email: application.email,
      phone: application.phone ?? null,
      licenseType: application.licenseType,
      licenseNumber: application.licenseNumber,
      mobileAtHome: application.mobileAtHome ? 1 : 0,
      neighborhoods: JSON.stringify(application.neighborhoods),
      rateAsk: application.rateAsk,
      insuranceAttested: application.insuranceAttested ? 1 : 0,
      docsLicenseProof: application.docsLicenseProof,
      docsInsurance: application.docsInsurance,
      notes: application.notes ?? null,
      status: application.status,
      reviewNote: application.reviewNote ?? null,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
    });
    return true;
  }));
}

export type ProviderApplicationPatch = Partial<Pick<ProviderApplication, "status" | "reviewNote" | "docsLicenseProof" | "docsInsurance" | "updatedAt">>;

export async function updateProviderApplication(id: string, patch: ProviderApplicationPatch): Promise<ProviderApplication | null> {
  return withProvidersDb(async (db) => {
    const rows = await db.select().from(providerApplications).where(eq(providerApplications.id, id)).limit(1);
    const current = rows[0];
    if (!current) return null;
    const next = {
      status: patch.status ?? current.status,
      reviewNote: patch.reviewNote === "" ? null : (patch.reviewNote ?? current.reviewNote),
      docsLicenseProof: patch.docsLicenseProof ?? current.docsLicenseProof,
      docsInsurance: patch.docsInsurance ?? current.docsInsurance,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    await db.update(providerApplications).set(next).where(eq(providerApplications.id, id));
    return applicationFromRow({...current, ...next});
  });
}
