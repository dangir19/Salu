import {handleProvidersFetch} from "../../../../providers/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleProvidersFetch(request);
}

export function POST(request: Request) {
  return handleProvidersFetch(request);
}
