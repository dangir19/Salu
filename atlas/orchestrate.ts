import type {Member} from "../domain/types";
import {isPlanId} from "../payments/catalog";
import {pickWindow, realWindowsForService} from "./availability";
import {isOpenAIReady, readAtlasEnv, type AtlasEnv} from "./env";
import {planWithOpenAI} from "./openai";
import {composeAtlasText, planAtlasTurn} from "./planner";
import {assessSafety} from "./safety";
import {
  executeTool,
  type CreateBookingResult,
  type ToolContext,
} from "./tools";
import {
  APPOINTMENTS_PATH,
  type AtlasEntitlement,
  type AtlasHistoryMessage,
  type AtlasPending,
  type AtlasPlanner,
  type AtlasServiceMatch,
  type AtlasToolTrace,
  type AtlasTurn,
  type AtlasWindow,
} from "./types";

export type RunAtlasTurnInput = {
  message: string;
  history?: AtlasHistoryMessage[];
  pending?: AtlasPending | null;
  entitlements?: AtlasEntitlement[];
  planId?: string;
  member?: Member | null;
  enforceCredits?: boolean;
  env?: AtlasEnv;
  preferOpenAI?: boolean;
  fetchImpl?: typeof fetch;
};

function emptyTurn(planner: AtlasPlanner, source: "demo" | "server"): AtlasTurn {
  return {
    planner,
    text: "",
    safety: {kind: "ok"},
    tools: [],
    matches: [],
    windows: [],
    pending: null,
    booking: null,
    source,
    appointmentsPath: APPOINTMENTS_PATH,
  };
}

type MemberOrgSummary = {id: string; name: string; role: "admin" | "staff"};

async function loadHealthSummary(
  member: Member | null | undefined,
): Promise<import("../health/service").WeeklyHealthSummary | null> {
  if (!member) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: health/service is optional at build time; resolves when present.
    const mod = await import("../health/service");
    const summary = await (
      mod as unknown as {getWeeklySummary(memberId: string): Promise<import("../health/service").WeeklyHealthSummary>}
    ).getWeeklySummary(member.id);
    return summary.hasData ? summary : null;
  } catch {
    return null;
  }
}

async function loadMemberOrgs(member: Member | null | undefined): Promise<MemberOrgSummary[]> {
  if (!member) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: ../business/service is being built in parallel; this resolves once it lands.
    const mod = await import("../business/service");
    const rows = await (
      mod as unknown as {
        getMemberOrgs(memberId: string): Promise<
          Array<{org: {id: string; name: string; status: string}; role: "admin" | "staff"}>
        >;
      }
    ).getMemberOrgs(member.id);
    return rows
      .filter((row) => row.org.status === "active")
      .map((row) => ({id: row.org.id, name: row.org.name, role: row.role}));
  } catch {
    return [];
  }
}

async function recoveryNoteForTurn(
  message: string,
  matches: {name: string}[],
  summary: import("../health/service").WeeklyHealthSummary | null,
): Promise<string | null> {
  if (!summary) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: health/service is optional at build time; resolves when present.
    const mod = await import("../health/service");
    const recommendation = (
      mod as unknown as {
        recommendRecovery(s: import("../health/service").WeeklyHealthSummary): import("../health/service").RecoveryRecommendation | null;
      }
    ).recommendRecovery(summary);
    if (!recommendation) return null;
    const trainingIntent = /recover|sore|tired|train|running|\brun\b|marathon|workout|legs|rest day/i.test(message);
    if (!trainingIntent && matches.length === 0) return null;
    return `From your training this week: ${recommendation.note} I can book ${recommendation.services.join(" or ")} whenever you're ready \u2014 this is general wellness coordination, not medical advice.`;
  } catch {
    return null;
  }
}

export async function runAtlasTurn(input: RunAtlasTurnInput): Promise<AtlasTurn> {
  const message = input.message.trim();
  const env = input.env ?? readAtlasEnv();
  const planner: AtlasPlanner = input.preferOpenAI !== false && isOpenAIReady(env) ? "openai" : "deterministic";
  const source = input.member ? "server" : "demo";
  const healthSummary = await loadHealthSummary(input.member);
  const context: ToolContext = {
    member: input.member,
    entitlements: input.entitlements,
    planId: isPlanId(input.planId) ? input.planId : input.member?.planId ?? "member",
    enforceCredits: Boolean(input.enforceCredits && input.member),
    orgs: await loadMemberOrgs(input.member),
    healthSummary,
  };

  if (!message) {
    return {
      ...emptyTurn(planner === "openai" ? "deterministic" : planner, source),
      text: "Tell me what would help you feel your best, and I’ll handle the details.",
    };
  }

  const safety = assessSafety(message);
  if (safety.kind === "emergency") {
    return {
      ...emptyTurn("deterministic", source),
      text: safety.text ?? "Call 911 or seek emergency care now.",
      safety: {kind: "emergency"},
    };
  }

  if (planner === "openai") {
    try {
      const openai = await planWithOpenAI({
        message,
        history: input.history,
        context,
        env,
        fetchImpl: input.fetchImpl,
      });
      const bookingResult = openai.booking;
      const uniqueMatches = openai.matches.filter((match, index) => openai.matches.findIndex((item) => item.id === match.id) === index);
      const uniqueWindows = openai.windows.filter((window, index) => openai.windows.findIndex((item) => item.id === window.id) === index);
      return {
        planner: "openai",
        text: openai.text,
        safety: {kind: safety.kind},
        tools: openai.tools,
        matches: uniqueMatches.slice(0, 3),
        windows: uniqueWindows.slice(0, 5),
        pending: bookingResult
          ? {serviceId: bookingResult.booking.serviceId, date: bookingResult.booking.date, mode: bookingResult.booking.mode}
          : uniqueWindows[0]
            ? {serviceId: uniqueWindows[0].serviceId, date: uniqueWindows[0].date, mode: uniqueWindows[0].mode}
            : input.pending ?? null,
        booking: bookingResult?.booking ?? null,
        bookings: bookingResult?.bookings,
        source: bookingResult?.source ?? source,
        creditsApplied: bookingResult?.creditsApplied,
        wallet: bookingResult?.availableCredits !== undefined
          ? {availableCredits: bookingResult.availableCredits}
          : undefined,
        appointmentsPath: APPOINTMENTS_PATH,
      };
    } catch {
      // Fall through to the deterministic planner. Tests never require a live model.
    }
  }

  const plan = await planAtlasTurn({message, history: input.history, pending: input.pending});
  const traces: AtlasToolTrace[] = [];
  const matches: AtlasServiceMatch[] = [];
  const windows: AtlasWindow[] = [];
  let bookingResult: CreateBookingResult | null = null;
  let toolError: string | null = null;
  let availabilityNote: string | null = null;

  for (const tool of plan.tools) {
    try {
      const result = await executeTool(tool.name, tool.args, context);
      traces.push({name: tool.name, args: tool.args, ok: true});
      if (tool.name === "discover_services") {
        const found = result as {matches: AtlasServiceMatch[]};
        matches.push(...found.matches);
      }
      if (tool.name === "check_availability") {
        const availability = result as {windows: AtlasWindow[]; service: AtlasServiceMatch | null; note?: string};
        windows.push(...availability.windows);
        if (availability.service) matches.push(availability.service);
        if (availability.note) availabilityNote = availability.note;
      }
      if (tool.name === "create_booking") {
        bookingResult = result as CreateBookingResult;
      }
    } catch (error) {
      traces.push({name: tool.name, args: tool.args, ok: false});
      if (!toolError) toolError = error instanceof Error ? error.message : "That step failed.";
    }
  }

  const uniqueMatches = matches.filter((match, index) => matches.findIndex((item) => item.id === match.id) === index);
  const uniqueWindows = windows.filter((window, index) => windows.findIndex((item) => item.id === window.id) === index);
  const pending = bookingResult
    ? {
      serviceId: bookingResult.booking.serviceId,
      date: bookingResult.booking.date,
      mode: bookingResult.booking.mode,
      packageName: bookingResult.booking.packageName,
      packageItem: bookingResult.booking.packageItem,
    }
    : plan.pending;
  const fallbackWindows = pending && !uniqueWindows.length ? await realWindowsForService(pending.serviceId) : [];
  const chosen = pending
    ? pickWindow(uniqueWindows.length ? uniqueWindows : fallbackWindows, message, {pendingDate: pending.date})
    : null;

  return {
    planner: "deterministic",
    text: composeAtlasText({
      message,
      safety: plan.safety,
      hint: plan.safety === "clinical_boundary" ? assessSafety(message).text ?? plan.replyHint : plan.replyHint,
      booked: bookingResult?.booking ?? null,
      matches: uniqueMatches,
      windows: uniqueWindows,
      toolError,
      note: availabilityNote,
      recoveryNote: await recoveryNoteForTurn(message, uniqueMatches, healthSummary),
    }),
    safety: {kind: plan.safety},
    tools: traces,
    matches: uniqueMatches.slice(0, 3),
    windows: uniqueWindows.slice(0, 5),
    pending: pending ?? (chosen ? {serviceId: chosen.serviceId, date: chosen.date, mode: chosen.mode} : null),
    booking: bookingResult?.booking ?? null,
    bookings: bookingResult?.bookings,
    source: bookingResult?.source ?? source,
    creditsApplied: bookingResult?.creditsApplied,
    wallet: bookingResult?.availableCredits !== undefined
      ? {availableCredits: bookingResult.availableCredits}
      : undefined,
    appointmentsPath: APPOINTMENTS_PATH,
  };
}
