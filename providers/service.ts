import type {ProviderApplication, ProviderApplicationStatus, ProviderDocStatus, ProviderLicenseType} from "../domain/types";
import type {ProviderProfile, Service} from "../domain/mock-data";
import {
  catalogFromApplication,
  parseLiveServiceId,
  PROVIDER_LICENSE_TYPES,
  PROVIDER_NEIGHBORHOODS,
  PROVIDER_RATE_ASKS,
  rememberLiveServices,
} from "./catalog";

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export const APPLICATION_STATUSES: ProviderApplicationStatus[] = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
];

export const DOC_STATUSES: ProviderDocStatus[] = ["missing", "received"];

export type ApplicationListFilter = {
  status?: ProviderApplicationStatus;
  neighborhood?: string;
  mobile?: boolean;
  licenseType?: ProviderLicenseType;
  docs?: "missing_license" | "missing_insurance" | "complete";
};

const memory = new Map<string, ProviderApplication>();

export function resetProviderMemory(): void {
  memory.clear();
}

function sortApplications(rows: ProviderApplication[]): ProviderApplication[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function cleanNeighborhoods(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter((value) => (PROVIDER_NEIGHBORHOODS as readonly string[]).includes(value)))];
}

function isLicenseType(value: string): value is ProviderLicenseType {
  return (PROVIDER_LICENSE_TYPES as string[]).includes(value);
}

function isDocStatus(value: string): value is ProviderDocStatus {
  return DOC_STATUSES.includes(value as ProviderDocStatus);
}

function matchesFilter(row: ProviderApplication, filter: ApplicationListFilter): boolean {
  if (filter.status && row.status !== filter.status) return false;
  if (filter.neighborhood && !row.neighborhoods.includes(filter.neighborhood)) return false;
  if (typeof filter.mobile === "boolean" && row.mobileAtHome !== filter.mobile) return false;
  if (filter.licenseType && row.licenseType !== filter.licenseType) return false;
  if (filter.docs === "missing_license" && row.docsLicenseProof !== "missing") return false;
  if (filter.docs === "missing_insurance" && row.docsInsurance !== "missing") return false;
  if (filter.docs === "complete" && (row.docsLicenseProof !== "received" || row.docsInsurance !== "received")) return false;
  return true;
}

async function persistApplication(application: ProviderApplication): Promise<void> {
  memory.set(application.id, application);
  try {
    const db = await import("../db/providers");
    await db.ensureProviderApplicationsSchema();
    const existing = await db.getProviderApplicationById(application.id);
    if (existing) {
      await db.updateProviderApplication(application.id, {
        status: application.status,
        reviewNote: application.reviewNote,
        docsLicenseProof: application.docsLicenseProof,
        docsInsurance: application.docsInsurance,
        updatedAt: application.updatedAt,
      });
    } else {
      await db.insertProviderApplication(application);
    }
  } catch {
    // D1 is optional until the provider applications migration is applied.
  }
}

async function storedApplication(id: string): Promise<ProviderApplication | null> {
  try {
    const db = await import("../db/providers");
    await db.ensureProviderApplicationsSchema();
    const persisted = await db.getProviderApplicationById(id);
    if (persisted) {
      memory.set(persisted.id, persisted);
      return persisted;
    }
  } catch {
    // Fall through to memory.
  }
  return memory.get(id) ?? null;
}

export async function listApplications(filter: ApplicationListFilter = {}): Promise<ProviderApplication[]> {
  try {
    const db = await import("../db/providers");
    await db.ensureProviderApplicationsSchema();
    const persisted = await db.listProviderApplications(filter.status);
    if (persisted) {
      for (const row of persisted) memory.set(row.id, row);
      return persisted.filter((row) => matchesFilter(row, filter));
    }
  } catch {
    // Memory fallback.
  }
  return sortApplications([...memory.values()]).filter((row) => matchesFilter(row, filter));
}

export async function listApplicationsForEmail(email: string): Promise<ProviderApplication[]> {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  try {
    const db = await import("../db/providers");
    await db.ensureProviderApplicationsSchema();
    const persisted = await db.listProviderApplicationsByEmail(normalized);
    if (persisted) {
      for (const row of persisted) memory.set(row.id, row);
      return persisted;
    }
  } catch {
    // Memory fallback.
  }
  return sortApplications([...memory.values()].filter((row) => row.email === normalized));
}

export type ProviderCatalog = {
  services: Service[];
  providers: ProviderProfile[];
};

export async function listApprovedCatalog(): Promise<ProviderCatalog> {
  const approved = (await listApplications({status: "approved"}))
    .map(catalogFromApplication)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const services = approved.flatMap((entry) => entry.services);
  rememberLiveServices(services);
  return {
    services,
    providers: approved.map((entry) => entry.provider),
  };
}

export async function findApprovedCatalogService(serviceId: string): Promise<Service | null> {
  const parsed = parseLiveServiceId(serviceId);
  if (!parsed) return null;
  const application = await storedApplication(parsed.applicationId);
  if (!application || application.status !== "approved") return null;
  const catalog = catalogFromApplication(application);
  return catalog?.services.find((service) => service.id === serviceId) ?? null;
}

export async function submitApplication(input: {
  fullName?: string;
  email?: string;
  phone?: string;
  licenseType?: string;
  licenseNumber?: string;
  mobileAtHome?: unknown;
  neighborhoods?: unknown;
  rateAsk?: string;
  insuranceAttested?: unknown;
  notes?: string;
}): Promise<ProviderApplication> {
  const fullName = input.fullName?.trim() ?? "";
  const email = normalizeEmail(input.email ?? "");
  const phone = input.phone?.trim();
  const licenseType = input.licenseType?.trim() ?? "";
  const licenseNumber = input.licenseNumber?.trim().toUpperCase() ?? "";
  const neighborhoods = cleanNeighborhoods(input.neighborhoods);
  const rateAsk = input.rateAsk?.trim() ?? "";
  const notes = input.notes?.trim();
  const mobileAtHome = input.mobileAtHome === true || input.mobileAtHome === "yes" || input.mobileAtHome === "true";

  if (!fullName) throw new ProviderError("Please share your full legal name.");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ProviderError("A working email helps BD follow up.");
  if (!isLicenseType(licenseType)) throw new ProviderError("Choose your Florida license type.");
  if (!licenseNumber || licenseNumber.length < 4) throw new ProviderError("Add your Florida license number.");
  if (typeof input.mobileAtHome !== "boolean" && input.mobileAtHome !== "yes" && input.mobileAtHome !== "no" && input.mobileAtHome !== "true" && input.mobileAtHome !== "false") {
    throw new ProviderError("Tell us whether you can work mobile / at-home.");
  }
  if (!neighborhoods.length) throw new ProviderError("Choose Brickell, Miami Beach, and/or Miami-Dade.");
  if (!rateAsk) throw new ProviderError("Share your rate ask so BD can place you in the Miami pipeline.");
  const allowedRate = (PROVIDER_RATE_ASKS as readonly string[]).includes(rateAsk);
  if (!allowedRate && rateAsk.length > 80) throw new ProviderError("Keep the rate ask short — a typical visit rate is enough.");
  if (!input.insuranceAttested) throw new ProviderError("Please attest that you carry professional liability insurance, or will before seeing members.");

  const now = new Date().toISOString();
  const application: ProviderApplication = {
    id: `pa_${crypto.randomUUID()}`,
    fullName,
    email,
    phone: phone || undefined,
    licenseType,
    licenseNumber,
    mobileAtHome,
    neighborhoods,
    rateAsk,
    insuranceAttested: true,
    docsLicenseProof: "missing",
    docsInsurance: "missing",
    notes: notes || undefined,
    status: "submitted",
    createdAt: now,
    updatedAt: now,
  };
  await persistApplication(application);
  return application;
}

export async function updateApplicationStatus(input: {
  id?: string;
  status?: string;
  action?: string;
  reviewNote?: string;
  docsLicenseProof?: string;
  docsInsurance?: string;
}): Promise<ProviderApplication> {
  const id = input.id?.trim() ?? "";
  if (!id) throw new ProviderError("Choose an application to update.");
  const current = await storedApplication(id);
  if (!current) throw new ProviderError("That application is not in the Miami pipeline.", 404);

  const action = input.action?.trim().toLowerCase();
  let status = input.status?.trim();
  if (action) {
    if (action !== "request-info") {
      throw new ProviderError("Unknown review action.");
    }
    const note = input.reviewNote?.trim() ?? "";
    if (!note) {
      throw new ProviderError("Add a note telling the applicant what you still need.");
    }
    status = "under_review";
  }
  if (status && !APPLICATION_STATUSES.includes(status as ProviderApplicationStatus)) {
    throw new ProviderError("Status must be submitted, under review, approved, or rejected.");
  }
  if (input.docsLicenseProof && !isDocStatus(input.docsLicenseProof)) {
    throw new ProviderError("License proof must be missing or received.");
  }
  if (input.docsInsurance && !isDocStatus(input.docsInsurance)) {
    throw new ProviderError("Insurance docs must be missing or received.");
  }

  const next: ProviderApplication = {
    ...current,
    status: (status as ProviderApplicationStatus | undefined) ?? current.status,
    reviewNote: input.reviewNote !== undefined ? (input.reviewNote.trim() || undefined) : current.reviewNote,
    docsLicenseProof: input.docsLicenseProof && isDocStatus(input.docsLicenseProof) ? input.docsLicenseProof : current.docsLicenseProof,
    docsInsurance: input.docsInsurance && isDocStatus(input.docsInsurance) ? input.docsInsurance : current.docsInsurance,
    updatedAt: new Date().toISOString(),
  };
  await persistApplication(next);
  if (next.status === "approved") {
    await listApprovedCatalog();
    try {
      const db = await import("../db/providers");
      await db.insertProviderAccountFromApplication(next);
    } catch {
      // Approved applications still resolve to provider accounts dynamically
      // when the provider signs in with their native member account.
    }
  }
  return next;
}
