import {handleAtlasFetch} from "../../../atlas/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleAtlasFetch(request);
}

export function POST(request: Request) {
  return handleAtlasFetch(request);
}
