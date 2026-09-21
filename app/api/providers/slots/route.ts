import {handleProviderSlotsFetch} from "../../../../providers/slots";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleProviderSlotsFetch(request);
}
