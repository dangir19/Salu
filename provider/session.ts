import {getMemberSession} from "../auth/session";
import {providerEmailsFromEnv, resolveProviderAccount} from "./service";
import type {ProviderAccount} from "../domain/types";

export type ProviderSession = {
  provider: ProviderAccount;
  source: string;
  role: "provider";
};

function allowlistedEmails(runtimeEnv: Record<string, string | undefined> = {}): string[] {
  return providerEmailsFromEnv(
    runtimeEnv.SALU_PROVIDER_EMAILS ||
      (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env?.SALU_PROVIDER_EMAILS,
  );
}

export async function providerSessionFromMember(
  member: {member: {id: string; email: string; displayName: string}; source: string},
  runtimeEnv: Record<string, string | undefined> = {},
): Promise<ProviderSession | null> {
  const account = await resolveProviderAccount({
    id: member.member.id,
    email: member.member.email,
    displayName: member.member.displayName,
    memberId: member.member.id,
    allowlistedEmails: allowlistedEmails(runtimeEnv),
  });
  if (!account) return null;
  return {provider: account, source: member.source, role: "provider"};
}

export async function getProviderSession(
  request?: Request,
  runtimeEnv: Record<string, string | undefined> = {},
  headerStore?: Headers,
): Promise<ProviderSession | null> {
  const member = await getMemberSession(request, headerStore);
  if (!member) return null;
  return providerSessionFromMember(member, runtimeEnv);
}
