import type {ProviderAccount} from "../domain/types";
import {
  listAvailability,
  listOverrides,
} from "../db/scheduling";

export type FreeSlot = {
  providerId: string;
  providerName: string;
  serviceId: string;
  startISO: string;
  endISO: string;
  label: string;
  mode: string;
};

export type GetFreeSlotsInput = {
  providerId?: string;
  serviceId?: string;
  fromISO: string;
  toISO: string;
  durationMinutes: number;
};

const NY_TZ = "America/New_York";
const MAX_DAYS = 62;

type NyParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  offsetMinutes: number;
};

const nyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function nyParts(ms: number): NyParts {
  const values = Object.fromEntries(
    nyFormatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
  );
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const asUTC = Date.UTC(year, month - 1, day, hour, minute);
  return {year, month, day, hour, minute, offsetMinutes: Math.round((asUTC - ms) / 60000)};
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** NY calendar day (YYYY-MM-DD) for an instant. */
export function nyDayOf(ms: number): string {
  const parts = nyParts(ms);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Day of week 0=Sun..6=Sat for a NY calendar day. */
export function nyWeekdayOf(ymd: string): number {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Convert a NY calendar day + minutes-since-midnight to an instant. */
function nyLocalToMs(ymd: string, minutes: number): number {
  const [year, month, day] = ymd.split("-").map(Number);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i += 1) {
    const offset = nyParts(guess).offsetMinutes;
    const next = Date.UTC(year, month - 1, day, hour, minute) - offset * 60000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function isoWithOffset(ms: number): string {
  const parts = nyParts(ms);
  const sign = parts.offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(parts.offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:00${offset}`;
}

function addDays(ymd: string, delta: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

function slotLabel(startMs: number, endMs: number): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const start = nyParts(startMs);
  const end = nyParts(endMs);
  const time = (parts: NyParts) => {
    const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
    const meridiem = parts.hour < 12 ? "AM" : "PM";
    return `${hour12}:${pad(parts.minute)} ${meridiem}`;
  };
  return `${weekdays[nyWeekdayOf(nyDayOf(startMs))]} ${months[start.month - 1]} ${start.day} · ${time(start)} – ${time(end)}`;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Whole-day blocks from the provider workspace use free-text labels
 * ("Today · 4:00 PM", "Friday · 6:30 PM") or ISO dates from the new
 * availability editor. Resolve the blocked NY calendar day, if any.
 */
export function blockDateToYmd(raw: string, refMs: number): string | null {
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const lower = trimmed.toLowerCase();
  const today = nyDayOf(refMs);
  if (lower.startsWith("today")) return today;
  if (lower.startsWith("tomorrow")) return addDays(today, 1);
  const index = WEEKDAY_NAMES.findIndex((name) => lower.startsWith(name));
  if (index >= 0) {
    const delta = (index - nyWeekdayOf(today) + 7) % 7;
    return addDays(today, delta);
  }
  return null;
}

function stubAccount(accountId: string): ProviderAccount {
  return {
    id: accountId,
    email: "",
    displayName: "",
    practiceId: "",
    practiceName: "",
    status: "approved",
    serviceIds: [],
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * The approved catalog keys providers by application id, while scheduling
 * data is keyed by the provider account id (`prov_app_<applicationId>`).
 * Normalize either form to the account id so lookups line up.
 */
export function schedulingProviderId(providerId: string): string {
  return providerId.startsWith("prov_app_") ? providerId : `prov_app_${providerId}`;
}

type RosterProvider = {
  accountId: string;
  applicationId: string;
  name: string;
  serviceIds: string[];
};

function matchesProviderFilter(entry: RosterProvider, raw: string): boolean {
  const candidates = new Set([raw, schedulingProviderId(raw), raw.replace(/^prov_app_/, "")]);
  return candidates.has(entry.accountId) || candidates.has(entry.applicationId);
}

async function buildRoster(input: Pick<GetFreeSlotsInput, "providerId" | "serviceId">): Promise<RosterProvider[]> {
  const {listApprovedCatalog} = await import("../providers/service");
  const catalog = await listApprovedCatalog();
  let roster: RosterProvider[] = catalog.providers.map((provider) => ({
    accountId: schedulingProviderId(provider.id),
    applicationId: provider.id,
    name: provider.name,
    serviceIds: catalog.services.filter((service) => service.providerId === provider.id).map((service) => service.id),
  }));
  if (input.providerId) roster = roster.filter((entry) => matchesProviderFilter(entry, input.providerId!));
  if (input.serviceId) roster = roster.filter((entry) => entry.serviceIds.includes(input.serviceId!));
  return roster;
}

async function serviceMode(serviceId: string | undefined): Promise<string> {
  if (!serviceId) return "At home";
  try {
    const catalog = await import("../bookings/catalog");
    return catalog.findCatalogService(serviceId)?.mode ?? "At home";
  } catch {
    return "At home";
  }
}

type BusyInterval = {start: number; end: number};

function bookingToInterval(
  booking: {startsAt?: string; slotEnd?: string},
  fallbackDurationMinutes: number,
): BusyInterval | null {
  if (!booking.startsAt) return null;
  const start = Date.parse(booking.startsAt);
  if (!Number.isFinite(start)) return null;
  const end = booking.slotEnd ? Date.parse(booking.slotEnd) : NaN;
  return {
    start,
    end: Number.isFinite(end) ? end : start + fallbackDurationMinutes * 60000,
  };
}

function overlaps(a: BusyInterval, b: BusyInterval): boolean {
  return a.start < b.end && b.start < a.end;
}

export async function getFreeSlots(input: GetFreeSlotsInput): Promise<FreeSlot[]> {
  const durationMinutes = Math.max(15, Math.floor(input.durationMinutes) || 60);
  const fromMs = Date.parse(input.fromISO);
  const toMs = Date.parse(input.toISO);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

  const roster = await buildRoster(input);
  if (!roster.length) return [];

  const providerModule = await import("../provider/service");
  const bookingsModule = await import("../bookings/service");

  const slots: FreeSlot[] = [];
  for (const provider of roster) {
    const [windows, overrides] = await Promise.all([
      listAvailability(provider.accountId),
      listOverrides(provider.accountId),
    ]);
    let blocks: Array<{date: string}> = [];
    let activeBookings: Array<{startsAt?: string; slotEnd?: string}> = [];
    try {
      blocks = await providerModule.listProviderBlocks(stubAccount(provider.accountId));
      activeBookings = await bookingsModule.listScheduledBookingsForProvider(provider.accountId);
    } catch {
      // Treat scheduling reads as closed rather than failing the whole query.
    }

    const blockedDays = new Set<string>();
    for (const block of blocks) {
      const ymd = blockDateToYmd(block.date, fromMs);
      if (ymd) blockedDays.add(ymd);
    }
    const busy = activeBookings
      .map((booking) => bookingToInterval(booking, durationMinutes))
      .filter((interval): interval is BusyInterval => Boolean(interval));

    let day = nyDayOf(fromMs);
    const lastDay = nyDayOf(toMs);
    let guard = 0;
    while (day <= lastDay && guard < MAX_DAYS) {
      guard += 1;
      const current = day;
      day = addDays(day, 1);

      if (blockedDays.has(current)) continue;
      const weekday = nyWeekdayOf(current);
      let dayWindows = windows
        .filter((window) => window.dayOfWeek === weekday)
        .map((window) => ({start: window.startMinutes, end: window.endMinutes}));
      const override = overrides.find((entry) => entry.date === current);
      if (override) {
        if (override.isClosed) continue;
        if (override.startMinutes != null && override.endMinutes != null) {
          dayWindows = [{start: override.startMinutes, end: override.endMinutes}];
        }
      }
      if (!dayWindows.length) continue;

      const fallbackServiceId = input.serviceId ?? provider.serviceIds[0];
      const mode = await serviceMode(fallbackServiceId);
      for (const window of dayWindows) {
        for (let cursor = window.start; cursor + durationMinutes <= window.end; cursor += durationMinutes) {
          const startMs = nyLocalToMs(current, cursor);
          const endMs = startMs + durationMinutes * 60000;
          if (startMs < fromMs || startMs > toMs) continue;
          const candidate = {start: startMs, end: endMs};
          if (busy.some((interval) => overlaps(candidate, interval))) continue;
          slots.push({
            providerId: provider.accountId,
            providerName: provider.name,
            serviceId: fallbackServiceId ?? "",
            startISO: isoWithOffset(startMs),
            endISO: isoWithOffset(endMs),
            label: slotLabel(startMs, endMs),
            mode,
          });
        }
      }
    }
  }

  return slots.sort((a, b) => Date.parse(a.startISO) - Date.parse(b.startISO));
}
