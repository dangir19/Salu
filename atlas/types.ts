import type {UiBooking} from "../bookings/service";

export const ATLAS_TOOL_NAMES = ["discover_services", "check_availability", "create_booking"] as const;
export type AtlasToolName = (typeof ATLAS_TOOL_NAMES)[number];

export type AtlasPlanner = "deterministic" | "openai";
export type AtlasSafetyKind = "ok" | "emergency" | "clinical_boundary";
export type AtlasBookingSource = "demo" | "server";

export type AtlasHistoryMessage = {
  role: "member" | "atlas";
  content: string;
};

export type AtlasPending = {
  serviceId: string;
  date: string;
  mode: string;
  packageName?: string;
  packageItem?: string;
  /** Real scheduling-engine slot details, set when the pending window came from check_availability. */
  providerId?: string;
  startISO?: string;
  endISO?: string;
};

export type AtlasEntitlement = {
  name: string;
  items: {label: string; remaining: number}[];
};

export type AtlasServiceMatch = {
  id: string;
  name: string;
  provider: string;
  category: string;
  mode: string;
  area: string;
  next: string;
  standardPrice: number;
  duration: string;
};

export type AtlasWindow = {
  id: string;
  serviceId: string;
  date: string;
  mode: string;
  label: string;
  /** Real scheduling-engine slot details, present when the window came from check_availability. */
  providerId?: string;
  providerName?: string;
  slotServiceId?: string;
  startISO?: string;
  endISO?: string;
};

export type AtlasToolTrace = {
  name: AtlasToolName;
  args: Record<string, unknown>;
  ok: boolean;
};

export type AtlasTurnRequest = {
  message: string;
  history?: AtlasHistoryMessage[];
  pending?: AtlasPending | null;
  entitlements?: AtlasEntitlement[];
  planId?: string;
};

export type AtlasTurn = {
  planner: AtlasPlanner;
  text: string;
  safety: {kind: AtlasSafetyKind};
  tools: AtlasToolTrace[];
  matches: AtlasServiceMatch[];
  windows: AtlasWindow[];
  pending: AtlasPending | null;
  booking: UiBooking | null;
  bookings?: UiBooking[];
  source: AtlasBookingSource;
  creditsApplied?: boolean;
  wallet?: {availableCredits: number};
  appointmentsPath: "/appointments";
};

export const APPOINTMENTS_PATH = "/appointments" as const;
