import {packages, services, topProviders} from "../domain/mock-data";
import {creditsForService, findCatalogService} from "../bookings/catalog";
import {
  assignMemberBooking,
  BookingError,
  createMemberBooking,
  createScheduledMemberBooking,
  listMemberBookings,
  toUiBooking,
  type UiBooking,
} from "../bookings/service";
import {parseLiveServiceId} from "../providers/catalog";
import {schedulingProviderId} from "../scheduling/slots";
import type {Booking, Member} from "../domain/types";
import {expandServiceSlotTargets, realWindowsForService, toServiceMatch} from "./availability";
import type {AtlasEntitlement, AtlasServiceMatch, AtlasToolName, AtlasWindow} from "./types";

export type DiscoverArgs = {query?: string; category?: string; limit?: number};
export type AvailabilityArgs = {serviceId: string};
export type CreateBookingArgs = {
  serviceId: string;
  date: string;
  mode?: string;
  packageName?: string;
  packageItem?: string;
  /** Provider account id from a check_availability window. When set with startISO, locks that exact slot. */
  providerId?: string;
  /** Exact slot start (ISO 8601) from a check_availability window. Without providerId, Atlas auto-assigns a free provider. */
  startISO?: string;
  /** Business organization id from context.orgs. Charges the org's credit wallet instead of the member's. */
  orgId?: string;
  /** Name of the person receiving the service (resident, guest, employee). */
  recipientName?: string;
  /** Room or suite for the recipient, e.g. "Room 214". */
  recipientRoom?: string;
  /** Group order size: books the slot quantity times (integer 1–10, default 1). */
  quantity?: number;
};

export type ToolContext = {
  member?: Member | null;
  entitlements?: AtlasEntitlement[];
  planId?: string;
  enforceCredits: boolean;
  /** Active business organizations the member can order for, from getMemberOrgs. */
  orgs?: Array<{id: string; name: string; role: "admin" | "staff"}>;
  /** Weekly training summary from connected health apps, when the member linked one. */
  healthSummary?: import("../health/service").WeeklyHealthSummary | null;
};

export type DiscoverResult = {matches: AtlasServiceMatch[]};
export type AvailabilityResult = {windows: AtlasWindow[]; service: AtlasServiceMatch | null; note?: string};
export type CreateBookingResult = {
  booking: UiBooking;
  source: "demo" | "server";
  creditsApplied: boolean;
  availableCredits?: number;
  bookings?: UiBooking[];
  /** Present for business group orders: how many bookings were placed. */
  groupOrder?: {count: number};
};

export const ATLAS_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "discover_services",
      description: "Find Salu marketplace services from the Miami catalog. Never invent services.",
      parameters: {
        type: "object",
        properties: {
          query: {type: "string", description: "Member wording, service name, or provider name."},
          category: {type: "string", description: "Optional catalog category such as Recovery."},
          limit: {type: "integer", description: "Maximum matches to return."},
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "check_availability",
      description: "Check REAL provider availability for a catalog service. Returns open slots from the live scheduling engine (provider, providerId, startISO/endISO, label) for the next 14 days. An empty windows list means nothing is open — never invent times.",
      parameters: {
        type: "object",
        properties: {
          serviceId: {type: "string", description: "Catalog service id such as deep-tissue."},
        },
        required: ["serviceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_booking",
      description: "Create a member reservation through the booking service. Pass providerId + startISO from a check_availability window to lock that exact slot (409 if it was just taken). Pass startISO without providerId and Atlas auto-assigns a free provider. Without startISO it books by display date (legacy/demo path). For business accounts: pass orgId (from context) plus recipientName/recipientRoom, and quantity for group orders like '4 massages for our residents'.",
      parameters: {
        type: "object",
        properties: {
          serviceId: {type: "string"},
          date: {type: "string", description: "Display window such as the label from check_availability."},
          mode: {type: "string"},
          packageName: {type: "string"},
          packageItem: {type: "string"},
          providerId: {type: "string", description: "Provider account id from a check_availability window."},
          startISO: {type: "string", description: "Exact slot start (ISO 8601) from a check_availability window."},
          orgId: {type: "string", description: "Business organization id from the member's context. Charges the organization's credit wallet."},
          recipientName: {type: "string", description: "Name of the person receiving the service (resident, guest, employee)."},
          recipientRoom: {type: "string", description: "Room or suite for the recipient, e.g. 'Room 214'."},
          quantity: {type: "integer", description: "Group order size: books the slot this many times (1-10, default 1)."},
        },
        required: ["serviceId", "date"],
      },
    },
  },
];

const SERVICE_ALIASES: [RegExp, string][] = [
  [/deep tissue/i, "deep-tissue"],
  [/sports massage/i, "sports-massage"],
  [/lymphatic/i, "lymphatic-massage"],
  [/facial workout/i, "facial-workout"],
  [/assisted stretch|stretching|\bmobility\b/i, "stretch"],
  [/blood test|blood draw|\blabs?\b/i, "blood-draw"],
  [/dietitian|nutrition|protein|meal plan/i, "dietitian"],
  [/personal train/i, "training"],
  [/pilates/i, "pilates"],
  [/physical therap|\bpt assessment\b/i, "pt"],
  [/whiten/i, "whitening"],
  [/\bnad\+?\b/i, "nad"],
  [/\biv\b|iv drip/i, "iv"],
  [/acupunct/i, "acupuncture"],
  [/dexa|body.composition/i, "dexa"],
  [/recovery (studio|circuit)|stillpoint/i, "recovery"],
  [/dermatolog/i, "derm"],
  [/house call|primary.care/i, "house-call"],
  [/sleep.test|sleep test/i, "sleep"],
  [/\bfacial\b/i, "facial"],
  [/massage|sore|tight|knot/i, "deep-tissue"],
];

export function resolveServiceId(prompt: string): string | null {
  const lower = prompt.toLowerCase();
  const named = services
    .filter((service) => lower.includes(service.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (named) return named.id;

  const provider = topProviders.find((entry) => lower.includes(entry.name.toLowerCase()));
  if (provider) return provider.serviceId;

  for (const [pattern, id] of SERVICE_ALIASES) {
    if (pattern.test(prompt)) return id;
  }
  return null;
}

export function discoverServices(args: DiscoverArgs): DiscoverResult {
  const limit = Math.min(Math.max(args.limit ?? 3, 1), 6);
  const query = (args.query ?? "").trim().toLowerCase();
  const category = (args.category ?? "").trim().toLowerCase();

  const resolved = query ? resolveServiceId(query) : null;
  let list = services.filter((service) => {
    if (category && service.category.toLowerCase() !== category) return false;
    if (!query) return true;
    if (resolved && service.id === resolved) return true;
    const haystack = `${service.name} ${service.provider} ${service.category} ${service.area} ${service.description}`.toLowerCase();
    return query.split(/\s+/).every((part) => haystack.includes(part) || haystack.includes(part.replace(/s$/, "")));
  });

  if (resolved && !list.some((service) => service.id === resolved)) {
    const hit = findCatalogService(resolved);
    if (hit) list = [hit, ...list];
  }
  if (!list.length && query) {
    const fallbackId = resolveServiceId(query);
    const fallback = fallbackId ? findCatalogService(fallbackId) : null;
    list = fallback ? [fallback] : services.slice(0, limit);
  }
  if (!list.length) list = services.slice(0, limit);

  return {
    matches: list
      .slice(0, limit)
      .map((service) => toServiceMatch(service.id))
      .filter((service): service is AtlasServiceMatch => Boolean(service)),
  };
}

export async function checkAvailability(args: AvailabilityArgs): Promise<AvailabilityResult> {
  const serviceId = args.serviceId.trim();
  const service = toServiceMatch(serviceId);
  const windows = service ? await realWindowsForService(serviceId) : [];
  return {
    service,
    windows,
    note: service && !windows.length
      ? `No open provider slots for ${service.name} in the next 14 days. Real provider calendars were checked — nothing was invented.`
      : undefined,
  };
}

export function packageForService(
  serviceName: string,
  entitlements: AtlasEntitlement[] = [],
): {packageName: string; packageItem: string} | undefined {
  for (const pack of entitlements) {
    const item = pack.items.find((entry) => entry.label === serviceName && entry.remaining > 0);
    if (item) return {packageName: pack.name, packageItem: item.label};
  }
  const catalogPack = packages.find((pack) =>
    entitlements.some((entry) => entry.name === pack.name) &&
    pack.items.some((item) => item.label === serviceName),
  );
  const catalogItem = catalogPack?.items.find((item) => item.label === serviceName);
  if (catalogPack && catalogItem) return {packageName: catalogPack.name, packageItem: catalogItem.label};
  return undefined;
}

function demoBooking(args: CreateBookingArgs, planId: string, pack?: {packageName: string; packageItem: string}): UiBooking {
  const service = findCatalogService(args.serviceId);
  if (!service) throw new Error("That service is not on the Salu menu.");
  return {
    id: `b_atlas_${crypto.randomUUID()}`,
    serviceId: service.id,
    serviceName: service.name,
    provider: service.provider,
    date: args.date,
    mode: args.mode || `${service.mode} · ${service.area}`,
    credits: pack ? 0 : creditsForService(service.id, planId) ?? service.standardPrice,
    status: "Upcoming",
    packageName: pack?.packageName,
    packageItem: pack?.packageItem,
  };
}

function sameServiceKey(a: string, b: string): boolean {
  if (a === b) return true;
  const keyA = parseLiveServiceId(a)?.serviceKey ?? a;
  const keyB = parseLiveServiceId(b)?.serviceKey ?? b;
  return keyA === keyB;
}

type BusinessServiceLike = {
  requireOrgRole(memberId: string, orgId: string, roles?: Array<"admin" | "staff">): Promise<unknown>;
};

async function loadBusinessService(): Promise<BusinessServiceLike> {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: ../business/service is being built in parallel; this resolves once it lands.
  const mod = await import("../business/service");
  return mod as unknown as BusinessServiceLike;
}

type OrgBookingFields = {
  orgId: string;
  recipientName?: string;
  recipientRoom?: string;
};

type OrgPlacedBooking = {
  booking: Booking;
  provider: {id: string; name: string};
  creditsApplied: boolean;
  availableCredits: number;
};

async function createOrgBooking(
  args: CreateBookingArgs,
  context: ToolContext,
  orgId: string,
  quantity: number,
): Promise<CreateBookingResult> {
  const member = context.member;
  if (!member) {
    throw new Error("Sign in with your business account to order for your organization.");
  }
  let business: BusinessServiceLike;
  try {
    business = await loadBusinessService();
  } catch {
    throw new Error("Business ordering is unavailable right now. Try again in a bit.");
  }
  // BusinessError (404 no membership, 403 wrong role or inactive org) surfaces to the caller.
  await business.requireOrgRole(member.id, orgId);

  const startISO = args.startISO?.trim() || undefined;
  const providerId = args.providerId?.trim() || undefined;
  const mode = (args.mode ?? "").trim() || undefined;

  const results: OrgPlacedBooking[] = [];
  for (let i = 0; i < quantity; i += 1) {
    const fields: OrgBookingFields = {
      orgId,
      recipientName: args.recipientName?.trim() || (quantity > 1 ? `Guest ${i + 1}` : undefined),
      recipientRoom: args.recipientRoom?.trim() || undefined,
    };
    try {
      if (providerId && startISO) {
        const startMs = Date.parse(startISO);
        if (!Number.isFinite(startMs)) throw new Error("Choose a time for this reservation.");
        const targets = await expandServiceSlotTargets(args.serviceId);
        const accountId = schedulingProviderId(providerId);
        const target = targets.find((entry) => entry.providerId === accountId);
        if (!target) {
          throw new BookingError("That provider is not offering this service right now.", 404);
        }
        const scheduled = await createScheduledMemberBooking({
          member,
          serviceId: target.serviceId,
          mode,
          providerId: accountId,
          slotStart: startISO,
          enforceCredits: context.enforceCredits,
          ...fields,
        } as Parameters<typeof createScheduledMemberBooking>[0] & OrgBookingFields);
        results.push(scheduled);
      } else {
        if (!startISO) throw new Error("Choose a time for this reservation.");
        const live = parseLiveServiceId(args.serviceId);
        const targets = await expandServiceSlotTargets(args.serviceId);
        const engineServiceId = live ? args.serviceId : targets[0]?.serviceId;
        if (!engineServiceId) {
          throw new BookingError("No provider is free at that time. Pick another slot.", 409);
        }
        const assigned = await assignMemberBooking({
          member,
          serviceId: engineServiceId,
          startISO,
          mode,
          enforceCredits: context.enforceCredits,
          ...fields,
        } as Parameters<typeof assignMemberBooking>[0] & OrgBookingFields);
        const billing = await import("../payments/ledger").then((mod) => mod.getMemberBilling(member));
        results.push({
          booking: assigned.booking,
          provider: assigned.provider,
          creditsApplied: false,
          availableCredits: billing.wallet.availableCredits,
        });
      }
    } catch (error) {
      const done = results.length;
      throw new Error(
        `Booked ${done} of ${quantity} for your organization before hitting an issue: ${
          error instanceof Error ? error.message : "That step failed."
        }`,
      );
    }
  }

  const bookings = results.map((result) => ({...toUiBooking(result.booking), provider: result.provider.name}));
  const last = results[results.length - 1];
  return {
    booking: bookings[0]!,
    source: "server",
    creditsApplied: last?.creditsApplied ?? false,
    availableCredits: last?.availableCredits,
    bookings,
    groupOrder: quantity > 1 ? {count: quantity} : undefined,
  };
}

export async function createBooking(args: CreateBookingArgs, context: ToolContext): Promise<CreateBookingResult> {
  const service = findCatalogService(args.serviceId);
  if (!service) throw new Error("That service is not on the Salu menu.");
  const orgId = args.orgId?.trim() || undefined;
  const quantity = args.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new Error("Quantity must be a whole number between 1 and 10.");
  }
  if (orgId) {
    return createOrgBooking(args, context, orgId, quantity);
  }
  const pack = args.packageName
    ? {packageName: args.packageName, packageItem: args.packageItem ?? service.name}
    : packageForService(service.name, context.entitlements);
  const startISO = args.startISO?.trim() || undefined;
  const providerId = args.providerId?.trim() || undefined;
  const mode = (args.mode ?? `${service.mode} · ${service.area}`).trim();

  // Real scheduling-engine path: lock an exact free slot for a signed-in member.
  if (context.member && startISO) {
    const member = context.member;
    const startMs = Date.parse(startISO);
    if (!Number.isFinite(startMs)) throw new Error("Choose a time for this reservation.");

    const existing = await listMemberBookings(member.id);
    const duplicate = existing.find((row) =>
      row.startsAt === startISO &&
      sameServiceKey(row.serviceId, args.serviceId) &&
      row.status !== "cancelled" &&
      row.status !== "completed",
    );
    if (duplicate) {
      return {
        booking: toUiBooking(duplicate),
        source: "server",
        creditsApplied: false,
        availableCredits: 0,
        bookings: existing.map(toUiBooking),
      };
    }

    const targets = await expandServiceSlotTargets(args.serviceId);
    let scheduled: {
      booking: Booking;
      provider: {id: string; name: string};
      creditsApplied: boolean;
      availableCredits: number;
    };
    if (providerId) {
      const accountId = schedulingProviderId(providerId);
      const target = targets.find((entry) => entry.providerId === accountId);
      if (!target) {
        throw new BookingError("That provider is not offering this service right now.", 404);
      }
      const result = await createScheduledMemberBooking({
        member,
        serviceId: target.serviceId,
        mode,
        providerId: accountId,
        slotStart: startISO,
        packageName: pack?.packageName,
        packageItem: pack?.packageItem,
        enforceCredits: context.enforceCredits,
      });
      scheduled = result;
    } else {
      const live = parseLiveServiceId(args.serviceId);
      const engineServiceId = live ? args.serviceId : targets[0]?.serviceId;
      if (!engineServiceId) {
        throw new BookingError("No provider is free at that time. Pick another slot.", 409);
      }
      const assigned = await assignMemberBooking({
        member,
        serviceId: engineServiceId,
        startISO,
        mode,
        enforceCredits: context.enforceCredits,
      });
      const billing = await import("../payments/ledger").then((mod) => mod.getMemberBilling(member));
      scheduled = {
        booking: assigned.booking,
        provider: assigned.provider,
        creditsApplied: false,
        availableCredits: billing.wallet.availableCredits,
      };
    }

    const bookings = await listMemberBookings(member.id);
    return {
      booking: {...toUiBooking(scheduled.booking), provider: scheduled.provider.name},
      source: "server",
      creditsApplied: scheduled.creditsApplied,
      availableCredits: scheduled.availableCredits,
      bookings: bookings.map(toUiBooking),
    };
  }

  let date = args.date.trim();
  if (!date && startISO) {
    const windows = await realWindowsForService(args.serviceId);
    date = windows.find((window) => window.startISO === startISO)?.label ?? "";
  }
  if (!date) throw new Error("Choose a time for this reservation.");

  if (context.member) {
    const existing = await listMemberBookings(context.member.id);
    const duplicate = existing.find((row) =>
      row.serviceId === service.id &&
      row.date === date &&
      row.status !== "cancelled" &&
      row.status !== "completed",
    );
    if (duplicate) {
      return {
        booking: toUiBooking(duplicate),
        source: "server",
        creditsApplied: false,
        availableCredits: 0,
        bookings: existing.map(toUiBooking),
      };
    }
    const result = await createMemberBooking({
      member: context.member,
      serviceId: service.id,
      date,
      mode,
      packageName: pack?.packageName,
      packageItem: pack?.packageItem,
      enforceCredits: context.enforceCredits,
    });
    const bookings = await listMemberBookings(context.member.id);
    return {
      booking: toUiBooking(result.booking),
      source: "server",
      creditsApplied: result.creditsApplied,
      availableCredits: result.availableCredits,
      bookings: bookings.map(toUiBooking),
    };
  }

  return {
    booking: demoBooking({serviceId: service.id, date, mode}, context.planId ?? "member", pack),
    source: "demo",
    creditsApplied: false,
  };
}

export async function executeTool(
  name: AtlasToolName,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<unknown> {
  if (name === "discover_services") {
    return discoverServices({
      query: typeof args.query === "string" ? args.query : "",
      category: typeof args.category === "string" ? args.category : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
  }
  if (name === "check_availability") {
    return checkAvailability({serviceId: typeof args.serviceId === "string" ? args.serviceId : ""});
  }
  if (name === "create_booking") {
    return createBooking({
      serviceId: typeof args.serviceId === "string" ? args.serviceId : "",
      date: typeof args.date === "string" ? args.date : "",
      mode: typeof args.mode === "string" ? args.mode : undefined,
      packageName: typeof args.packageName === "string" ? args.packageName : undefined,
      packageItem: typeof args.packageItem === "string" ? args.packageItem : undefined,
      providerId: typeof args.providerId === "string" ? args.providerId : undefined,
      startISO: typeof args.startISO === "string" ? args.startISO : undefined,
      orgId: typeof args.orgId === "string" ? args.orgId : undefined,
      recipientName: typeof args.recipientName === "string" ? args.recipientName : undefined,
      recipientRoom: typeof args.recipientRoom === "string" ? args.recipientRoom : undefined,
      quantity: typeof args.quantity === "number" ? args.quantity : undefined,
    }, context);
  }
  throw new Error(`Unknown Atlas tool: ${name}`);
}
