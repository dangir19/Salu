import test from "node:test";
import assert from "node:assert/strict";
import {BookingError} from "../bookings/service.ts";
import {hashToken, newRawToken, tokenHasScope, type MemberApiToken} from "../db/tokens.ts";
import type {Booking, Member} from "../domain/types.ts";
import {handleMcpFetch, mcpToolNames, resetMcpRateLimits, type McpToolDeps} from "../mcp/server.ts";

const fakeMember = {
  id: "member_ava",
  email: "ava@joinsalu.com",
  displayName: "Ava Ruiz",
  householdId: "hh_ava",
  planId: "platinum",
} as Member;

const fakeTokenRecord: MemberApiToken = {
  id: "tok_test_1",
  memberId: fakeMember.id,
  tokenHash: "deadbeef",
  name: "Test assistant",
  scopes: "booking",
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
  revokedAt: null,
};

const OTHER_MEMBER_BOOKING_ID = "b_other_member";

function fakeBooking(partial: Partial<Booking> = {}): Booking {
  const now = new Date().toISOString();
  return {
    id: "b_mcp_1",
    memberId: fakeMember.id,
    serviceId: "deep-tissue",
    serviceName: "Deep Tissue Massage",
    provider: "Tide & Tone Recovery",
    providerId: "prov_app_1",
    date: "2026-09-25",
    startsAt: "2026-09-25T18:00:00.000Z",
    slotEnd: "2026-09-25T19:00:00.000Z",
    mode: "At home",
    status: "confirmed",
    creditsCharged: 120,
    source: "mcp",
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

const deps: McpToolDeps = {
  verifyToken: async (raw) =>
    raw === "salu_test_token" ? {member: fakeMember, token: fakeTokenRecord} : null,
  searchProviders: async () => ({providers: [{id: "p1", name: "Tide & Tone"}], services: []}),
  checkAvailability: async () => ({source: "server", slots: [{startISO: "2026-09-25T18:00:00.000Z"}]}),
  bookAppointment: async (member, args) => {
    assert.equal(member.id, fakeMember.id);
    return {
      booking: fakeBooking({serviceId: args.service_id, providerId: args.provider_id, startsAt: args.slot_start}),
      provider: {id: args.provider_id, name: "Tide & Tone Recovery"},
      availableCredits: 80,
    };
  },
  requestAnyProvider: async (member, args) => ({
    booking: fakeBooking({serviceId: args.service_id, date: args.datetime, providerId: undefined}),
    availableCredits: 80,
  }),
  listBookings: async (memberId) => {
    assert.equal(memberId, fakeMember.id);
    return [fakeBooking()];
  },
  cancelBooking: async (member, bookingId) => {
    if (bookingId !== "b_mcp_1") throw new BookingError("That reservation is not on your calendar.", 404);
    return {booking: fakeBooking({status: "cancelled"}), availableCredits: 200};
  },
};

type McpRpcResult = {
  protocolVersion?: string;
  capabilities?: {tools?: unknown};
  serverInfo?: {name?: string; version?: string};
  tools?: Array<{name: string; description: string; inputSchema: {type: string}}>;
  content?: Array<{type: string; text: string}>;
  structuredContent?: Record<string, unknown>;
};
type McpRpcJson = {result?: McpRpcResult; error?: {code: number; message: string; data?: unknown}};

async function rpc(body: unknown, bearer?: string): Promise<{status: number; json: McpRpcJson}> {
  const headers: Record<string, string> = {"Content-Type": "application/json"};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await handleMcpFetch(
    new Request("https://test.local/mcp", {method: "POST", headers, body: JSON.stringify(body)}),
    {},
    deps,
  );
  return {status: res.status, json: (await res.json()) as McpRpcJson};
}

type StructuredBooking = {
  id: string;
  service_name: string;
  provider: string;
  provider_id: string | null;
  date: string;
  booked_via: string;
};

function structuredOf(json: McpRpcJson): Record<string, unknown> {
  return (json.result?.structuredContent ?? {}) as Record<string, unknown>;
}

const AUTH = "salu_test_token";

test("initialize returns the protocol version and tool capabilities without auth", async () => {
  resetMcpRateLimits();
  const {status, json} = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "test", version: "1"}},
  });
  assert.equal(status, 200);
  assert.equal(json.result.protocolVersion, "2025-06-18");
  assert.deepEqual(json.result.capabilities, {tools: {}});
  assert.equal(json.result.serverInfo.name, "salu");
  assert.equal(json.result.serverInfo.version, "1.0.0");
});

test("notifications/initialized answers 202 with an empty body", async () => {
  const res = await handleMcpFetch(
    new Request("https://test.local/mcp", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized", params: {}}),
    }),
    {},
    deps,
  );
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("tools/list returns the six salu tools", async () => {
  resetMcpRateLimits();
  const {status, json} = await rpc({jsonrpc: "2.0", id: 2, method: "tools/list", params: {}}, AUTH);
  assert.equal(status, 200);
  const tools = json.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "salu.search_providers",
    "salu.check_availability",
    "salu.book_appointment",
    "salu.request_any_provider",
    "salu.list_bookings",
    "salu.cancel_booking",
  ]);
  assert.deepEqual(names, mcpToolNames());
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("tools/list without a bearer token is rejected", async () => {
  const {status, json} = await rpc({jsonrpc: "2.0", id: 3, method: "tools/list", params: {}});
  assert.equal(status, 401);
  assert.equal(json.error.code, -32001);
});

test("tools/call with an invalid bearer token is rejected", async () => {
  const {status, json} = await rpc(
    {jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "salu.list_bookings", arguments: {}}},
    "salu_fake_token",
  );
  assert.equal(status, 401);
  assert.equal(json.error.code, -32001);
});

test("tools/call books against stubbed availability with a confirmation", async () => {
  resetMcpRateLimits();
  const {status, json} = await rpc(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "salu.book_appointment",
        arguments: {
          provider_id: "prov_app_1",
          slot_start: "2026-09-25T18:00:00.000Z",
          service_id: "deep-tissue",
        },
      },
    },
    AUTH,
  );
  assert.equal(status, 200);
  assert.ok(!json.error, `unexpected error: ${JSON.stringify(json.error)}`);
  const text = json.result?.content?.[0]?.text ?? "";
  assert.match(text, /Confirmed/);
  assert.match(text, /Deep Tissue Massage/);
  assert.match(text, /Tide & Tone Recovery/);
  assert.match(text, /120 Credits charged/);
  const booking = structuredOf(json).booking as StructuredBooking;
  assert.equal(booking.service_name, "Deep Tissue Massage");
  assert.equal(booking.booked_via, "ai_assistant");
});

test("tools/call salu.request_any_provider books without a provider", async () => {
  resetMcpRateLimits();
  const {status, json} = await rpc(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "salu.request_any_provider",
        arguments: {service_id: "deep-tissue", datetime: "2026-09-26T18:00:00.000Z"},
      },
    },
    AUTH,
  );
  assert.equal(status, 200);
  assert.ok(!json.error);
  assert.match(json.result?.content?.[0]?.text ?? "", /assignment pipeline/);
  assert.equal((structuredOf(json).booking as StructuredBooking).provider_id, null);
});

test("tools/call salu.list_bookings only surfaces the member's own bookings", async () => {
  resetMcpRateLimits();
  const {status, json} = await rpc(
    {jsonrpc: "2.0", id: 7, method: "tools/call", params: {name: "salu.list_bookings", arguments: {}}},
    AUTH,
  );
  assert.equal(status, 200);
  const bookings = (structuredOf(json).bookings ?? []) as Array<{id: string}>;
  assert.equal(bookings.length, 1);
  assert.ok(!bookings.some((booking) => booking.id === OTHER_MEMBER_BOOKING_ID));
});

test("tools/call salu.cancel_booking rejects another member's booking", async () => {
  resetMcpRateLimits();
  const {status, json} = await rpc(
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {name: "salu.cancel_booking", arguments: {booking_id: OTHER_MEMBER_BOOKING_ID}},
    },
    AUTH,
  );
  assert.equal(status, 200);
  assert.equal(json.error.code, -32000);
  assert.match(json.error?.message ?? "", /not on your calendar/);
});

test("tools/call maps BookingError to a JSON-RPC error with its message", async () => {
  resetMcpRateLimits();
  const {status, json} = await rpc(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {name: "salu.book_appointment", arguments: {provider_id: "p1"}},
    },
    AUTH,
  );
  assert.equal(status, 200);
  assert.equal(json.error.code, -32000);
  assert.match(json.error?.message ?? "", /slot_start and service_id are required/);
});

test("rate limiting kicks in after 60 requests per minute per token", async () => {
  resetMcpRateLimits();
  let last: {status: number; json: McpRpcJson} | null = null;
  for (let i = 0; i < 61; i++) {
    last = await rpc({jsonrpc: "2.0", id: 100 + i, method: "tools/list", params: {}}, AUTH);
  }
  assert.equal(last!.status, 429);
  assert.equal(last!.json.error.code, -32000);
  assert.match(last!.json.error?.message ?? "", /rate_limited/);
});

test("token hashing is deterministic SHA-256 hex and raw tokens are unique", async () => {
  const a = await hashToken("salu_abc");
  const b = await hashToken("salu_abc");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  const c = await hashToken("salu_abd");
  assert.notEqual(a, c);
  const t1 = newRawToken();
  const t2 = newRawToken();
  assert.match(t1, /^salu_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t1, t2);
  assert.ok(tokenHasScope(fakeTokenRecord, "booking"));
  assert.ok(!tokenHasScope({...fakeTokenRecord, scopes: "read"}, "booking"));
});
