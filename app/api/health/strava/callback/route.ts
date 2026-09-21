import {handleHealthFetch} from "../../../../../health/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleHealthFetch(request);
}
