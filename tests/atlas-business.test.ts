import test from "node:test";
import assert from "node:assert/strict";
import {resetMemberMemory} from "../auth/members.ts";
import {rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import {resetBookingMemory} from "../bookings/service.ts";
import {resetProviderMemory} from "../providers/service.ts";
import {resetSchedulingMemory} from "../db/scheduling.ts";
import {ATLAS_TOOL_SCHEMAS, createBooking} from "../atlas/tools.ts";
import type {Member} from "../domain/types.ts";

function resetAll() {
  resetMemberMemory();
  resetPaymentMemory();
  resetBookingMemory();
  resetProviderMemory();
  resetSchedulingMemory();
}

async function seedMember(id: string): Promise<Member> {
  resetAll();
  return rememberMember({
    id,
    email: `${id}@joinsalu.com`,
    displayName: "Biz Member",
    householdId: `hh_${id}`,
    planId: "platinum",
  });
}

async function businessBackendAvailable(): Promise<boolean> {
  try {
    await import("../business/service.ts");
    return true;
  } catch {
    return false;
  }
}

test("org booking without a signed-in member asks the user to sign in", async () => {
  resetAll();
  await assert.rejects(
    () =>
      createBooking(
        {serviceId: "deep-tissue", date: "Tomorrow", orgId: "org_123"},
        {enforceCredits: false},
      ),
    /Sign in with your business account to order for your organization\./,
  );
});

test("org booking for a non-member surfaces the membership error", async () => {
  const member = await seedMember("member_biz_outsider");
  const backend = await businessBackendAvailable();
  await assert.rejects(
    () =>
      createBooking(
        {serviceId: "deep-tissue", date: "Tomorrow", orgId: "org_nope"},
        {member, enforceCredits: false},
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      if (backend) {
        assert.equal((error as {name?: string}).name, "BusinessError");
        assert.equal((error as {status?: number}).status, 404);
      }
      return true;
    },
  );
});

test("create_booking schema documents business ordering", () => {
  const schema = ATLAS_TOOL_SCHEMAS.find((entry) => entry.function.name === "create_booking");
  assert.ok(schema, "create_booking schema is registered");
  const properties = schema.function.parameters.properties as Record<string, unknown>;
  for (const param of ["orgId", "recipientName", "recipientRoom", "quantity"]) {
    assert.ok(param in properties, `create_booking schema includes ${param}`);
  }
  assert.match(schema.function.description, /business/i);
});

test("org booking rejects out-of-range quantities", async () => {
  const member = await seedMember("member_biz_qty");
  await assert.rejects(
    () =>
      createBooking(
        {serviceId: "deep-tissue", date: "Tomorrow", orgId: "org_123", quantity: 11},
        {member, enforceCredits: false},
      ),
    /Quantity must be a whole number between 1 and 10\./,
  );
});
