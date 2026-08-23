import {handlePaymentsFetch} from "../../../../payments/handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handlePaymentsFetch(request);
}
