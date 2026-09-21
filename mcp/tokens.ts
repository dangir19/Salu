/**
 * Member API token management: GET /api/tokens, POST /api/tokens,
 * POST /api/tokens/revoke. Member session auth via auth/session.ts.
 * Raw tokens are returned exactly once at creation and never stored.
 */
import {getMemberSession} from "../auth/session";
import {
  createMemberApiToken,
  listMemberApiTokens,
  revokeMemberApiToken,
} from "../db/tokens";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

async function memberIdFrom(request: Request): Promise<string | null> {
  try {
    const session = await getMemberSession(request);
    return session?.member.id ?? null;
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function handleTokensFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/tokens" && request.method === "GET") {
    const memberId = await memberIdFrom(request);
    if (!memberId) return json({source: "server", error: "Sign in to manage AI assistant tokens."}, 401);
    const tokens = await listMemberApiTokens(memberId);
    if (!tokens) return json({source: "server", error: "Token storage is unavailable right now."}, 503);
    return json({source: "server", tokens});
  }

  if (url.pathname === "/api/tokens" && request.method === "POST") {
    const memberId = await memberIdFrom(request);
    if (!memberId) return json({source: "server", error: "Sign in to create an AI assistant token."}, 401);
    const body = await readBody(request);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) return json({source: "server", error: "Give the token a name, e.g. 'Claude on my laptop'."}, 400);
    const created = await createMemberApiToken(memberId, name);
    if (!created) return json({source: "server", error: "Token storage is unavailable right now."}, 503);
    return json(
      {
        source: "server",
        // The raw token is shown ONCE. Only the hash is stored.
        token: created.token,
        record: created.record,
        warning: "Copy this token now — you will not see it again.",
      },
      201,
    );
  }

  if (url.pathname === "/api/tokens/revoke" && request.method === "POST") {
    const memberId = await memberIdFrom(request);
    if (!memberId) return json({source: "server", error: "Sign in to revoke AI assistant tokens."}, 401);
    const body = await readBody(request);
    const tokenId = typeof body.tokenId === "string" ? body.tokenId : "";
    if (!tokenId) return json({source: "server", error: "Choose a token to revoke."}, 400);
    const revoked = await revokeMemberApiToken(memberId, tokenId);
    if (!revoked) return json({source: "server", error: "That token was not found."}, 404);
    return json({source: "server", revoked: true, tokenId});
  }

  return new Response("Not found", {status: 404});
}
