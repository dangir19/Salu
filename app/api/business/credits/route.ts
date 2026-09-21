import {handleBusinessFetch} from "../../../../business/handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleBusinessFetch(request);
}
