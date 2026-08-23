import {services} from "../domain/mock-data";
import {findCatalogService} from "../bookings/catalog";
import type {Booking} from "../domain/types";

export const DEFAULT_COMMISSION_RATE = 20;

export type CatalogPractice = {
  id: string;
  name: string;
  commissionRate: number;
};

export function catalogPractices(): CatalogPractice[] {
  const seen = new Map<string, CatalogPractice>();
  for (const service of services) {
    if (seen.has(service.providerId)) continue;
    seen.set(service.providerId, {
      id: service.providerId,
      name: service.provider,
      commissionRate: DEFAULT_COMMISSION_RATE,
    });
  }
  return [...seen.values()];
}

export function findCatalogPractice(idOrName: string): CatalogPractice | null {
  const needle = idOrName.trim().toLowerCase();
  if (!needle) return null;
  return catalogPractices().find((practice) => {
    return practice.id.toLowerCase() === needle || practice.name.toLowerCase() === needle;
  }) ?? null;
}

export function bookingGrossCredits(booking: Pick<Booking, "creditsCharged" | "serviceId">): number {
  if (booking.creditsCharged > 0) return booking.creditsCharged;
  return findCatalogService(booking.serviceId)?.standardPrice ?? 0;
}

export function splitMarketplaceAmount(input: {
  grossCredits: number;
  commissionRate?: number;
}): {grossAmount: number; commissionAmount: number; netPayout: number; rate: number} {
  const rate = input.commissionRate ?? DEFAULT_COMMISSION_RATE;
  const grossAmount = Math.max(0, Math.round(input.grossCredits));
  const commissionAmount = Math.round(grossAmount * (rate / 100));
  return {
    grossAmount,
    commissionAmount,
    netPayout: Math.max(0, grossAmount - commissionAmount),
    rate,
  };
}

export function creditsToUsdCents(credits: number): number {
  return Math.max(0, Math.round(credits * 100));
}
