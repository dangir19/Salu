import {opsAuthorized} from "./env";
import {
  listApplications,
  listApplicationsForEmail,
  listApprovedCatalog,
  ProviderError,
  submitApplication,
  updateApplicationStatus,
} from "./service";

type RuntimeEnv = Record<string, string | undefined>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProviderError) {
    return json({source: "server", error: error.message}, error.status);
  }
  const message = error instanceof Error ? error.message : "The application could not be saved.";
  return json({source: "server", error: message}, 400);
}

export async function handleProvidersFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/providers/apply" && request.method === "POST") {
    return handleSubmit(request);
  }
  if (url.pathname === "/api/providers/apply" && request.method === "GET") {
    return handleLookup(url);
  }
  if (url.pathname === "/api/providers/catalog" && request.method === "GET") {
    return handleCatalog();
  }
  if (url.pathname === "/api/providers/applications" && request.method === "GET") {
    return handleList(request, url, runtimeEnv);
  }
  if (url.pathname === "/api/providers/applications/status" && request.method === "POST") {
    return handleStatus(request, runtimeEnv);
  }
  return new Response("Not found", {status: 404});
}

async function handleSubmit(request: Request): Promise<Response> {
  let body: Parameters<typeof submitApplication>[0];
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Please complete the application."}, 400);
  }
  try {
    const application = await submitApplication(body);
    return json({
      source: "server",
      application,
      message: "Your application is in the Miami review pipeline.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleLookup(url: URL): Promise<Response> {
  const email = url.searchParams.get("email") ?? "";
  const applications = await listApplicationsForEmail(email);
  return json({
    source: "server",
    applications,
    mockFallback: true,
  });
}

async function handleCatalog(): Promise<Response> {
  const catalog = await listApprovedCatalog();
  return json({
    source: catalog.providers.length ? "server" : "demo",
    services: catalog.services,
    providers: catalog.providers,
    mockFallback: true,
    message: catalog.providers.length
      ? "Approved Miami suppliers from the BD pipeline."
      : "No approved suppliers yet. Explore still shows the labeled demo catalog.",
  });
}

async function handleList(request: Request, url: URL, runtimeEnv: RuntimeEnv): Promise<Response> {
  const auth = opsAuthorized(request, runtimeEnv);
  if (!auth.ok) {
    return json({source: "server", error: "Enter the Salu ops key to review applications.", opsOpen: false}, 401);
  }
  const statusParam = url.searchParams.get("status");
  const status = statusParam === "submitted" || statusParam === "under_review" || statusParam === "approved" || statusParam === "rejected"
    ? statusParam
    : undefined;
  const applications = await listApplications(status);
  return json({
    source: "server",
    applications,
    opsOpen: auth.open,
    mockFallback: true,
  });
}

async function handleStatus(request: Request, runtimeEnv: RuntimeEnv): Promise<Response> {
  const auth = opsAuthorized(request, runtimeEnv);
  if (!auth.ok) {
    return json({source: "server", error: "Enter the Salu ops key to update status.", opsOpen: false}, 401);
  }
  let body: {id?: string; status?: string; reviewNote?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose an application and status."}, 400);
  }
  try {
    const application = await updateApplicationStatus(body);
    const applications = await listApplications();
    return json({
      source: "server",
      application,
      applications,
      opsOpen: auth.open,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
