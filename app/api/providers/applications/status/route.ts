import {handleProvidersFetch} from "../../../../../providers/handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleProvidersFetch(request);
}
