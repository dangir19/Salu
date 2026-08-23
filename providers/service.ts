import type {ProviderApplication, ProviderApplicationStatus} from "../domain/types";
import type {ProviderProfile, Service} from "../domain/mock-data";
import {
  catalogFromApplication,
  optionForServiceName,
  parseLiveServiceId,
  PROVIDER_NEIGHBORHOODS,
  PROVIDER_RATE_EXPECTATIONS,
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

function cleanList(values: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(values)) return [];
  const unique = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (!allowed) return unique;
  return unique.filter((value) => allowed.includes(value) || Boolean(optionForServiceName(value)));
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

export async function listApplications(status?: ProviderApplicationStatus): Promise<ProviderApplication[]> {
  try {
    const db = await import("../db/providers");
    await db.ensureProviderApplicationsSchema();
    const persisted = await db.listProviderApplications(status);
    if (persisted) {
      for (const row of persisted) memory.set(row.id, row);
      return persisted;
    }
  } catch {
    // Memory fallback.
  }
  const rows = sortApplications([...memory.values()]);
  return status ? rows.filter((row) => row.status === status) : rows;
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
  const approved = (await listApplications("approved"))
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
  businessName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  services?: unknown;
  neighborhoods?: unknown;
  licenseAttested?: unknown;
  insuranceAttested?: unknown;
  rateExpectation?: string;
  website?: string;
  notes?: string;
}): Promise<ProviderApplication> {
  const businessName = input.businessName?.trim() ?? "";
  const contactName = input.contactName?.trim() ?? "";
  const email = normalizeEmail(input.email ?? "");
  const phone = input.phone?.trim();
  const website = input.website?.trim();
  const notes = input.notes?.trim();
  const services = cleanList(input.services);
  const neighborhoods = cleanList(input.neighborhoods, PROVIDER_NEIGHBORHOODS);
  const rateExpectation = input.rateExpectation?.trim() ?? "";
  const resolvedServices = services
    .map((name) => optionForServiceName(name)?.name)
    .filter((name): name is string => Boolean(name));

  if (!businessName || !contactName) throw new ProviderError("Please share the practice name and who we should write to.");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ProviderError("A working email helps us follow up.");
  if (!resolvedServices.length) throw new ProviderError("Choose at least one service you would like to offer members.");
  if (!neighborhoods.length) throw new ProviderError("Choose the Miami neighborhoods you already serve.");
  if (!input.licenseAttested) throw new ProviderError("Please attest that you hold the licenses required for this work.");
  if (!input.insuranceAttested) throw new ProviderError("Please attest that you carry appropriate professional liability insurance.");
  if (!rateExpectation) throw new ProviderError("Share a typical visit rate so BD can place you in the Miami pipeline.");
  const allowedRate = (PROVIDER_RATE_EXPECTATIONS as readonly string[]).includes(rateExpectation);
  if (!allowedRate && rateExpectation.length > 80) throw new ProviderError("Keep the rate note short — a typical visit range is enough.");

  const now = new Date().toISOString();
  const application: ProviderApplication = {
    id: `pa_${crypto.randomUUID()}`,
    businessName,
    contactName,
    email,
    phone: phone || undefined,
    services: resolvedServices,
    neighborhoods,
    licenseAttested: true,
    insuranceAttested: true,
    rateExpectation,
    website: website || undefined,
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
  reviewNote?: string;
}): Promise<ProviderApplication> {
  const id = input.id?.trim() ?? "";
  const status = input.status?.trim() as ProviderApplicationStatus | undefined;
  if (!id) throw new ProviderError("Choose an application to update.");
  if (!status || !APPLICATION_STATUSES.includes(status)) {
    throw new ProviderError("Status must be submitted, under review, approved, or rejected.");
  }
  const current = await storedApplication(id);
  if (!current) throw new ProviderError("That application is not in the Miami pipeline.", 404);
  const next: ProviderApplication = {
    ...current,
    status,
    reviewNote: input.reviewNote?.trim() || current.reviewNote,
    updatedAt: new Date().toISOString(),
  };
  await persistApplication(next);
  if (next.status === "approved") await listApprovedCatalog();
  return next;
}
