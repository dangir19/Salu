import {readAtlasEnv, type AtlasEnv} from "./env";
import {
  ATLAS_TOOL_SCHEMAS,
  executeTool,
  type CreateBookingResult,
  type DiscoverResult,
  type AvailabilityResult,
  type ToolContext,
} from "./tools";
import type {AtlasHistoryMessage, AtlasServiceMatch, AtlasToolName, AtlasToolTrace, AtlasWindow} from "./types";

const SYSTEM_PROMPT = `You are Atlas, Salu’s wellness concierge for Miami members.
You coordinate independent marketplace services. You are not a physician.
Never diagnose, prescribe, or recommend medication or doses.
If the member describes an emergency, tell them to call 911 and do not book.
Use tools to discover services, check real provider availability, and create bookings.
Never invent catalog items or times that tools did not return.
After a successful booking, confirm the reservation clearly and mention Appointments.
Keep replies short, warm, and hospitality-minded. This is general wellness coordination.`;

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: {name: string; arguments: string};
};

export type OpenAITurn = {
  text: string;
  tools: AtlasToolTrace[];
  booking: CreateBookingResult | null;
  matches: AtlasServiceMatch[];
  windows: AtlasWindow[];
};

function historyToMessages(history: AtlasHistoryMessage[] = []): ChatMessage[] {
  return history.slice(-8).map((entry) => ({
    role: entry.role === "atlas" ? "assistant" : "user",
    content: entry.content,
  }));
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function planWithOpenAI(input: {
  message: string;
  history?: AtlasHistoryMessage[];
  context: ToolContext;
  env?: AtlasEnv;
  fetchImpl?: typeof fetch;
}): Promise<OpenAITurn> {
  const env = input.env ?? readAtlasEnv();
  const fetchImpl = input.fetchImpl ?? fetch;
  const tools: AtlasToolTrace[] = [];
  const matches: AtlasServiceMatch[] = [];
  const windows: AtlasWindow[] = [];
  let booking: CreateBookingResult | null = null;
  const messages: ChatMessage[] = [
    {role: "system", content: SYSTEM_PROMPT},
    ...historyToMessages(input.history),
    {role: "user", content: input.message},
  ];

  for (let step = 0; step < 4; step += 1) {
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages,
        tools: ATLAS_TOOL_SCHEMAS,
        tool_choice: "auto",
        temperature: 0.2,
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI request failed (${response.status}).`);
    }
    const payload = await response.json() as {
      choices?: {message?: ChatMessage}[];
    };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI returned an empty reply.");

    const calls = message.tool_calls ?? [];
    if (!calls.length) {
      return {text: message.content?.trim() || "I can help with that.", tools, booking, matches, windows};
    }

    messages.push(message);
    for (const call of calls) {
      const name = call.function.name as AtlasToolName;
      const args = parseArgs(call.function.arguments);
      try {
        const result = await executeTool(name, args, input.context);
        tools.push({name, args, ok: true});
        if (name === "discover_services") {
          matches.push(...(result as DiscoverResult).matches);
        }
        if (name === "check_availability") {
          const availability = result as AvailabilityResult;
          windows.push(...availability.windows);
          if (availability.service) matches.push(availability.service);
        }
        if (name === "create_booking") {
          booking = result as CreateBookingResult;
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: JSON.stringify(result),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Tool failed.";
        tools.push({name, args, ok: false});
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: JSON.stringify({error: detail}),
        });
      }
    }
  }

  return {text: "I can help with that.", tools, booking, matches, windows};
}
