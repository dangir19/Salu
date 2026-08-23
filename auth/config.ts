import type {AuthConfig} from "@auth/core";
import Apple from "@auth/core/providers/apple";
import Credentials from "@auth/core/providers/credentials";
import Google from "@auth/core/providers/google";
import {appleClientSecret} from "./apple";
import {verifyNativeLogin} from "./credentials";
import {applyAuthEnvToProcess, authSurface, type AuthEnv} from "./env";
import {memberFromIdentity} from "./identity";
import {upsertMemberRecord} from "./members";

const UNSET_GOOGLE_ID = "unset-google-client-id";
const UNSET_GOOGLE_SECRET = "unset-google-client-secret";
const UNSET_APPLE_ID = "unset-apple-services-id";
const UNSET_APPLE_SECRET = "unset-apple-client-secret";

export async function createAuthConfig(env: AuthEnv): Promise<AuthConfig> {
  applyAuthEnvToProcess(env);
  const surface = authSurface(env);
  const appleSecret = (await appleClientSecret(env)) || UNSET_APPLE_SECRET;

  const providers: AuthConfig["providers"] = [
    Credentials({
      id: "credentials",
      name: "Email",
      credentials: {
        email: {label: "Email", type: "email"},
        password: {label: "Password", type: "password"},
      },
      authorize: async (credentials, request) => {
        const email = typeof credentials?.email === "string" ? credentials.email : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        const ip =
          request?.headers?.get("cf-connecting-ip") ||
          request?.headers?.get("x-forwarded-for");
        const member = await verifyNativeLogin(email, password, ip);
        if (!member) return null;
        return {
          id: member.id,
          name: member.displayName,
          email: member.email,
          image: member.image,
        };
      },
    }),
    Google({
      clientId: env.AUTH_GOOGLE_ID || UNSET_GOOGLE_ID,
      clientSecret: env.AUTH_GOOGLE_SECRET || UNSET_GOOGLE_SECRET,
    }),
    Apple({
      clientId: env.AUTH_APPLE_ID || UNSET_APPLE_ID,
      clientSecret: appleSecret,
    }),
  ];

  if (surface.development) {
    providers.push(
      Credentials({
        id: "development",
        name: "Development preview",
        credentials: {},
        authorize: async () => {
          if (!env.allowDevBypass) return null;
          return {
            id: "member_development_preview",
            name: "Local Preview",
            email: "preview@localhost",
          };
        },
      }),
    );
    providers.push(
      Credentials({
        id: "provider-development",
        name: "Demo provider",
        credentials: {},
        authorize: async () => {
          if (!env.allowDevBypass) return null;
          const {DEMO_PROVIDER_USER} = await import("../provider/catalog");
          return {
            id: DEMO_PROVIDER_USER.id,
            name: DEMO_PROVIDER_USER.name,
            email: DEMO_PROVIDER_USER.email,
          };
        },
      }),
    );
  }

  return {
    trustHost: true,
    secret: env.AUTH_SECRET,
    basePath: "/api/auth",
    providers,
    session: {strategy: "jwt", maxAge: 60 * 60 * 24 * 30},
    pages: {signIn: "/signin"},
    callbacks: {
      async jwt({token, user, account, profile}) {
        if (user) {
          token.sub = user.id ?? token.sub;
          token.name = user.name ?? token.name;
          token.email = user.email ?? token.email;
          token.picture = user.image ?? token.picture;
          token.authProvider = account?.provider ?? "development";
          token.memberSince = new Date().toISOString();
          if (account?.provider === "provider-development") token.role = "provider";
        }
        const appleUser = (profile as {user?: {name?: {firstName?: string; lastName?: string}}} | undefined)?.user;
        if (account?.provider === "apple" && appleUser?.name) {
          const name = [appleUser.name.firstName, appleUser.name.lastName].filter(Boolean).join(" ");
          if (name) token.name = name;
        }
        return token;
      },
      async session({session, token}) {
        if (session.user) {
          session.user.name = (token.name as string | undefined) ?? session.user.name;
          session.user.email = (token.email as string | undefined) ?? session.user.email;
        }
        return session;
      },
      async signIn({user, account}) {
        const member = memberFromIdentity({
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          provider: account?.provider,
        });
        await upsertMemberRecord(member);
        return true;
      },
    },
  };
}
