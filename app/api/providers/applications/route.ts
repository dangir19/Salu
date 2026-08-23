import {handleProvidersFetch} from "../../../../providers/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleProvidersFetch(request);
}
