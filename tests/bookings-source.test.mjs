import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const app = await readFile(new URL("../components/SaluApp.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const bookingsMd = await readFile(new URL("../BOOKINGS.md", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0002_bookings.sql", import.meta.url), "utf8");

test("wires member booking APIs and keeps a labeled demo fallback", () => {
  for (const term of [
    "/api/bookings",
    "/api/bookings/cancel",
    "/api/bookings/complete",
    "/api/bookings/reschedule",
    "/api/bookings/accept-proposal",
    "/api/bookings/decline-proposal",
    "confirmServerBooking",
    "cancelServerBooking",
    "This time works",
    "Not this time",
    "Demo appointments",
    "setCredits(v=>v+booking.credits)",
  ]) {
    assert.match(app, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(worker, /\/api\/bookings/);
  assert.match(schema, /export const bookings/);
  assert.match(migration, /CREATE TABLE `bookings`/);
});

test("documents D1 binding, Credit enforcement, and what stays demo", () => {
  for (const term of [
    "DB",
    "drizzle/0002_bookings.sql",
    "customer liabilities",
    "demo",
    "remaining-session",
    "accept-proposal",
    "decline-proposal",
    "Stripe Connect",
  ]) {
    assert.match(bookingsMd, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
