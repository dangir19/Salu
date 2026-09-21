import {getFreeSlots} from "../scheduling/slots";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

/**
 * GET /api/providers/slots?providerId=&serviceId=&from=&to=
 * Public free-slot search across approved providers. Defaults to the next
 * 14 days. Note: the production worker must route this path here
 * (worker/index.ts currently prefix-routes /api/providers/* to
 * handleProvidersFetch, which cannot be edited from this task).
 */
export async function handleProviderSlotsFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/providers/slots" || request.method !== "GET") {
    return new Response("Not found", {status: 404});
  }

  const now = new Date();
  const from = url.searchParams.get("from")?.trim() || now.toISOString();
  const to = url.searchParams.get("to")?.trim() || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const serviceId = url.searchParams.get("serviceId")?.trim() || undefined;
  const providerId = url.searchParams.get("providerId")?.trim() || undefined;

  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) {
    return json({source: "server", error: "from and to must be ISO datetimes."}, 400);
  }

  let durationMinutes = 60;
  if (serviceId) {
    try {
      const catalog = await import("../bookings/catalog");
      durationMinutes = catalog.durationMinutesForService(serviceId);
    } catch {
      // Fall back to the default duration.
    }
  }

  try {
    const slots = await getFreeSlots({providerId, serviceId, fromISO: from, toISO: to, durationMinutes});
    return json({source: "server", slots});
  } catch (error) {
    const message = error instanceof Error ? error.message : "Free slots could not be loaded.";
    return json({source: "server", error: message}, 400);
  }
}
