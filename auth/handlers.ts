import {Auth, isAuthAction} from "@auth/core";
import {createAuthConfig} from "./config";
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

  const action = url.pathname.split("/api/auth/")[1]?.split("/")[0];
  if (action && !isAuthAction(action)) {
    return new Response("Not found", {status: 404});
  }

  return Auth(request, await createAuthConfig(env));
}
