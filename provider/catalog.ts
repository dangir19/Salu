import {services} from "../domain/mock-data";
import type {ProviderAccount, ProviderAccountStatus} from "../domain/types";
import {findLiveCatalogService, parseLiveServiceId} from "../providers/catalog";

export type DemoPractice = {
  id: string;
  name: string;
  emails: string[];
  contactName: string;
  serviceIds: string[];
};

export const TIDE_TONE_PRACTICE: DemoPractice = {
  id: "tide-tone",
  name: "Tide & Tone Recovery",
  emails: ["tide@localhost", "provider@localhost"],
  contactName: "Sofia Alvarez",
  serviceIds: services.filter((service) => service.providerId === "tide-tone").map((service) => service.id),
};

export const DEMO_PRACTICES: DemoPractice[] = [TIDE_TONE_PRACTICE];

export const DEMO_PROVIDER_USER = {
  id: "provider_tide_tone",
  name: TIDE_TONE_PRACTICE.contactName,
  email: TIDE_TONE_PRACTICE.emails[0],
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function practiceForService(serviceId: string): {id: string; name: string} | null {
  const live = parseLiveServiceId(serviceId);
  if (live) {
    const catalog = findLiveCatalogService(serviceId);
    return {id: live.applicationId, name: catalog?.provider ?? "Independent provider"};
  }
  const service = services.find((row) => row.id === serviceId);
  if (!service) return null;
  return {id: service.providerId, name: service.provider};
}

export function practiceById(practiceId: string): DemoPractice | null {
  return DEMO_PRACTICES.find((practice) => practice.id === practiceId) ?? null;
}

export function practiceForEmail(email: string): DemoPractice | null {
  const normalized = normalizeEmail(email);
  return DEMO_PRACTICES.find((practice) => practice.emails.includes(normalized)) ?? null;
}

export function parseProviderEmails(raw?: string): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((value) => normalizeEmail(value)).filter(Boolean))];
}

export function demoAccountFromPractice(
  practice: DemoPractice,
  email: string,
  displayName?: string,
  status: ProviderAccountStatus = "demo",
): ProviderAccount {
  const now = new Date().toISOString();
  return {
    id: `prov_${practice.id}_${normalizeEmail(email).replace(/[^a-z0-9]+/g, "_")}`,
    email: normalizeEmail(email),
    displayName: displayName?.trim() || practice.contactName,
    practiceId: practice.id,
    practiceName: practice.name,
    status,
    serviceIds: [...practice.serviceIds],
    createdAt: now,
    updatedAt: now,
  };
}
