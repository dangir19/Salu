import {handleHealthFetch} from "../../../../../health/handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleHealthFetch(request);
}
