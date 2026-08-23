import {services as mockServices, type ProviderProfile, type Service} from "../domain/mock-data";
import type {ProviderApplication, ProviderLicenseType} from "../domain/types";

export const PROVIDER_NEIGHBORHOODS = ["Brickell", "Miami Beach", "Miami-Dade"] as const;

export const PROVIDER_LICENSE_TYPES: ProviderLicenseType[] = [
  "LMT",
  "RN",
  "Acupuncture Physician",
  "Esthetician",
  "Stretch practitioner",
  "Other",
];

export const PROVIDER_RATE_ASKS = [
  "$100 / visit",
  "$125 / visit",
  "$150 / visit",
  "$175 / visit",
  "$200 / visit",
  "$250+ / visit",
] as const;

type ProviderServiceOption = {
  key: string;
  name: string;
  category: "Recovery" | "Aesthetic" | "Clinical";
  duration: string;
  defaultPrice: number;
};

const SERVICE_OPTIONS: ProviderServiceOption[] = [
  {key: "deep-tissue", name: "Deep Tissue Massage", category: "Recovery", duration: "60 min", defaultPrice: 150},
  {key: "sports-massage", name: "Sports Massage", category: "Recovery", duration: "60 min", defaultPrice: 150},
  {key: "stretch", name: "Assisted Stretching", category: "Recovery", duration: "45 min", defaultPrice: 100},
  {key: "lymphatic-massage", name: "Lymphatic Drainage Massage", category: "Aesthetic", duration: "60 min", defaultPrice: 150},
  {key: "facial", name: "Facial", category: "Aesthetic", duration: "60 min", defaultPrice: 150},
  {key: "facial-workout", name: "Facial Workout Massage", category: "Aesthetic", duration: "45 min", defaultPrice: 100},
  {key: "blood-draw", name: "Blood Tests", category: "Clinical", duration: "30 min", defaultPrice: 100},
  {key: "iv", name: "IV Drip", category: "Clinical", duration: "60 min", defaultPrice: 125},
  {key: "nad", name: "NAD+ Drip", category: "Clinical", duration: "90 min", defaultPrice: 300},
  {key: "acupuncture", name: "Acupuncture", category: "Recovery", duration: "60 min", defaultPrice: 150},
];

const LICENSE_SERVICES: Record<ProviderLicenseType, string[]> = {
  LMT: ["deep-tissue", "sports-massage", "lymphatic-massage"],
  RN: ["blood-draw", "iv"],
  "Acupuncture Physician": ["acupuncture"],
  Esthetician: ["facial", "facial-workout"],
  "Stretch practitioner": ["stretch"],
  Other: ["deep-tissue"],
};

const liveServices = new Map<string, Service>();

export function rememberLiveServices(rows: Service[]): void {
  liveServices.clear();
  for (const row of rows) liveServices.set(row.id, row);
}

export function findLiveCatalogService(serviceId: string): Service | null {
  return liveServices.get(serviceId) ?? null;
}

export function resetLiveCatalogMemory(): void {
  liveServices.clear();
}

export function liveServiceId(applicationId: string, serviceKey: string): string {
  return `live~${applicationId}~${serviceKey}`;
}

export function parseLiveServiceId(serviceId: string): {applicationId: string; serviceKey: string} | null {
  if (!serviceId.startsWith("live~")) return null;
  const rest = serviceId.slice("live~".length);
  const separator = rest.lastIndexOf("~");
  if (separator <= 0) return null;
  return {applicationId: rest.slice(0, separator), serviceKey: rest.slice(separator + 1)};
}

export function optionForServiceKey(key: string): ProviderServiceOption | null {
  return SERVICE_OPTIONS.find((option) => option.key === key) ?? null;
}

export function rateFromAsk(text: string, fallback = 150): number {
  const match = text.replace(/,/g, "").match(/(\d{2,4})/);
  return match ? Number(match[1]) : fallback;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "S";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "S";
}

export function servicesForLicense(licenseType: ProviderLicenseType): ProviderServiceOption[] {
  return (LICENSE_SERVICES[licenseType] ?? LICENSE_SERVICES.Other)
    .map((key) => optionForServiceKey(key))
    .filter((option): option is ProviderServiceOption => Boolean(option));
}

export function catalogFromApplication(application: ProviderApplication): {services: Service[]; provider: ProviderProfile} | null {
  if (application.status !== "approved") return null;
  const area = application.neighborhoods[0] ?? "Miami-Dade";
  const mapped = servicesForLicense(application.licenseType);
  if (!mapped.length) return null;

  const price = rateFromAsk(application.rateAsk, mapped[0]?.defaultPrice ?? 150);
  const services = mapped.map((option) => {
    const mock = mockServices.find((service) => service.id === option.key);
    return {
      id: liveServiceId(application.id, option.key),
      name: option.name,
      providerId: application.id,
      provider: application.fullName,
      category: option.category,
      mode: application.mobileAtHome ? "At home" : (mock?.mode ?? "At home"),
      area,
      price,
      standardPrice: price,
      duration: option.duration,
      rating: 0,
      reviews: 0,
      next: "Request with Atlas",
      description: `${application.fullName}, ${application.licenseType} (${application.licenseNumber}), serving ${application.neighborhoods.join(", ")}. Rate ask ${application.rateAsk}. Florida license number is self-reported — Salu has not verified credentials.`,
      clinical: mock?.clinical,
      lawful: mock?.lawful,
      source: "application" as const,
    } satisfies Service;
  });

  const first = services[0];
  if (!first) return null;

  return {
    services,
    provider: {
      id: application.id,
      name: application.fullName,
      initials: initialsFor(application.fullName),
      credential: `${application.licenseType} · ${application.licenseNumber} · self-reported`,
      focuses: mapped.map((option) => option.name),
      funFact: application.mobileAtHome ? "Mobile / at-home" : "In-clinic only",
      years: 0,
      area,
      rating: 0,
      reviews: 0,
      next: "Request with Atlas",
      serviceId: first.id,
      source: "application",
    },
  };
}
