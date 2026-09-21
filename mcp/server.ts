/**
 * Salu MCP server — "book with your own AI".
 *
 * Streamable HTTP MCP (plain JSON responses, no SSE). Mounted at POST /mcp by
 * worker/index.ts. Every tool acts as the token's member and only touches that
 * member's own bookings — member isolation is enforced by verifying ownership
 * before any read or write, never by trusting tool arguments.
 *
 * Auth: `Authorization: Bearer salu_<...>` member API tokens (db/tokens.ts),
 * booking scope only. No duplicated booking logic — all writes go through
 * bookings/service.ts.
 */
import type {Booking, Member} from "../domain/types";
import {BookingError} from "../bookings/service";
import {tokenHasScope, verifyMemberApiToken, type MemberApiToken} from "../db/tokens";

export type McpRuntimeEnv = Record<string, string | undefined>;

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "salu";
export const MCP_SERVER_VERSION = "1.0.0";

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitHits = new Map<string, number[]>();

/** Test hook: clear in-memory rate-limit state between tests. */
export function resetMcpRateLimits(): void {
  rateLimitHits.clear();
}

function checkRateLimit(tokenId: string): boolean {
  const now = Date.now();
  const hits = (rateLimitHits.get(tokenId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateLimitHits.set(tokenId, hits);
    return false;
  }
  hits.push(now);
  rateLimitHits.set(tokenId, hits);
  return true;
}

type VerifiedToken = {member: Member; token: MemberApiToken};

/** Injectable dependencies so tests can stub auth and booking/slot backends. */
export type McpToolDeps = {
  verifyToken?: (raw: string) => Promise<VerifiedToken | null>;
  searchProviders?: (args: {service?: string; location?: string}) => Promise<unknown>;
  checkAvailability?: (args: {provider_id: string; date_from: string; date_to: string}) => Promise<unknown>;
  bookAppointment?: (
    member: Member,
    args: {provider_id: string; slot_start: string; service_id: string; mode?: string},
  ) => Promise<{booking: Booking; provider?: {id: string; name: string}; availableCredits?: number}>;
  requestAnyProvider?: (
    member: Member,
    args: {service_id: string; datetime: string; mode?: string},
  ) => Promise<{booking: Booking; availableCredits?: number}>;
  listBookings?: (memberId: string) => Promise<Booking[]>;
  cancelBooking?: (
    member: Member,
    bookingId: string,
  ) => Promise<{booking: Booking; availableCredits?: number}>;
};

type JsonRpcId = string | number | null;
type JsonRpcRequest = {jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown};

function ok(id: JsonRpcId, result: unknown, status = 200): Response {
  return Response.json({jsonrpc: "2.0", id, result}, {status});
}

function err(id: JsonRpcId, code: number, message: string, status = 200, data?: unknown): Response {
  const error: Record<string, unknown> = {code, message};
  if (data !== undefined) error.data = data;
  return Response.json({jsonrpc: "2.0", id, error}, {status});
}

function textContent(text: string): Array<{type: "text"; text: string}> {
  return [{type: "text", text}];
}

function bookingSummary(booking: Booking): Record<string, unknown> {
  return {
    id: booking.id,
    service_id: booking.serviceId,
    service_name: booking.serviceName,
    provider: booking.provider,
    provider_id: booking.providerId ?? null,
    date: booking.date,
    starts_at: booking.startsAt ?? null,
    mode: booking.mode,
    status: booking.status,
    credits_charged: booking.creditsCharged,
    assignment: booking.assignment ?? null,
    booked_via: booking.source === "mcp" ? "ai_assistant" : "web",
  };
}

function bookingConfirmation(booking: Booking, providerName?: string): string {
  const provider = providerName ?? booking.provider;
  const when = booking.startsAt ? `${booking.date} (${booking.startsAt})` : booking.date;
  return `Confirmed: ${booking.serviceName} with ${provider} — ${when}, ${booking.mode}. ${booking.creditsCharged} Credits charged. Booking id ${booking.id}.`;
}

const TOOL_DEFINITIONS = [
  {
    name: "salu.search_providers",
    description: "Search Salu's approved Miami provider catalog, optionally filtered by service and location.",
    inputSchema: {
      type: "object",
      properties: {
        service: {type: "string", description: "Service name or id, e.g. 'Deep Tissue Massage'"},
        location: {type: "string", description: "Neighborhood or area, e.g. 'Brickell'"},
      },
      additionalProperties: false,
    },
  },
  {
    name: "salu.check_availability",
    description: "List free bookable slots for a provider between two ISO datetimes.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: {type: "string"},
        date_from: {type: "string", description: "ISO datetime, range start"},
        date_to: {type: "string", description: "ISO datetime, range end"},
      },
      required: ["provider_id", "date_from", "date_to"],
      additionalProperties: false,
    },
  },
  {
    name: "salu.book_appointment",
    description: "Book a concrete free slot with a specific provider. Charges the member's Credits.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: {type: "string"},
        slot_start: {type: "string", description: "ISO datetime of the slot start"},
        service_id: {type: "string"},
        mode: {type: "string", description: "Optional, e.g. 'At home'"},
      },
      required: ["provider_id", "slot_start", "service_id"],
      additionalProperties: false,
    },
  },
  {
    name: "salu.request_any_provider",
    description: "Request a service at a date/time without picking a provider — Salu matches one and it flows through the normal assignment pipeline. Charges the member's Credits.",
    inputSchema: {
      type: "object",
      properties: {
        service_id: {type: "string"},
        datetime: {type: "string", description: "ISO datetime"},
        mode: {type: "string", description: "Optional, defaults to 'At home'"},
      },
      required: ["service_id", "datetime"],
      additionalProperties: false,
    },
  },
  {
    name: "salu.list_bookings",
    description: "List the member's own bookings (upcoming and past).",
    inputSchema: {type: "object", properties: {}, additionalProperties: false},
  },
  {
    name: "salu.cancel_booking",
    description: "Cancel one of the member's own bookings and refund the Credits.",
    inputSchema: {
      type: "object",
      properties: {booking_id: {type: "string"}},
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
];

export function mcpToolNames(): string[] {
  return TOOL_DEFINITIONS.map((tool) => tool.name);
}

/* ------------------------------------------------------------------ */
/* Default (production) tool implementations — reuse, never duplicate. */
/* ------------------------------------------------------------------ */

async function defaultSearchProviders(
  args: {service?: string; location?: string},
  runtimeEnv: McpRuntimeEnv,
): Promise<unknown> {
  // Reuse the exact logic behind GET /api/providers/catalog.
  const {handleProvidersFetch} = await import("../providers/handlers");
  const res = await handleProvidersFetch(
    new Request("https://mcp.local/api/providers/catalog", {method: "GET"}),
    runtimeEnv,
  );
  const data = (await res.json()) as {providers?: Array<Record<string, unknown>>; services?: Array<Record<string, unknown>>};
  let services = data.services ?? [];
  let providers = data.providers ?? [];
  if (args.service) {
    const q = args.service.toLowerCase();
    services = services.filter((s) =>
      [s.name, s.id].some((v) => typeof v === "string" && v.toLowerCase().includes(q)),
    );
    const providerIds = new Set(services.map((s) => s.providerId ?? s.provider_id));
    providers = providers.filter((p) => providerIds.has(p.id));
  }
  if (args.location) {
    const q = args.location.toLowerCase();
    providers = providers.filter((p) =>
      [p.area, p.name].some((v) => typeof v === "string" && v.toLowerCase().includes(q)),
    );
  }
  return {providers, services};
}

async function defaultCheckAvailability(args: {
  provider_id: string;
  date_from: string;
  date_to: string;
}): Promise<unknown> {
  // Reuse the slot logic behind GET /api/providers/slots.
  const {handleProviderSlotsFetch} = await import("../providers/slots");
  const url = new URL("https://mcp.local/api/providers/slots");
  url.searchParams.set("providerId", args.provider_id);
  url.searchParams.set("from", args.date_from);
  url.searchParams.set("to", args.date_to);
  const res = await handleProviderSlotsFetch(new Request(url, {method: "GET"}));
  return res.json();
}

async function defaultBookAppointment(
  member: Member,
  args: {provider_id: string; slot_start: string; service_id: string; mode?: string},
): Promise<{booking: Booking; provider?: {id: string; name: string}; availableCredits?: number}> {
  const {createScheduledMemberBooking} = await import("../bookings/service");
  return createScheduledMemberBooking({
    member,
    serviceId: args.service_id,
    providerId: args.provider_id,
    slotStart: args.slot_start,
    mode: args.mode,
    enforceCredits: true,
    source: "mcp",
  });
}

async function defaultRequestAnyProvider(
  member: Member,
  args: {service_id: string; datetime: string; mode?: string},
): Promise<{booking: Booking; availableCredits?: number}> {
  const {createMemberBooking} = await import("../bookings/service");
  // No providerId: unassigned, flows into the existing assignment pipeline.
  return createMemberBooking({
    member,
    serviceId: args.service_id,
    date: args.datetime,
    mode: args.mode?.trim() || "At home",
    enforceCredits: true,
    source: "mcp",
  });
}

async function defaultListBookings(memberId: string): Promise<Booking[]> {
  const {listMemberBookings} = await import("../bookings/service");
  return listMemberBookings(memberId);
}

async function defaultCancelBooking(
  member: Member,
  bookingId: string,
): Promise<{booking: Booking; availableCredits?: number}> {
  const {cancelMemberBooking, listMemberBookings} = await import("../bookings/service");
  // Verify the booking belongs to the member BEFORE touching it.
  const mine = await listMemberBookings(member.id);
  if (!mine.some((booking) => booking.id === bookingId)) {
    throw new BookingError("That reservation is not on your calendar.", 404);
  }
  return cancelMemberBooking({member, bookingId});
}

/* ------------------------------------------------------------------ */
/* JSON-RPC dispatch                                                   */
/* ------------------------------------------------------------------ */

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function paramsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type McpToolResult = {
  content: Array<{type: "text"; text: string}>;
  structuredContent?: unknown;
};

async function callTool(
  name: string,
  params: Record<string, unknown>,
  auth: VerifiedToken,
  runtimeEnv: McpRuntimeEnv,
  deps: McpToolDeps,
): Promise<McpToolResult> {
  const searchProviders = deps.searchProviders ?? ((args) => defaultSearchProviders(args, runtimeEnv));
  const checkAvailability = deps.checkAvailability ?? defaultCheckAvailability;
  const bookAppointment = deps.bookAppointment ?? defaultBookAppointment;
  const requestAnyProvider = deps.requestAnyProvider ?? defaultRequestAnyProvider;
  const listBookings = deps.listBookings ?? defaultListBookings;
  const cancelBooking = deps.cancelBooking ?? defaultCancelBooking;

  switch (name) {
    case "salu.search_providers": {
      const result = await searchProviders({
        service: stringParam(params, "service"),
        location: stringParam(params, "location"),
      });
      const data = result as {providers?: unknown[]; services?: unknown[]};
      return {
        content: textContent(
          `Found ${(data.providers ?? []).length} providers and ${(data.services ?? []).length} services${params.service ? ` matching "${params.service}"` : ""}${params.location ? ` in ${params.location}` : ""}.`,
        ),
        structuredContent: result,
      };
    }
    case "salu.check_availability": {
      const provider_id = stringParam(params, "provider_id");
      const date_from = stringParam(params, "date_from");
      const date_to = stringParam(params, "date_to");
      if (!provider_id || !date_from || !date_to) throw new BookingError("provider_id, date_from and date_to are required.");
      if (!Number.isFinite(Date.parse(date_from)) || !Number.isFinite(Date.parse(date_to))) {
        throw new BookingError("date_from and date_to must be ISO datetimes.");
      }
      const result = await checkAvailability({provider_id, date_from, date_to});
      const slots = (result as {slots?: unknown[]}).slots ?? [];
      return {
        content: textContent(`Found ${slots.length} free slots for provider ${provider_id} between ${date_from} and ${date_to}.`),
        structuredContent: result,
      };
    }
    case "salu.book_appointment": {
      const provider_id = stringParam(params, "provider_id");
      const slot_start = stringParam(params, "slot_start");
      const service_id = stringParam(params, "service_id");
      if (!provider_id || !slot_start || !service_id) {
        throw new BookingError("provider_id, slot_start and service_id are required.");
      }
      const result = await bookAppointment(auth.member, {
        provider_id, slot_start, service_id, mode: stringParam(params, "mode"),
      });
      return {
        content: textContent(bookingConfirmation(result.booking, result.provider?.name)),
        structuredContent: {booking: bookingSummary(result.booking), provider: result.provider ?? null},
      };
    }
    case "salu.request_any_provider": {
      const service_id = stringParam(params, "service_id");
      const datetime = stringParam(params, "datetime");
      if (!service_id || !datetime) throw new BookingError("service_id and datetime are required.");
      if (!Number.isFinite(Date.parse(datetime))) throw new BookingError("datetime must be an ISO datetime.");
      const result = await requestAnyProvider(auth.member, {
        service_id, datetime, mode: stringParam(params, "mode"),
      });
      return {
        content: textContent(
          `${bookingConfirmation(result.booking)} Salu will match you with an available provider — this request is in the normal assignment pipeline.`,
        ),
        structuredContent: {booking: bookingSummary(result.booking)},
      };
    }
    case "salu.list_bookings": {
      const bookings = await listBookings(auth.member.id);
      const summaries = bookings.map(bookingSummary);
      const upcoming = summaries.filter((b) => b.status === "confirmed" || b.status === "held");
      return {
        content: textContent(
          upcoming.length
            ? `You have ${upcoming.length} upcoming booking${upcoming.length === 1 ? "" : "s"}: ${upcoming.map((b) => `${b.service_name} on ${b.date}`).join("; ")}.`
            : "You have no upcoming bookings.",
        ),
        structuredContent: {bookings: summaries},
      };
    }
    case "salu.cancel_booking": {
      const booking_id = stringParam(params, "booking_id");
      if (!booking_id) throw new BookingError("booking_id is required.");
      const result = await cancelBooking(auth.member, booking_id);
      const booking = result.booking;
      return {
        content: textContent(
          `Cancelled: ${booking.serviceName} on ${booking.date}. ${booking.creditsCharged} Credits were refunded to your wallet.`,
        ),
        structuredContent: {booking: bookingSummary(booking)},
      };
    }
    default:
      throw new BookingError(`Unknown tool: ${name}`, 404);
  }
}

/**
 * POST /mcp — Streamable HTTP MCP endpoint (plain JSON, no SSE).
 * `initialize` and `notifications/initialized` are public; everything else
 * requires a booking-scoped member bearer token.
 */
export async function handleMcpFetch(
  request: Request,
  runtimeEnv: McpRuntimeEnv = {},
  deps: McpToolDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {status: 405});
  }

  let body: JsonRpcRequest;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return err(null, -32600, "Invalid Request: expected a single JSON-RPC object.", 400);
    }
    body = parsed as JsonRpcRequest;
  } catch {
    return err(null, -32700, "Parse error: body is not valid JSON.", 400);
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return err((body.id ?? null) as JsonRpcId, -32600, "Invalid Request.", 400);
  }

  const id = (body.id ?? null) as JsonRpcId;
  const params = paramsObject(body.params);

  if (body.method === "initialize") {
    return ok(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {tools: {}},
      serverInfo: {name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION},
    });
  }

  if (body.method === "notifications/initialized") {
    return new Response(null, {status: 202});
  }

  if (body.method !== "tools/list" && body.method !== "tools/call") {
    return err(id, -32601, `Method not found: ${body.method}`);
  }

  // Auth: required for tools/list and tools/call.
  const raw = bearerToken(request);
  if (!raw) {
    return err(id, -32001, "Missing bearer token. Connect your AI assistant in the Salu dashboard to get one.", 401);
  }
  let auth: VerifiedToken | null;
  try {
    const verify = deps.verifyToken ?? verifyMemberApiToken;
    auth = await verify(raw);
  } catch {
    auth = null;
  }
  if (!auth || !tokenHasScope(auth.token, "booking")) {
    return err(id, -32001, "Invalid or revoked bearer token.", 401);
  }

  if (!checkRateLimit(auth.token.id)) {
    return err(id, -32000, "rate_limited: too many requests. Slow down and try again in a minute.", 429);
  }

  if (body.method === "tools/list") {
    return ok(id, {tools: TOOL_DEFINITIONS});
  }

  const toolName = params.name;
  if (typeof toolName !== "string" || !toolName) {
    return err(id, -32602, "Invalid params: tools/call requires a tool name.");
  }
  try {
    const toolResult = await callTool(toolName, paramsObject(params.arguments), auth, runtimeEnv, deps);
    return ok(id, toolResult);
  } catch (error) {
    if (error instanceof BookingError) {
      return err(id, -32000, error.message, 200, {status: error.status});
    }
    const message = error instanceof Error ? error.message : "The tool call failed.";
    return err(id, -32000, message);
  }
}
