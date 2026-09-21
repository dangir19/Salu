import {handleProviderFetch} from "../../../../provider/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleProviderFetch(request);
}

export function POST(request: Request) {
  return handleProviderFetch(request);
}
