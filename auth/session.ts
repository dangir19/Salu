import {getToken} from "@auth/core/jwt";
import {chatgptUserFromHeaders} from "./chatgpt";
import {authSurface, readAuthEnv, usesSecureCookies} from "./env";
import {memberFromIdentity, sessionFromMember, type AdminSession, type MemberSession} from "./identity";
import {upsertMemberRecord} from "./members";
import {isAdminEmail} from "../providers/env";
import type {ProviderSession} from "../provider/session";

export type {AdminSession};

export type MeResponse = {
  member: MemberSession | null;
  provider: ProviderSession | null;
  admin: AdminSession | null;
  providers: ReturnType<typeof authSurface>;
};

export async function getMemberSession(request?: Request, headerStore?: Headers): Promise<MemberSession | null> {
  const requestHeaders = request?.headers ?? headerStore;
  if (requestHeaders) {
    const chatgpt = chatgptUserFromHeaders(requestHeaders);
    if (chatgpt) {
      const member = memberFromIdentity({
        id: `chatgpt_${chatgpt.userId}`,
        email: chatgpt.email,
        name: chatgpt.fullName ?? chatgpt.displayName,
        provider: "chatgpt",
      });
      return sessionFromMember(await upsertMemberRecord(member), "chatgpt");
    }
  }

  const env = readAuthEnv();
  const cookieHeader = requestHeaders?.get("cookie") ?? "";
  if (!cookieHeader) return null;

  const token = await getToken({
    req: {headers: {cookie: cookieHeader}},
    secret: env.AUTH_SECRET,
    secureCookie: usesSecureCookies(env, request?.url ?? env.AUTH_URL),
  });
  if (!token?.email && !token?.sub) return null;

  const member = memberFromIdentity({
    id: typeof token.sub === "string" ? token.sub : null,
    email: typeof token.email === "string" ? token.email : null,
    name: typeof token.name === "string" ? token.name : null,
    image: typeof token.picture === "string" ? token.picture : null,
    provider: typeof token.authProvider === "string" ? token.authProvider : null,
    createdAt: typeof token.memberSince === "string" ? token.memberSince : null,
  });
  return sessionFromMember(await upsertMemberRecord(member), member.authProvider);
}

export async function getMePayload(
  request?: Request,
  headerStore?: Headers,
  runtimeEnv: Record<string, string | undefined> = {},
): Promise<MeResponse> {
  const member = await getMemberSession(request, headerStore);
  let provider: ProviderSession | null = null;
  if (member) {
    try {
      const {providerSessionFromMember} = await import("../provider/session");
      provider = await providerSessionFromMember(member, runtimeEnv);
    } catch {
      provider = null;
    }
  }
  const admin = member && isAdminEmail(member.member.email, runtimeEnv)
    ? {role: "admin" as const, email: member.member.email}
    : null;
  return {
    member,
    provider,
    admin,
    providers: authSurface(readAuthEnv()),
  };
}
