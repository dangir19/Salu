import {getMemberSession} from "../auth/session";
import {rememberMember} from "../payments/ledger";
import {applyStripeEnvToProcess, isStripeReady, readStripeEnv, type StripeEnv} from "../payments/env";
import {isPlanId} from "../payments/catalog";
import {applyAtlasEnvToProcess, isOpenAIReady, readAtlasEnv} from "./env";
import {runAtlasTurn} from "./orchestrate";
import {ATLAS_TOOL_NAMES, APPOINTMENTS_PATH, type AtlasEntitlement, type AtlasHistoryMessage, type AtlasPending} from "./types";

type RuntimeEnv = Record<string, string | undefined>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

function stripeEnvFrom(request: Request, runtimeEnv: RuntimeEnv): StripeEnv {
  const env = readStripeEnv({
    ...runtimeEnv,
    STRIPE_SECRET_KEY: runtimeEnv.STRIPE_SECRET_KEY,
  });
  applyStripeEnvToProcess(env);
  void request;
  return env;
}

export async function handleAtlasFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const atlasEnv = readAtlasEnv(runtimeEnv);
  applyAtlasEnvToProcess(atlasEnv);
  const stripeEnv = stripeEnvFrom(request, runtimeEnv);

  if (url.pathname === "/api/atlas" && request.method === "GET") {
    return json({
      planner: isOpenAIReady(atlasEnv) ? "openai" : "deterministic",
      tools: ATLAS_TOOL_NAMES,
      appointmentsPath: APPOINTMENTS_PATH,
      openai: isOpenAIReady(atlasEnv),
    });
  }

  if (url.pathname === "/api/atlas" && request.method === "POST") {
    let body: {
      message?: string;
      history?: AtlasHistoryMessage[];
      pending?: AtlasPending | null;
      entitlements?: AtlasEntitlement[];
      planId?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({error: "Send Atlas a message."}, 400);
    }

    const session = await getMemberSession(request);
    const member = session ? await rememberMember(session.member) : null;
    const turn = await runAtlasTurn({
      message: body.message ?? "",
      history: body.history,
      pending: body.pending,
      entitlements: body.entitlements,
      planId: isPlanId(body.planId) ? body.planId : member?.planId,
      member,
      enforceCredits: Boolean(member && isStripeReady(stripeEnv)),
      env: atlasEnv,
    });
    return json(turn);
  }

  return new Response("Not found", {status: 404});
}
