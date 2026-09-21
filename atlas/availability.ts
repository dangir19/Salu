import {topProviders} from "../domain/mock-data";
import {durationMinutesForService, findCatalogService} from "../bookings/catalog";
import {parseLiveServiceId} from "../providers/catalog";
import {listApprovedCatalog} from "../providers/service";
import {getFreeSlots, nyDayOf, nyWeekdayOf, schedulingProviderId, type FreeSlot} from "../scheduling/slots";
import type {AtlasServiceMatch, AtlasWindow} from "./types";

const AVAILABILITY_DAYS = 14;
const MAX_TOOL_WINDOWS = 12;

export function toServiceMatch(serviceId: string): AtlasServiceMatch | null {
  const service = findCatalogService(serviceId);
  if (!service) return null;
  return {
    id: service.id,
    name: service.name,
    provider: service.provider,
    category: service.category,
    mode: service.mode,
    area: service.area,
    next: service.next,
    standardPrice: service.standardPrice,
    duration: service.duration,
  };
}

export function modeForService(serviceId: string, area?: string): string {
  const service = findCatalogService(serviceId);
  if (!service) return area ?? "";
  return `${service.mode} · ${area ?? service.area}`;
}

/**
 * @deprecated Legacy mock-catalog windows ("Today · 6:00 PM" style) kept only
 * for signature compatibility. The Atlas tool path uses realWindowsForService()
 * backed by the live scheduling engine. Do not use for new flows.
 */
export function windowsForService(serviceId: string): AtlasWindow[] {
  const service = findCatalogService(serviceId);
  if (!service) return [];

  const seen = new Set<string>();
  const windows: AtlasWindow[] = [];
  const push = (date: string, area: string) => {
    const mode = modeForService(serviceId, area);
    const key = `${date}|${mode}`;
    if (seen.has(key)) return;
    seen.add(key);
    windows.push({
      id: `${serviceId}:${windows.length}:${date.replace(/\s+/g, "-")}`,
      serviceId,
      date,
      mode,
      label: `${date} · ${mode}`,
    });
  };

  push(service.next, service.area);
  for (const provider of topProviders) {
    if (provider.serviceId !== serviceId) continue;
    push(provider.next, provider.area);
  }
  return windows;
}

export type ServiceSlotTarget = {providerId: string; serviceId: string};

/**
 * Expand a catalog or live service id into the provider+service targets the
 * scheduling engine understands. Mock catalog ids (e.g. "deep-tissue") map to
 * every approved provider's live service for the same service key.
 */
export async function expandServiceSlotTargets(serviceId: string): Promise<ServiceSlotTarget[]> {
  const catalog = await listApprovedCatalog();
  const live = parseLiveServiceId(serviceId);
  return catalog.services
    .filter((service) => live
      ? service.id === serviceId
      : parseLiveServiceId(service.id)?.serviceKey === serviceId)
    .map((service) => ({
      providerId: schedulingProviderId(service.providerId),
      serviceId: service.id,
    }));
}

export function freeSlotToWindow(serviceId: string, slot: FreeSlot): AtlasWindow {
  return {
    id: `slot:${slot.providerId}:${slot.startISO}`,
    serviceId,
    date: slot.label,
    mode: slot.mode,
    label: slot.label,
    providerId: slot.providerId,
    providerName: slot.providerName,
    slotServiceId: slot.serviceId,
    startISO: slot.startISO,
    endISO: slot.endISO,
  };
}

/**
 * Real availability: open slots from the scheduling engine (provider weekly
 * availability + date overrides + blocks + existing bookings, America/New_York,
 * approved providers only) for the next 14 days. Returns an empty list when
 * nothing is open — never fabricated windows.
 */
export async function realWindowsForService(
  serviceId: string,
  options: {days?: number; limit?: number} = {},
): Promise<AtlasWindow[]> {
  try {
    const service = findCatalogService(serviceId);
    if (!service) return [];
    const targets = await expandServiceSlotTargets(serviceId);
    if (!targets.length) return [];

    const durationMinutes = durationMinutesForService(serviceId);
    const now = new Date();
    const fromISO = now.toISOString();
    const toISO = new Date(now.getTime() + (options.days ?? AVAILABILITY_DAYS) * 24 * 60 * 60 * 1000).toISOString();
    const limit = options.limit ?? MAX_TOOL_WINDOWS;

    const windows: AtlasWindow[] = [];
    for (const target of targets) {
      if (windows.length >= limit) break;
      const slots = await getFreeSlots({
        providerId: target.providerId,
        serviceId: target.serviceId,
        fromISO,
        toISO,
        durationMinutes,
      });
      for (const slot of slots) {
        windows.push(freeSlotToWindow(serviceId, slot));
        if (windows.length >= limit) break;
      }
    }
    return windows
      .sort((a, b) => (a.startISO ?? "").localeCompare(b.startISO ?? ""))
      .slice(0, limit);
  } catch {
    // Scheduling reads are best-effort; an availability failure surfaces as
    // "nothing open" rather than breaking the Atlas turn.
    return [];
  }
}

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Match a natural-language day ("today", "tomorrow", "friday") against a real slot's startISO (NY calendar). */
function slotDayMatches(day: string, startISO: string): boolean {
  const startMs = Date.parse(startISO);
  if (!Number.isFinite(startMs)) return false;
  const slotDay = nyDayOf(startMs);
  if (day === "today") return slotDay === nyDayOf(Date.now());
  if (day === "tomorrow") return slotDay === nyDayOf(Date.now() + 24 * 60 * 60 * 1000);
  const index = WEEKDAY_INDEX[day];
  if (index === undefined) return false;
  for (let delta = 0; delta < 7; delta += 1) {
    const candidate = nyDayOf(Date.now() + delta * 24 * 60 * 60 * 1000);
    if (candidate === slotDay && nyWeekdayOf(candidate) === index) return true;
  }
  return false;
}

export function pickWindow(
  windows: AtlasWindow[],
  prompt: string,
  options: {asap?: boolean; pendingDate?: string} = {},
): AtlasWindow | null {
  if (!windows.length) return null;
  if (options.pendingDate) {
    const pending = windows.find((window) =>
      window.date === options.pendingDate ||
      window.label === options.pendingDate ||
      window.startISO === options.pendingDate,
    );
    if (pending) return pending;
  }

  const lower = prompt.toLowerCase();
  const exact = windows.find((window) =>
    lower.includes(window.date.toLowerCase()) ||
    (window.label && lower.includes(window.label.toLowerCase())) ||
    (window.startISO && lower.includes(window.startISO.toLowerCase())),
  );
  if (exact) return exact;

  const dayMatch = lower.match(
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  );
  if (dayMatch) {
    const day = dayMatch[1];
    const byDay = windows.find((window) =>
      window.startISO
        ? slotDayMatches(day, window.startISO)
        : new RegExp(`^${day}\\b`, "i").test(window.date),
    );
    if (byDay) return byDay;
  }

  if (options.asap) {
    return windows[0] ?? null;
  }
  return null;
}
