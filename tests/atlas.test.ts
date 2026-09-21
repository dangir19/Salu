import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {handleAtlasFetch} from "../atlas/handlers.ts";
import {isOpenAIReady, readAtlasEnv} from "../atlas/env.ts";
import {runAtlasTurn} from "../atlas/orchestrate.ts";
import {planAtlasTurn} from "../atlas/planner.ts";
import {pickWindow, realWindowsForService} from "../atlas/availability.ts";
import {
  checkAvailability,
  executeTool,
  type CreateBookingResult,
  type ToolContext,
} from "../atlas/tools.ts";
import {BookingError, resetBookingMemory, listMemberBookings} from "../bookings/service.ts";
import {resetSchedulingMemory, replaceWeeklyAvailability} from "../db/scheduling.ts";
import {resetPaymentMemory, applyCreditEntry, rememberMember} from "../payments/ledger.ts";
import {resetProviderMemory, submitApplication, updateApplicationStatus} from "../providers/service.ts";
import type {Member} from "../domain/types.ts";

async function seedMember(id = "member_atlas"): Promise<Member> {
  resetMemberMemory();
  resetPaymentMemory();
  resetBookingMemory();
  resetProviderMemory();
  resetSchedulingMemory();
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

/** Approved LMT provider with 9am–5pm availability every day. */
async function seedProvider(): Promise<{accountId: string}> {
  const application = await submitApplication({
    fullName: "Test Provider",
    email: "atlas-provider@joinsalu.com",
    licenseType: "LMT",
    licenseNumber: "MA123456",
    mobileAtHome: true,
    neighborhoods: ["Miami Beach"],
    rateAsk: "$150 / visit",
    insuranceAttested: true,
  });
  await updateApplicationStatus({id: application.id, status: "approved"});
  const accountId = `prov_app_${application.id}`;
  await replaceWeeklyAvailability(
    accountId,
    [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({dayOfWeek, startMinutes: 9 * 60, endMinutes: 17 * 60})),
  );
  return {accountId};
}

function memberContext(member: Member): ToolContext {
  return {member, enforceCredits: false};
}

test("check_availability returns real provider slots, never mock windows", async () => {
  await seedMember();
  const {accountId} = await seedProvider();

  const windows = await realWindowsForService("deep-tissue");
  assert.ok(windows.length > 0, "expected real slots");
  assert.ok(windows.length <= 12, "tool windows are capped");
  const first = windows[0]!;
  assert.equal(first.providerId, accountId);
  assert.ok(first.providerName);
  assert.equal(first.slotServiceId?.endsWith("deep-tissue"), true);
  assert.ok(first.startISO);
  assert.ok(first.endISO);
  assert.ok(Date.parse(first.endISO!) > Date.parse(first.startISO!));
  assert.ok(first.label.length > 0);
  for (let i = 1; i < windows.length; i += 1) {
    assert.ok((windows[i - 1]!.startISO ?? "") <= (windows[i]!.startISO ?? ""), "windows are sorted");
  }

  const availability = await checkAvailability({serviceId: "deep-tissue"});
  assert.equal(availability.service?.id, "deep-tissue");
  assert.ok(availability.windows.length > 0);
  assert.equal(availability.note, undefined);
});

test("check_availability returns an empty list with a clear note when nothing is open", async () => {
  await seedMember();
  const availability = await checkAvailability({serviceId: "deep-tissue"});
  assert.equal(availability.windows.length, 0);
  assert.match(availability.note ?? "", /No open provider slots/);
  assert.equal(availability.service?.id, "deep-tissue");

  const missing = await checkAvailability({serviceId: "missing"});
  assert.equal(missing.windows.length, 0);
  assert.equal(missing.service, null);
});

test("pickWindow matches real slots by pending label and weekday", async () => {
  await seedMember();
  await seedProvider();
  const windows = await realWindowsForService("deep-tissue");
  assert.ok(windows.length > 0);

  const pending = pickWindow(windows, "anything", {pendingDate: windows[2]!.label});
  assert.equal(pending?.startISO, windows[2]!.startISO);

  const weekday = new Date(windows[4]!.startISO!).toLocaleDateString("en-US", {weekday: "long", timeZone: "America/New_York"});
  const byDay = pickWindow(windows, `book deep tissue ${weekday.toLowerCase()}`);
  assert.ok(byDay);
  assert.equal(
    new Date(byDay.startISO!).toLocaleDateString("en-US", {weekday: "long", timeZone: "America/New_York"}),
    weekday,
  );
});

test("emergencies refuse tools and never book", async () => {
  const member = await seedMember();
  await fund(member);
  const plan = await planAtlasTurn({message: "I have chest pain, book a massage"});
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

test("books a real slot end to end for a signed-in member", async () => {
  const member = await seedMember();
  await fund(member, 400);
  await seedProvider();

  const turn = await runAtlasTurn({
    message: "Get me a Deep Tissue Massage in the next hour",
    member,
    preferOpenAI: false,
    enforceCredits: true,
  });

  assert.ok(turn.booking);
  assert.equal(turn.source, "server");
  assert.ok(turn.booking?.serviceId.endsWith("deep-tissue"), `serviceId was ${turn.booking?.serviceId}`);
  assert.equal(turn.booking?.status, "Upcoming");
  assert.match(turn.text, /Confirmed/);
  assert.equal(turn.appointmentsPath, "/appointments");
  assert.ok(turn.tools.some((tool) => tool.name === "create_booking" && tool.ok));
  assert.equal(turn.planner, "deterministic");

  const listed = await listMemberBookings(member.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, turn.booking?.id);
  assert.equal(listed[0]?.status, "confirmed");
  assert.ok(listed[0]?.startsAt, "real slot start is persisted");
});

test("asks for a window when the member names a service without a time", async () => {
  const member = await seedMember();
  await seedProvider();
  const turn = await runAtlasTurn({
    message: "Book a sports massage",
    member,
    preferOpenAI: false,
  });
  assert.equal(turn.booking, null);
  assert.ok(turn.windows.length > 0);
  assert.ok(turn.pending?.serviceId === "sports-massage");
  assert.ok(turn.pending?.startISO, "pending carries the real slot start");
  assert.match(turn.text, /slots|time/i);
});

test("no availability surfaces a readable message instead of mock windows", async () => {
  const member = await seedMember();
  const turn = await runAtlasTurn({
    message: "Book a sports massage",
    member,
    preferOpenAI: false,
  });
  assert.equal(turn.booking, null);
  assert.equal(turn.windows.length, 0);
  assert.match(turn.text, /No open provider slots/i);
});

test("confirms a pending window without a live language model", async () => {
  const member = await seedMember();
  await fund(member, 400);
  await seedProvider();
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
  assert.ok(confirm.booking?.serviceId.endsWith("sports-massage"));
  assert.equal((await listMemberBookings(member.id)).length, 1);
});

test("demo mode still returns a persistable reservation without a session", async () => {
  await seedMember();
  await seedProvider();
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
  await fund(member, 400);
  await seedProvider();
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
  await seedMember();
  await seedProvider();
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

test("a slot taken by another member surfaces a readable 409", async () => {
  const memberA = await seedMember("member_a");
  const memberB = await seedMember("member_b");
  await fund(memberA, 400);
  await fund(memberB, 400);
  await seedProvider();

  const windows = await realWindowsForService("deep-tissue");
  const slot = windows[0]!;
  const args = {
    serviceId: "deep-tissue",
    date: slot.label,
    providerId: slot.providerId!,
    startISO: slot.startISO!,
  };
  const first = await executeTool("create_booking", args, memberContext(memberA)) as CreateBookingResult;
  assert.ok(first.booking);

  await assert.rejects(
    executeTool("create_booking", args, memberContext(memberB)) as Promise<unknown>,
    (error: unknown) => {
      assert.ok(error instanceof BookingError);
      assert.equal(error.status, 409);
      assert.match(error.message, /just taken/i);
      return true;
    },
  );
  assert.equal((await listMemberBookings(memberB.id)).length, 0);
});

test("rebooking the same slot returns the existing reservation", async () => {
  const member = await seedMember();
  await fund(member, 400);
  await seedProvider();

  const windows = await realWindowsForService("deep-tissue");
  const slot = windows[0]!;
  const args = {
    serviceId: "deep-tissue",
    date: slot.label,
    providerId: slot.providerId!,
    startISO: slot.startISO!,
  };
  const first = await executeTool("create_booking", args, memberContext(member)) as CreateBookingResult;
  const second = await executeTool("create_booking", args, memberContext(member)) as CreateBookingResult;
  assert.equal(second.booking.id, first.booking.id);
  assert.equal((await listMemberBookings(member.id)).length, 1);
});

test("create_booking auto-assigns a free provider when only startISO is given", async () => {
  const member = await seedMember();
  await fund(member, 400);
  const {accountId} = await seedProvider();

  const windows = await realWindowsForService("sports-massage");
  const slot = windows[0]!;
  const result = await executeTool("create_booking", {
    serviceId: "sports-massage",
    date: slot.label,
    startISO: slot.startISO!,
  }, memberContext(member)) as CreateBookingResult;

  assert.ok(result.booking);
  assert.equal(result.source, "server");
  assert.ok(result.booking.provider.length > 0);
  const listed = await listMemberBookings(member.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.providerId, accountId);
});

test("auto-assign fails readably when no provider is free", async () => {
  const member = await seedMember();
  await fund(member, 400);
  await seedProvider();

  const offHours = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  offHours.setHours(3, 0, 0, 0);
  await assert.rejects(
    executeTool("create_booking", {
      serviceId: "deep-tissue",
      date: "Off hours",
      startISO: offHours.toISOString(),
    }, memberContext(member)) as Promise<unknown>,
    (error: unknown) => {
      assert.ok(error instanceof BookingError);
      assert.equal(error.status, 409);
      assert.match(error.message, /No provider is free/i);
      return true;
    },
  );
});

test("booking an unknown provider id for a real slot fails readably", async () => {
  const member = await seedMember();
  await fund(member, 400);
  await seedProvider();

  const windows = await realWindowsForService("deep-tissue");
  const slot = windows[0]!;
  await assert.rejects(
    executeTool("create_booking", {
      serviceId: "deep-tissue",
      date: slot.label,
      providerId: "prov_app_nonexistent",
      startISO: slot.startISO!,
    }, memberContext(member)) as Promise<unknown>,
    (error: unknown) => {
      assert.ok(error instanceof BookingError);
      assert.match(error.message, /not offering this service/i);
      return true;
    },
  );
});
