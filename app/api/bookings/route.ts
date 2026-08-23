import {handleBookingsFetch} from "../../../bookings/handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleBookingsFetch(request);
}

export function POST(request: Request) {
  return handleBookingsFetch(request);
}
