import {Auth, isAuthAction} from "@auth/core";
import {createAuthConfig} from "./config";
import {registerNativeAccount} from "./credentials";
import {applyAuthEnvToProcess, readAuthEnv} from "./env";
import {getMePayload} from "./session";

type RuntimeEnv = Record<string, string | undefined>;

export async function handleAuthFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const env = readAuthEnv({
    ...runtimeEnv,
    AUTH_URL: runtimeEnv.AUTH_URL || url.origin,
  });
  applyAuthEnvToProcess(env);

  if (url.pathname === "/api/me") {
    return Response.json(await getMePayload(request));
  }

  if (url.pathname === "/api/auth/register") {
    return handleRegister(request);
  }

  const action = url.pathname.split("/api/auth/")[1]?.split("/")[0];
  if (action && !isAuthAction(action)) {
    return new Response("Not found", {status: 404});
  }

  return Auth(request, await createAuthConfig(env));
}

export async function handleRegister(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {status: 405});
  }

  let body: {email?: string; password?: string; displayName?: string} = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      {error: "Send email, password, and the name we should greet you by."},
      {status: 400},
    );
  }

  const result = await registerNativeAccount({
    email: body.email,
    password: body.password,
    displayName: body.displayName,
    ip: request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for"),
  });
  if (!result.ok) return Response.json({error: result.error}, {status: result.status});
  return Response.json({ok: true});
}
