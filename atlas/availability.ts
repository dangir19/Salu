import {topProviders} from "../domain/mock-data";
import {findCatalogService} from "../bookings/catalog";
import type {AtlasServiceMatch, AtlasWindow} from "./types";

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

export function pickWindow(
  windows: AtlasWindow[],
  prompt: string,
  options: {asap?: boolean; pendingDate?: string} = {},
): AtlasWindow | null {
  if (!windows.length) return null;
  if (options.pendingDate) {
    const pending = windows.find((window) => window.date === options.pendingDate);
    if (pending) return pending;
  }

  const lower = prompt.toLowerCase();
  const exact = windows.find((window) => lower.includes(window.date.toLowerCase()));
  if (exact) return exact;

  const dayMatch = lower.match(
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  );
  if (dayMatch) {
    const day = dayMatch[1];
    const byDay = windows.find((window) => new RegExp(`^${day}\\b`, "i").test(window.date));
    if (byDay) return byDay;
  }

  if (options.asap) {
    return windows.find((window) => /^today\b/i.test(window.date)) ?? windows[0] ?? null;
  }
  return null;
}
