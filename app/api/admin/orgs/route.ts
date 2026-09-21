import {handleAdminFetch} from "../../../../admin/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleAdminFetch(request);
}
