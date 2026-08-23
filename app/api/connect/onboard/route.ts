import {handleConnectFetch} from "../../../../connect/handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleConnectFetch(request);
}
