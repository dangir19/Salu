import {handleProviderFetch} from "../../../../../provider/handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleProviderFetch(request);
}
