import {handleConnectFetch} from "../../../../connect/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleConnectFetch(request);
}
