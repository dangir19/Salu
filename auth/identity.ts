import type {AuthProviderId} from "./env";
import type {Member} from "../domain/types";

export type MemberSession = {
  member: Member;
  source: AuthProviderId;
  memberSince: string;
};

export type AdminSession = {
  role: "admin";
  email: string;
};

export function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts.map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  }
  return (parts[0]?.slice(0, 2) || "S").toUpperCase();
}

export function displayNameFromProfile(input: {
  name?: string | null;
  email?: string | null;
  givenName?: string | null;
  familyName?: string | null;
}): string {
  const assembled = [input.givenName, input.familyName].filter(Boolean).join(" ").trim();
  const name = (input.name ?? "").trim() || assembled;
  if (name) return name;
  const email = (input.email ?? "").trim();
  if (email.includes("@")) return email.split("@")[0] ?? email;
  return "Member";
}

export function memberFromIdentity(input: {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  provider?: string | null;
  createdAt?: string | null;
}): Member {
  const email = (input.email ?? "").trim().toLowerCase();
  const provider = normalizeProvider(input.provider);
  const id = (input.id ?? "").trim() || fallbackMemberId(provider, email);
  const createdAt = input.createdAt ?? new Date().toISOString();

  return {
    id,
    email: email || `${id}@members.joinsalu.com`,
    displayName: displayNameFromProfile({name: input.name, email}),
    householdId: `hh_${id}`,
    planId: "member",
    authProvider: provider,
    image: input.image ?? undefined,
    createdAt,
  };
}

export function sessionFromMember(member: Member, source?: AuthProviderId): MemberSession {
  return {
    member,
    source: source ?? member.authProvider ?? "development",
    memberSince: member.createdAt ?? new Date().toISOString(),
  };
}

export function normalizeProvider(value?: string | null): AuthProviderId {
  if (value === "google" || value === "apple" || value === "chatgpt" || value === "development") {
    return value;
  }
  return "development";
}

export function fallbackMemberId(provider: AuthProviderId, email: string): string {
  const seed = email || "preview";
  return `member_${provider}_${seed.replace(/[^a-z0-9]+/gi, "_")}`;
}

export function membershipSinceLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "This month";
  return date.toLocaleDateString("en-US", {month: "long", year: "numeric"});
}
