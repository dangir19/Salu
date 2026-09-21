import {handleAdminFetch} from "../../../../../admin/handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleAdminFetch(request);
}
