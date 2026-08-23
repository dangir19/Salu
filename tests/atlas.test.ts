import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {handleAtlasFetch} from "../atlas/handlers.ts";
import {isOpenAIReady, readAtlasEnv} from "../atlas/env.ts";
import {runAtlasTurn} from "../atlas/orchestrate.ts";
import {planAtlasTurn} from "../atlas/planner.ts";
import {windowsForService} from "../atlas/availability.ts";
import {resetBookingMemory, listMemberBookings} from "../bookings/service.ts";
import {applyCreditEntry, rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import type {Member} from "../domain/types.ts";

async function seedMember(id = "member_atlas"): Promise<Member> {
  resetMemberMemory();
  resetPaymentMemory();
  resetBookingMemory();
  return rememberMember({
    id,
    email: `${id}@joinsalu.com`,
    displayName: "Atlas Member",
    householdId: `hh_${id}`,
    planId: "platinum",
  });
}

async function fund(member: Member, credits = 400) {
  await applyCreditEntry({
    member,
    credits,
    kind: "contribution",
    label: "Test funding",
  });
}

test("catalog windows come from the Miami menu, not invented slots", () => {
  const windows = windowsForService("deep-tissue");
  assert.ok(windows.some((window) => window.date === "Today · 6:00 PM"));
  assert.ok(windows.every((window) => window.serviceId === "deep-tissue"));
  assert.equal(windowsForService("missing").length, 0);
});

test("emergencies refuse tools and never book", async () => {
  const member = await seedMember();
  await fund(member);
  const plan = planAtlasTurn({message: "I have chest pain, book a massage"});
  assert.equal(plan.safety, "emergency");
  assert.equal(plan.tools.length, 0);

  const turn = await runAtlasTurn({
    message: "I have chest pain, book a Deep Tissue Massage now",
    member,
    preferOpenAI: false,
  });
  assert.equal(turn.safety.kind, "emergency");
  assert.match(turn.text, /911/);
  assert.equal(turn.booking, null);
  assert.equal(turn.tools.length, 0);
  assert.equal((await listMemberBookings(member.id)).length, 0);
});

test("diagnosis language stays general wellness coordination", async () => {
  const turn = await runAtlasTurn({
    message: "Can you diagnose this and prescribe something?",
    preferOpenAI: false,
  });
  assert.equal(turn.safety.kind, "clinical_boundary");
  assert.match(turn.text, /does not diagnose|prescribe/i);
  assert.equal(turn.booking, null);
  assert.ok(!turn.tools.some((tool) => tool.name === "create_booking"));
});

test("discovers catalog services from member wording", async () => {
  const turn = await runAtlasTurn({
    message: "What massage options do you have in Miami?",
    preferOpenAI: false,
  });
  assert.ok(turn.tools.some((tool) => tool.name === "discover_services" && tool.ok));
  assert.ok(turn.matches.some((match) => match.id === "deep-tissue" || match.id === "sports-massage"));
  assert.equal(turn.booking, null);
});

test("books the first available Deep Tissue window through the booking service", async () => {
  const member = await seedMember();
  await fund(member, 400);

  const turn = await runAtlasTurn({
    message: "Get me a Deep Tissue Massage in the next hour",
    member,
    preferOpenAI: false,
    enforceCredits: true,
  });

  assert.ok(turn.booking);
  assert.equal(turn.source, "server");
  assert.equal(turn.booking?.serviceId, "deep-tissue");
  assert.equal(turn.booking?.status, "Upcoming");
  assert.match(turn.booking?.date ?? "", /Today/i);
  assert.match(turn.text, /Confirmed/);
  assert.equal(turn.appointmentsPath, "/appointments");
  assert.ok(turn.tools.some((tool) => tool.name === "create_booking" && tool.ok));
  assert.equal(turn.planner, "deterministic");

  const listed = await listMemberBookings(member.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, turn.booking?.id);
  assert.equal(listed[0]?.status, "confirmed");
});

test("asks for a window when the member names a service without a time", async () => {
  const member = await seedMember();
  const turn = await runAtlasTurn({
    message: "Book a sports massage",
    member,
    preferOpenAI: false,
  });
  assert.equal(turn.booking, null);
  assert.ok(turn.windows.length > 0);
  assert.ok(turn.pending?.serviceId === "sports-massage");
  assert.match(turn.text, /windows|time/i);
});

test("confirms a pending window without a live language model", async () => {
  const member = await seedMember();
  await fund(member, 400);
  const first = await runAtlasTurn({
    message: "Book a sports massage",
    member,
    preferOpenAI: false,
  });
  const confirm = await runAtlasTurn({
    message: "Yes, book it",
    member,
    pending: first.pending,
    history: [
      {role: "member", content: "Book a sports massage"},
      {role: "atlas", content: first.text},
    ],
    preferOpenAI: false,
    enforceCredits: true,
  });
  assert.ok(confirm.booking);
  assert.equal(confirm.booking?.serviceId, "sports-massage");
  assert.equal((await listMemberBookings(member.id)).length, 1);
});

test("demo mode still returns a persistable reservation without a session", async () => {
  const turn = await runAtlasTurn({
    message: "Get me a Deep Tissue Massage in the next hour",
    planId: "platinum",
    preferOpenAI: false,
  });
  assert.equal(turn.source, "demo");
  assert.ok(turn.booking);
  assert.equal(turn.booking?.serviceName, "Deep Tissue Massage");
  assert.equal(turn.booking?.credits, 120);
});

test("uses a package session when the client sends entitlements", async () => {
  const member = await seedMember();
  const turn = await runAtlasTurn({
    message: "Get me a Sports Massage in the next hour",
    member,
    entitlements: [{name: "Runner Recovery Pack", items: [{label: "Sports Massage", remaining: 2}]}],
    preferOpenAI: false,
    enforceCredits: true,
  });
  assert.ok(turn.booking);
  assert.equal(turn.booking?.credits, 0);
  assert.equal(turn.booking?.packageName, "Runner Recovery Pack");
});

test("Atlas HTTP API works without OpenAI or a session", async () => {
  const listed = await handleAtlasFetch(new Request("http://localhost/api/atlas"));
  assert.equal(listed.status, 200);
  const meta = await listed.json() as {planner: string; tools: string[]; openai: boolean};
  assert.equal(meta.planner, "deterministic");
  assert.equal(meta.openai, false);
  assert.deepEqual(meta.tools, ["discover_services", "check_availability", "create_booking"]);

  const created = await handleAtlasFetch(new Request("http://localhost/api/atlas", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({message: "Get me a Deep Tissue Massage in the next hour", planId: "platinum"}),
  }));
  assert.equal(created.status, 200);
  const body = await created.json() as {booking?: {serviceId: string}; source: string; planner: string};
  assert.equal(body.planner, "deterministic");
  assert.equal(body.source, "demo");
  assert.equal(body.booking?.serviceId, "deep-tissue");
});

test("OpenAI stays optional and unused without a key", () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(isOpenAIReady(readAtlasEnv()), false);
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});

test("mocked OpenAI tool calls book once through the real booking service", async () => {
  const member = await seedMember();
  await fund(member, 400);
  let completions = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    completions += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {messages: {role: string}[]};
    if (!body.messages.some((message) => message.role === "tool")) {
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_book",
              type: "function",
              function: {
                name: "create_booking",
                arguments: JSON.stringify({
                  serviceId: "deep-tissue",
                  date: "Today · 6:00 PM",
                  mode: "At home · Miami-Dade",
                }),
              },
            }],
          },
        }],
      });
    }
    return Response.json({
      choices: [{message: {role: "assistant", content: "Confirmed through the language-model planner."}}],
    });
  };

  const turn = await runAtlasTurn({
    message: "Book deep tissue today",
    member,
    preferOpenAI: true,
    env: {OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4o-mini"},
    fetchImpl,
    enforceCredits: true,
  });

  assert.equal(turn.planner, "openai");
  assert.equal(completions, 2);
  assert.ok(turn.booking);
  assert.equal(turn.booking?.serviceId, "deep-tissue");
  assert.equal((await listMemberBookings(member.id)).length, 1);
  assert.match(turn.text, /Confirmed/);
});
