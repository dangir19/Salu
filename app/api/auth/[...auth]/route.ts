import {handleAuthFetch} from "../../../../auth/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleAuthFetch(request);
}

export function POST(request: Request) {
  return handleAuthFetch(request);
}
