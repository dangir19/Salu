import {services as mockServices, type ProviderProfile, type Service} from "../domain/mock-data";
import type {ProviderApplication} from "../domain/types";

export const PROVIDER_NEIGHBORHOODS = [
  "Brickell",
  "Miami Beach",
  "Miami-Dade",
  "Coral Gables",
  "Coconut Grove",
  "Wynwood",
  "Design District",
  "Midtown",
  "Key Biscayne",
  "Edgewater",
] as const;

export const PROVIDER_RATE_EXPECTATIONS = [
  "Under $100 / visit",
  "$100–150 / visit",
  "$150–200 / visit",
  "$200–300 / visit",
  "$300+ / visit",
] as const;

export type ProviderServiceOption = {
  key: string;
  name: string;
  category: "Recovery" | "Aesthetic" | "Clinical";
  duration: string;
  defaultPrice: number;
};

export const PROVIDER_SERVICE_OPTIONS: ProviderServiceOption[] = [
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

export function optionForServiceName(name: string): ProviderServiceOption | null {
  return PROVIDER_SERVICE_OPTIONS.find((option) => option.name === name || option.key === name) ?? null;
}

export function rateFromExpectation(text: string, fallback = 150): number {
  const match = text.replace(/,/g, "").match(/(\d{2,4})/);
  return match ? Number(match[1]) : fallback;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "S";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "S";
}

export function catalogFromApplication(application: ProviderApplication): {services: Service[]; provider: ProviderProfile} | null {
  if (application.status !== "approved") return null;
  const area = application.neighborhoods[0] ?? "Miami-Dade";
  const mapped = application.services
    .map((name) => optionForServiceName(name))
    .filter((option): option is ProviderServiceOption => Boolean(option));
  if (!mapped.length) return null;

  const price = rateFromExpectation(application.rateExpectation, mapped[0]?.defaultPrice ?? 150);
  const services = mapped.map((option) => {
    const mock = mockServices.find((service) => service.id === option.key);
    return {
      id: liveServiceId(application.id, option.key),
      name: option.name,
      providerId: application.id,
      provider: application.businessName,
      category: option.category,
      mode: mock?.mode ?? "At home",
      area,
      price,
      standardPrice: price,
      duration: option.duration,
      rating: 0,
      reviews: 0,
      next: "Request with Atlas",
      description: `Independent ${option.name.toLowerCase()} with ${application.businessName} across ${application.neighborhoods.join(", ")}. Typical visit ${application.rateExpectation}. License and insurance are self-attested — Salu has not completed credential verification.`,
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
      name: application.businessName,
      initials: initialsFor(application.businessName),
      credential: "Self-attested · pending verification",
      focuses: mapped.map((option) => option.name),
      funFact: application.neighborhoods.join(" · "),
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
