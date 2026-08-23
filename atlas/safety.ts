import {atlasReplies} from "../domain/mock-data";
import type {AtlasSafetyKind} from "./types";

export const EMERGENCY_PATTERN =
  /emergency|chest pain|can'?t breathe|cannot breathe|hard to breathe|faint(?:ing)?|passed out|stroke|overdose|suicidal|one-sided swelling/i;

export const CLINICAL_BOUNDARY_PATTERN =
  /diagnos|prescribe|prescription|what (?:medication|dose|drug|statin|antibiotic)|do i have|is this (?:cancer|diabetes|anemia)|which (?:statin|antibiotic|glp-?1)|how many mg\b/i;

const EMERGENCY_TEXT =
  atlasReplies.find((reply) => reply.match.source.includes("emergency"))?.text ??
  "This could need urgent professional attention. Atlas can’t assess emergencies. Call 911 or seek emergency care now; don’t use a wellness booking as a substitute.";

const CLINICAL_TEXT =
  "Atlas does not diagnose, prescribe, or recommend medication. I can coordinate a consultation with an independent qualified provider — general wellness coordination only.";

export type AtlasSafety = {
  kind: AtlasSafetyKind;
  text?: string;
};

export function assessSafety(prompt: string): AtlasSafety {
  if (EMERGENCY_PATTERN.test(prompt)) {
    return {kind: "emergency", text: EMERGENCY_TEXT};
  }
  if (CLINICAL_BOUNDARY_PATTERN.test(prompt)) {
    return {kind: "clinical_boundary", text: CLINICAL_TEXT};
  }
  return {kind: "ok"};
}

export function educationalReply(prompt: string): string | null {
  return atlasReplies.find((reply) => reply.match.test(prompt))?.text ?? null;
}
