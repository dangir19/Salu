import test from "node:test";
import assert from "node:assert/strict";
import {handleProvidersFetch} from "../providers/handlers.ts";
import {
  catalogFromApplication,
  liveServiceId,
  parseLiveServiceId,
  rateFromExpectation,
  resetLiveCatalogMemory,
} from "../providers/catalog.ts";
import {
  findApprovedCatalogService,
  listApplications,
  listApprovedCatalog,
  ProviderError,
  resetProviderMemory,
  submitApplication,
  updateApplicationStatus,
} from "../providers/service.ts";
import {findCatalogService} from "../bookings/catalog.ts";
import {createMemberBooking, resetBookingMemory} from "../bookings/service.ts";
import {rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import {resetMemberMemory} from "../auth/members.ts";

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    businessName: "Palm Court Recovery",
    contactName: "Elena Díaz",
    email: "elena@palmcourt.example",
    phone: "305-555-0148",
    services: ["Deep Tissue Massage", "Sports Massage"],
    neighborhoods: ["Brickell", "Miami Beach"],
    licenseAttested: true,
    insuranceAttested: true,
    rateExpectation: "$150–200 / visit",
    notes: "Hotel and at-home, English and Spanish.",
    ...overrides,
  };
}

test("parses live catalog ids and typical visit rates", () => {
  const id = liveServiceId("pa_abc", "deep-tissue");
  assert.deepEqual(parseLiveServiceId(id), {applicationId: "pa_abc", serviceKey: "deep-tissue"});
  assert.equal(rateFromExpectation("$150–200 / visit"), 150);
  assert.equal(rateFromExpectation("Under $100 / visit"), 100);
});

test("submits an application into the Miami pipeline without secrets", async () => {
  resetProviderMemory();
  const application = await submitApplication(validPayload());
  assert.equal(application.status, "submitted");
  assert.equal(application.email, "elena@palmcourt.example");
  assert.deepEqual(application.neighborhoods, ["Brickell", "Miami Beach"]);
  assert.equal(application.licenseAttested, true);
  const listed = await listApplications("submitted");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, application.id);
});

test("rejects an application missing neighborhoods or attestations", async () => {
  resetProviderMemory();
  await assert.rejects(
    () => submitApplication(validPayload({neighborhoods: []})),
    (error: unknown) => error instanceof ProviderError,
  );
  await assert.rejects(
    () => submitApplication(validPayload({licenseAttested: false})),
    (error: unknown) => error instanceof ProviderError,
  );
});

test("approved applications appear in the catalog and stay out while under review", async () => {
  resetProviderMemory();
  resetLiveCatalogMemory();
  const application = await submitApplication(validPayload({email: "approved@joinsalu.com"}));
  const empty = await listApprovedCatalog();
  assert.equal(empty.providers.length, 0);

  const approved = await updateApplicationStatus({id: application.id, status: "approved"});
  assert.equal(approved.status, "approved");
  const catalog = await listApprovedCatalog();
  assert.equal(catalog.providers.length, 1);
  assert.equal(catalog.providers[0]?.name, "Palm Court Recovery");
  assert.equal(catalog.providers[0]?.source, "application");
  assert.ok(catalog.services.some((service) => service.name === "Deep Tissue Massage"));
  assert.equal(catalogFromApplication(application)?.provider.name, undefined);

  const mapped = catalogFromApplication(approved);
  assert.ok(mapped);
  const service = await findApprovedCatalogService(mapped.services[0]!.id);
  assert.equal(service?.provider, "Palm Court Recovery");
  assert.equal(findCatalogService(mapped.services[0]!.id)?.id, mapped.services[0]!.id);
});

test("members can book an approved supplier after BD approves", async () => {
  resetProviderMemory();
  resetLiveCatalogMemory();
  resetMemberMemory();
  resetPaymentMemory();
  resetBookingMemory();
  const application = await submitApplication(validPayload({email: "bookable@joinsalu.com"}));
  await updateApplicationStatus({id: application.id, status: "approved"});
  const catalog = await listApprovedCatalog();
  const service = catalog.services[0];
  assert.ok(service);

  const member = await rememberMember({
    id: "member_pipeline",
    email: "member@joinsalu.com",
    displayName: "Ava Ruiz",
    planId: "platinum",
  });
  const result = await createMemberBooking({
    member,
    serviceId: service.id,
    date: "Tomorrow · 6:00 PM",
    mode: "At home · Brickell",
    enforceCredits: false,
  });
  assert.equal(result.booking.provider, "Palm Court Recovery");
  assert.equal(result.booking.serviceName, service.name);
});

test("provider apply API persists without Auth or Stripe secrets", async () => {
  resetProviderMemory();
  const created = await handleProvidersFetch(new Request("http://localhost/api/providers/apply", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(validPayload({email: "api@joinsalu.com"})),
  }));
  assert.equal(created.status, 200);
  const body = await created.json() as {source: string; application: {email: string; status: string}};
  assert.equal(body.source, "server");
  assert.equal(body.application.status, "submitted");

  const catalog = await handleProvidersFetch(new Request("http://localhost/api/providers/catalog"));
  const catalogBody = await catalog.json() as {mockFallback: boolean; providers: unknown[]};
  assert.equal(catalog.status, 200);
  assert.equal(catalogBody.mockFallback, true);
  assert.equal(catalogBody.providers.length, 0);

  const listed = await handleProvidersFetch(new Request("http://localhost/api/providers/applications"));
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as {applications: Array<{email: string}>; opsOpen: boolean};
  assert.equal(listBody.opsOpen, true);
  assert.equal(listBody.applications.some((row) => row.email === "api@joinsalu.com"), true);
});

test("ops secret gates admin list and status", async () => {
  resetProviderMemory();
  const env = {SALU_OPS_SECRET: "pipeline-key"};
  const listed = await handleProvidersFetch(new Request("http://localhost/api/providers/applications"), env);
  assert.equal(listed.status, 401);

  const opened = await handleProvidersFetch(new Request("http://localhost/api/providers/applications", {
    headers: {"x-salu-ops": "pipeline-key"},
  }), env);
  assert.equal(opened.status, 200);
  const openedBody = await opened.json() as {opsOpen: boolean};
  assert.equal(openedBody.opsOpen, false);

  const created = await submitApplication(validPayload({email: "secret@joinsalu.com"}));
  const denied = await handleProvidersFetch(new Request("http://localhost/api/providers/applications/status", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({id: created.id, status: "approved"}),
  }), env);
  assert.equal(denied.status, 401);

  const approved = await handleProvidersFetch(new Request("http://localhost/api/providers/applications/status", {
    method: "POST",
    headers: {"Content-Type": "application/json", "x-salu-ops": "pipeline-key"},
    body: JSON.stringify({id: created.id, status: "approved"}),
  }), env);
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json() as {application: {status: string}};
  assert.equal(approvedBody.application.status, "approved");
});
