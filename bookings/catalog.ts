import {packages, services} from "../domain/mock-data";
import {findLiveCatalogService} from "../providers/catalog";
import {planNameFromId, type PlanId} from "../payments/catalog";

export function findCatalogService(serviceId: string) {
  return services.find((service) => service.id === serviceId) ?? findLiveCatalogService(serviceId) ?? null;
}

export function findCatalogPackage(name: string) {
  return packages.find((pack) => pack.name === name) ?? null;
}

export function planDiscount(planId: string): number {
  const name = planNameFromId(planId as PlanId);
  if (name === "Platinum") return 0.2;
  if (name === "Gold") return 0.1;
  return 0;
}

export function creditsForService(serviceId: string, planId: string): number | null {
  const service = findCatalogService(serviceId);
  if (!service) return null;
  return Math.round(service.standardPrice * (1 - planDiscount(planId)));
}

/** Parse catalog durations like "60 min" into minutes; falls back to 60. */
export function durationMinutesForService(serviceId: string): number {
  const service = findCatalogService(serviceId);
  const match = service?.duration?.match(/(\d+)/);
  const minutes = match ? Number(match[1]) : NaN;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
}
