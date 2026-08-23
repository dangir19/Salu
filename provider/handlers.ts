import {getProviderSession} from "./session";
import {
  acceptRequest,
  blockProviderTime,
  declineRequest,
  ensureWalkthroughRequest,
  listInboxForProvider,
  listJobsForProvider,
  listProviderBlocks,
  proposeRequestTime,
  ProviderError,
  toUiRequest,
  unblockProviderTime,
} from "./service";

type RuntimeEnv = Record<string, string | undefined>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

const DEMO_UNAUTH = {
  source: "demo" as const,
  error: "Sign in as a provider to fill live appointment requests.",
  message: "This local preview still uses the labeled Tide & Tone demo workspace.",
};

async function requireProvider(request: Request, runtimeEnv: RuntimeEnv) {
  return getProviderSession(request, runtimeEnv);
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProviderError) {
    return json({source: "server", error: error.message}, error.status);
  }
  const message = error instanceof Error ? error.message : "The provider workspace could not complete that action.";
  return json({source: "server", error: message}, 400);
}

export async function handleProviderFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/provider/me" && request.method === "GET") {
    return handleMe(request, runtimeEnv);
  }
  if (path === "/api/provider/requests" && request.method === "GET") {
    return handleInbox(request, runtimeEnv);
  }
  if (path === "/api/provider/requests/accept" && request.method === "POST") {
    return handleAccept(request, runtimeEnv);
  }
  if (path === "/api/provider/requests/decline" && request.method === "POST") {
    return handleDecline(request, runtimeEnv);
  }
  if (path === "/api/provider/requests/propose" && request.method === "POST") {
    return handlePropose(request, runtimeEnv);
  }
  if (path === "/api/provider/schedule" && request.method === "GET") {
    return handleSchedule(request, runtimeEnv);
  }
  if (path === "/api/provider/schedule/block" && request.method === "POST") {
    return handleBlock(request, runtimeEnv);
  }
  if (path === "/api/provider/schedule/unblock" && request.method === "POST") {
    return handleUnblock(request, runtimeEnv);
  }
  return new Response("Not found", {status: 404});
}

async function handleMe(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await requireProvider(request, runtimeEnv);
  if (!session) {
    return json({
      source: "demo",
      provider: null,
      message: "Sign in as a provider to open the live request queue. Without a session this workspace stays a labeled demo.",
    });
  }
  return json({source: "server", provider: session.provider, role: session.role, sourceAuth: session.source});
}

async function handleInbox(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await requireProvider(request, runtimeEnv);
  if (!session) return json({...DEMO_UNAUTH, requests: []}, 401);

  await ensureWalkthroughRequest(session.provider);
  const requests = await listInboxForProvider(session.provider);
  return json({
    source: "server",
    provider: session.provider,
    requests: requests.map(toUiRequest),
  });
}

async function handleAccept(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await requireProvider(request, runtimeEnv);
  if (!session) return json(DEMO_UNAUTH, 401);

  let body: {id?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a request to accept."}, 400);
  }

  try {
    const accepted = await acceptRequest({provider: session.provider, requestId: body.id ?? ""});
    const requests = await listInboxForProvider(session.provider);
    const jobs = await listJobsForProvider(session.provider);
    return json({
      source: "server",
      request: toUiRequest(accepted),
      requests: requests.map(toUiRequest),
      jobs: jobs.map(toUiRequest),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleDecline(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await requireProvider(request, runtimeEnv);
  if (!session) return json(DEMO_UNAUTH, 401);

  let body: {id?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a request to decline."}, 400);
  }

  try {
    const declined = await declineRequest({provider: session.provider, requestId: body.id ?? ""});
    const requests = await listInboxForProvider(session.provider);
    return json({
      source: "server",
      request: toUiRequest(declined),
      requests: requests.map(toUiRequest),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePropose(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await requireProvider(request, runtimeEnv);
  if (!session) return json(DEMO_UNAUTH, 401);

  let body: {id?: string; date?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a request and a time to propose."}, 400);
  }

  try {
    const proposed = await proposeRequestTime({
      provider: session.provider,
      requestId: body.id ?? "",
      date: body.date ?? "",
    });
    const requests = await listInboxForProvider(session.provider);
    const jobs = await listJobsForProvider(session.provider);
    return json({
      source: "server",
      request: toUiRequest(proposed),
      requests: requests.map(toUiRequest),
      jobs: jobs.map(toUiRequest),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleSchedule(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await requireProvider(request, runtimeEnv);
  if (!session) return json({...DEMO_UNAUTH, jobs: [], blocks: []}, 401);

  const jobs = await listJobsForProvider(session.provider);
  const blocks = await listProviderBlocks(session.provider);
  return json({
    source: "server",
    provider: session.provider,
    jobs: jobs.map(toUiRequest),
    blocks,
  });
}

async function handleBlock(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await requireProvider(request, runtimeEnv);
  if (!session) return json(DEMO_UNAUTH, 401);

  let body: {date?: string; note?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a time to block."}, 400);
  }

  try {
    const block = await blockProviderTime({
      provider: session.provider,
      date: body.date ?? "",
      note: body.note,
    });
    const blocks = await listProviderBlocks(session.provider);
    return json({source: "server", block, blocks});
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUnblock(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await requireProvider(request, runtimeEnv);
  if (!session) return json(DEMO_UNAUTH, 401);

  let body: {id?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a block to remove."}, 400);
  }

  try {
    await unblockProviderTime({provider: session.provider, blockId: body.id ?? ""});
    const blocks = await listProviderBlocks(session.provider);
    return json({source: "server", blocks});
  } catch (error) {
    return errorResponse(error);
  }
}
