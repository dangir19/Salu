import type {MembershipPlan, PlanName} from "../domain/types";

export const PLAN_IDS = {
  member: "member",
  gold: "gold",
  platinum: "platinum",
} as const;

export type PaidPlanId = "gold" | "platinum";
export type PlanId = "member" | PaidPlanId;

export const CREDIT_TOPUP_AMOUNTS = [100, 200, 500] as const;
export type CreditTopupAmount = (typeof CREDIT_TOPUP_AMOUNTS)[number];

export const MEMBERSHIP_PLANS: Record<PlanId, MembershipPlan> = {
  member: {
    id: "member",
    name: "Member",
    monthlyContribution: 0,
    discountPercent: 0,
    creditsRollOver: false,
    householdSlots: 1,
  },
  gold: {
    id: "gold",
    name: "Gold",
    monthlyContribution: 200,
    discountPercent: 10,
    creditsRollOver: true,
    householdSlots: 1,
  },
  platinum: {
    id: "platinum",
    name: "Platinum",
    monthlyContribution: 500,
    discountPercent: 20,
    creditsRollOver: true,
    householdSlots: 1,
  },
};

export function isPlanId(value: string | null | undefined): value is PlanId {
  return value === "member" || value === "gold" || value === "platinum";
}

export function isPaidPlanId(value: string | null | undefined): value is PaidPlanId {
  return value === "gold" || value === "platinum";
}

export function isCreditTopupAmount(value: number): value is CreditTopupAmount {
  return (CREDIT_TOPUP_AMOUNTS as readonly number[]).includes(value);
}

export function planIdFromName(name: PlanName | string): PlanId {
  const normalized = name.trim().toLowerCase();
  return isPlanId(normalized) ? normalized : "member";
}

export function planNameFromId(id: string | null | undefined): PlanName {
  if (id === "gold") return "Gold";
  if (id === "platinum") return "Platinum";
  return "Member";
}

export function monthlyCreditsForPlan(id: string | null | undefined): number {
  return isPlanId(id) ? MEMBERSHIP_PLANS[id].monthlyContribution : 0;
}

export function creditsFromUsdCents(cents: number): number {
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.round(cents / 100);
}
