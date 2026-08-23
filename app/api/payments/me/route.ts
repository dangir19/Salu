import {handlePaymentsFetch} from "../../../../payments/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handlePaymentsFetch(request);
}
