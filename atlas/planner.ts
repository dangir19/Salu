import {findCatalogService} from "../bookings/catalog";
import {pickWindow, windowsForService} from "./availability";
import {assessSafety, educationalReply} from "./safety";
import {discoverServices, resolveServiceId} from "./tools";
import type {AtlasPending, AtlasSafetyKind, AtlasToolName} from "./types";

export type PlannedTool = {name: AtlasToolName; args: Record<string, unknown>};

export type AtlasPlan = {
  safety: AtlasSafetyKind;
  tools: PlannedTool[];
  replyHint: string;
  pending: AtlasPending | null;
  autoBook: boolean;
};

const BOOK_INTENT =
  /\b(book|reserve|schedule|get me|make (?:an |a )?appointment|lock in|confirm (?:the |this |my )?(?:reservation|booking|appointment))\b/i;
const ASAP_INTENT = /\b(next hour|asap|as soon|first available|soonest|right away|now)\b/i;
const CONFIRM_INTENT = /^(yes|yeah|yep|ok|okay|please|do it|book it|confirm|that one|the first|sounds good)\b/i;
const DISCOVER_INTENT = /\b(what do you have|what('?s| is) available|show me|options|looking for|need a|want a|find|massage|stretch|facial|iv|recovery)\b/i;

function lastMemberText(history: {role: string; content: string}[] = []): string {
  return [...history].reverse().find((entry) => entry.role === "member")?.content ?? "";
}

export function planAtlasTurn(input: {
  message: string;
  history?: {role: string; content: string}[];
  pending?: AtlasPending | null;
}): AtlasPlan {
  const message = input.message.trim();
  const safety = assessSafety(message);
  if (safety.kind === "emergency") {
    return {safety: "emergency", tools: [], replyHint: safety.text ?? "", pending: null, autoBook: false};
  }

  const confirm = CONFIRM_INTENT.test(message);
  const book = BOOK_INTENT.test(message) || confirm;
  const asap = ASAP_INTENT.test(message);
  const serviceId = resolveServiceId(message) ?? input.pending?.serviceId ?? resolveServiceId(lastMemberText(input.history));
  const service = serviceId ? findCatalogService(serviceId) : null;
  const windows = service ? windowsForService(service.id) : [];
  const window = service
    ? pickWindow(windows, message, {asap, pendingDate: confirm ? input.pending?.date : undefined})
    : null;

  if (safety.kind === "clinical_boundary" && !(book && service && (window || asap || confirm))) {
    const matches = discoverServices({query: message, limit: 3});
    const tools: PlannedTool[] = [{name: "discover_services", args: {query: message, limit: 3}}];
    const first = matches.matches[0];
    if (first) tools.push({name: "check_availability", args: {serviceId: first.id}});
    return {
      safety: "clinical_boundary",
      tools,
      replyHint: safety.text ?? "",
      pending: first
        ? {serviceId: first.id, date: first.next, mode: `${first.mode} · ${first.area}`}
        : null,
      autoBook: false,
    };
  }

  if (book && service && (window || (confirm && input.pending))) {
    const chosen = window ?? (input.pending
      ? {serviceId: input.pending.serviceId, date: input.pending.date, mode: input.pending.mode, id: "pending", label: input.pending.date}
      : null);
    if (chosen) {
      return {
        safety: safety.kind,
        tools: [
          {name: "discover_services", args: {query: service.name, limit: 1}},
          {name: "check_availability", args: {serviceId: service.id}},
          {name: "create_booking", args: {serviceId: service.id, date: chosen.date, mode: chosen.mode}},
        ],
        replyHint: "confirm",
        pending: {serviceId: service.id, date: chosen.date, mode: chosen.mode},
        autoBook: true,
      };
    }
  }

  if (book && service) {
    return {
      safety: safety.kind,
      tools: [
        {name: "discover_services", args: {query: service.name, limit: 3}},
        {name: "check_availability", args: {serviceId: service.id}},
      ],
      replyHint: "windows",
      pending: {
        serviceId: service.id,
        date: windows[0]?.date ?? service.next,
        mode: windows[0]?.mode ?? `${service.mode} · ${service.area}`,
      },
      autoBook: false,
    };
  }

  const education = educationalReply(message);
  const shouldDiscover = Boolean(service) || DISCOVER_INTENT.test(message) || Boolean(education) || safety.kind === "clinical_boundary";
  const query = service?.name ?? message;
  const tools: PlannedTool[] = shouldDiscover ? [{name: "discover_services", args: {query, limit: 3}}] : [];
  const first = service ?? discoverServices({query, limit: 1}).matches[0];
  if (first && shouldDiscover) {
    tools.push({name: "check_availability", args: {serviceId: first.id}});
  }

  return {
    safety: safety.kind,
    tools,
    replyHint: education ?? (shouldDiscover ? "discover" : "general"),
    pending: first
      ? {serviceId: first.id, date: first.next, mode: `${first.mode} · ${first.area}`}
      : input.pending ?? null,
    autoBook: false,
  };
}

export function composeAtlasText(input: {
  message: string;
  safety: AtlasSafetyKind;
  hint: string;
  booked?: {serviceName: string; date: string; mode: string; credits: number; packageName?: string} | null;
  matches: {name: string; next: string}[];
  windows: {date: string; mode: string}[];
}): string {
  if (input.safety === "emergency") {
    return educationalReply(input.message) ?? input.hint;
  }
  if (input.booked) {
    const paid = input.booked.packageName
      ? `using a ${input.booked.packageName} session`
      : `for ${input.booked.credits} Credits`;
    return `Confirmed. ${input.booked.serviceName} is reserved for ${input.booked.date} (${input.booked.mode}), ${paid}. Atlas added it to your appointments.`;
  }
  if (input.safety === "clinical_boundary") {
    const extra = input.matches[0] ? ` I can coordinate ${input.matches[0].name} if you want a reservation.` : "";
    return `${input.hint}${extra}`;
  }
  if (input.hint === "windows" && input.windows.length) {
    const name = input.matches[0]?.name ?? "that service";
    const options = input.windows.slice(0, 3).map((window) => window.date).join(", ");
    return `I can reserve ${name}. Open catalog windows: ${options}. Tell me which time to confirm — this is general wellness coordination, not a diagnosis.`;
  }
  const education = educationalReply(input.message);
  if (education) return education;
  if (input.matches.length) {
    const names = input.matches.map((match) => match.name).join(", ");
    return `I can help with that. From the Miami menu I would start with ${names}. Say the time you want and I will confirm the reservation.`;
  }
  return "I can help with that. I’ve considered your Miami location, timing and available Credits, and pulled together a few thoughtful options.";
}
