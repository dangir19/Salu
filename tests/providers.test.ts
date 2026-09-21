import test from "node:test";
import assert from "node:assert/strict";
import {handleProvidersFetch} from "../providers/handlers.ts";
import {
  catalogFromApplication,
  liveServiceId,
  parseLiveServiceId,
  rateFromAsk,
  resetLiveCatalogMemory,
} from "../providers/catalog.ts";
import {DEMO_ADMIN_EMAIL, isAdminEmail} from "../providers/env.ts";
import {topProviders} from "../domain/mock-data.ts";
import {
  findApprovedCatalogService,
  listApplications,
  listApprovedCatalog,
  ProviderError,
  resetProviderMemory,
  submitApplication,
  updateApplicationStatus,
} from "../providers/service.ts";
import {resetProviderWorkspaceMemory, resolveProviderAccount} from "../provider/service.ts";
import {findCatalogService} from "../bookings/catalog.ts";
import {createMemberBooking, resetBookingMemory} from "../bookings/service.ts";
import {rememberMember, resetPaymentMemory} from "../payments/ledger.ts";
import {resetMemberMemory} from "../auth/members.ts";

function sessionHeaders(email: string, extra: Record<string, string> = {}) {
  return {
    "oai-authenticated-user-id": `chatgpt_${email.replace(/[^a-z0-9]+/gi, "_")}`,
    "oai-authenticated-user-email": email,
    ...extra,
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: "Elena Díaz",
    email: "elena@palmcourt.example",
    phone: "305-555-0148",
    licenseType: "LMT",
    licenseNumber: "MA12345",
    mobileAtHome: true,
    neighborhoods: ["Brickell", "Miami Beach"],
    rateAsk: "$150 / visit",
    insuranceAttested: true,
    notes: "Spanish and English. Hotel work is fine.",
    ...overrides,
  };
}

test("parses live catalog ids and typical visit rates", () => {
  const id = liveServiceId("pa_abc", "deep-tissue");
  assert.deepEqual(parseLiveServiceId(id), {applicationId: "pa_abc", serviceKey: "deep-tissue"});
  assert.equal(rateFromAsk("$150 / visit"), 150);
  assert.equal(rateFromAsk("$100 / visit"), 100);
});

test("submits an individual LMT into the Miami pipeline without secrets", async () => {
  resetProviderMemory();
  const application = await submitApplication(validPayload());
  assert.equal(application.status, "submitted");
  assert.equal(application.fullName, "Elena Díaz");
  assert.equal(application.licenseType, "LMT");
  assert.equal(application.licenseNumber, "MA12345");
  assert.equal(application.mobileAtHome, true);
  assert.deepEqual(application.neighborhoods, ["Brickell", "Miami Beach"]);
  assert.equal(application.docsLicenseProof, "missing");
  assert.equal(application.docsInsurance, "missing");
  const listed = await listApplications({status: "submitted"});
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, application.id);
});

test("rejects an application missing neighborhoods, license, or insurance attestation", async () => {
  resetProviderMemory();
  await assert.rejects(
    () => submitApplication(validPayload({neighborhoods: []})),
    (error: unknown) => error instanceof ProviderError,
  );
  await assert.rejects(
    () => submitApplication(validPayload({licenseNumber: ""})),
    (error: unknown) => error instanceof ProviderError,
  );
  await assert.rejects(
    () => submitApplication(validPayload({insuranceAttested: false})),
    (error: unknown) => error instanceof ProviderError,
  );
});

test("approved individuals appear in the catalog and stay out while under review", async () => {
  resetProviderMemory();
  resetLiveCatalogMemory();
  const application = await submitApplication(validPayload({email: "approved@joinsalu.com"}));
  const empty = await listApprovedCatalog();
  assert.equal(empty.providers.length, 0);

  const approved = await updateApplicationStatus({id: application.id, status: "approved"});
  assert.equal(approved.status, "approved");
  const catalog = await listApprovedCatalog();
  assert.equal(catalog.providers.length, 1);
  assert.equal(catalog.providers[0]?.name, "Elena Díaz");
  assert.equal(catalog.providers[0]?.source, "application");
  assert.ok(catalog.services.some((service) => service.name === "Deep Tissue Massage"));
  assert.equal(catalogFromApplication(application), null);

  const mapped = catalogFromApplication(approved);
  assert.ok(mapped);
  const service = await findApprovedCatalogService(mapped.services[0]!.id);
  assert.equal(service?.provider, "Elena Díaz");
  assert.equal(findCatalogService(mapped.services[0]!.id)?.id, mapped.services[0]!.id);
});

test("filters the review queue by neighborhood, mobile, and missing docs", async () => {
  resetProviderMemory();
  await submitApplication(validPayload({email: "brickell@joinsalu.com", neighborhoods: ["Brickell"], mobileAtHome: true}));
  const clinic = await submitApplication(validPayload({
    email: "clinic@joinsalu.com",
    fullName: "Noah Bennett",
    neighborhoods: ["Miami-Dade"],
    mobileAtHome: false,
    licenseNumber: "MA99999",
  }));
  await updateApplicationStatus({id: clinic.id, docsLicenseProof: "received", docsInsurance: "received"});

  const brickell = await listApplications({neighborhood: "Brickell"});
  assert.equal(brickell.length, 1);
  assert.equal(brickell[0]?.fullName, "Elena Díaz");

  const mobile = await listApplications({mobile: true});
  assert.equal(mobile.length, 1);
  const clinicOnly = await listApplications({mobile: false});
  assert.equal(clinicOnly.length, 1);
  const complete = await listApplications({docs: "complete"});
  assert.equal(complete.length, 1);
  assert.equal(complete[0]?.fullName, "Noah Bennett");
});

test("members can book an approved individual after BD approves", async () => {
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
  assert.equal(result.booking.provider, "Elena Díaz");
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
  const body = await created.json() as {source: string; application: {fullName: string; status: string; docsLicenseProof: string}};
  assert.equal(body.source, "server");
  assert.equal(body.application.status, "submitted");
  assert.equal(body.application.fullName, "Elena Díaz");
  assert.equal(body.application.docsLicenseProof, "missing");

  const catalog = await handleProvidersFetch(new Request("http://localhost/api/providers/catalog"));
  const catalogBody = await catalog.json() as {mockFallback: boolean; providers: unknown[]};
  assert.equal(catalog.status, 200);
  assert.equal(catalogBody.mockFallback, true);
  assert.equal(catalogBody.providers.length, 0);

  const listed = await handleProvidersFetch(new Request("http://localhost/api/providers/applications?neighborhood=Brickell"));
  assert.equal(listed.status, 401);
  const listBody = await listed.json() as {applications?: Array<{email: string}>; error?: string};
  assert.equal(listBody.applications, undefined);
  assert.match(listBody.error ?? "", /Sign in/);
});

test("allowlists staff emails and never treats the demo admin as staff in production", () => {
  assert.equal(isAdminEmail("bd@joinsalu.com", {SALU_ADMIN_EMAILS: "bd@joinsalu.com,ops@joinsalu.com"}), true);
  assert.equal(isAdminEmail("BD@joinsalu.com", {SALU_ADMIN_EMAILS: "bd@joinsalu.com"}), true);
  assert.equal(isAdminEmail("member@joinsalu.com", {SALU_ADMIN_EMAILS: "bd@joinsalu.com"}), false);
  assert.equal(isAdminEmail(DEMO_ADMIN_EMAIL, {NODE_ENV: "development"}), true);
  assert.equal(isAdminEmail(DEMO_ADMIN_EMAIL, {NODE_ENV: "production"}), false);
  assert.equal(isAdminEmail(DEMO_ADMIN_EMAIL, {NODE_ENV: "production", SALU_ADMIN_EMAILS: "bd@joinsalu.com"}), false);
  assert.equal(isAdminEmail("anyone@joinsalu.com", {NODE_ENV: "production"}), false);
});

test("unauthenticated callers cannot list or update the live review queue", async () => {
  resetProviderMemory();
  await submitApplication(validPayload({email: "hidden@joinsalu.com"}));
  const listed = await handleProvidersFetch(new Request("http://localhost/api/providers/applications"));
  assert.equal(listed.status, 401);
  const listBody = await listed.json() as {applications?: unknown[]; error?: string};
  assert.equal(listBody.applications, undefined);
  assert.match(listBody.error ?? "", /Sign in/);

  const denied = await handleProvidersFetch(new Request("http://localhost/api/providers/applications/status", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({id: "pa_missing", status: "approved"}),
  }));
  assert.equal(denied.status, 401);
  const deniedBody = await denied.json() as {applications?: unknown[]; application?: unknown};
  assert.equal(deniedBody.applications, undefined);
  assert.equal(deniedBody.application, undefined);
});

test("signed-in non-admin callers cannot list or update the live review queue", async () => {
  resetProviderMemory();
  resetMemberMemory();
  await submitApplication(validPayload({email: "hidden-member@joinsalu.com"}));
  const env = {SALU_ADMIN_EMAILS: "bd@joinsalu.com"};
  const listed = await handleProvidersFetch(new Request("http://localhost/api/providers/applications", {
    headers: sessionHeaders("member@joinsalu.com"),
  }), env);
  assert.equal(listed.status, 403);
  const listBody = await listed.json() as {applications?: unknown[]; error?: string};
  assert.equal(listBody.applications, undefined);
  assert.match(listBody.error ?? "", /not authorized/i);

  const created = await submitApplication(validPayload({email: "still-hidden@joinsalu.com"}));
  const denied = await handleProvidersFetch(new Request("http://localhost/api/providers/applications/status", {
    method: "POST",
    headers: {...sessionHeaders("member@joinsalu.com"), "Content-Type": "application/json"},
    body: JSON.stringify({id: created.id, status: "approved"}),
  }), env);
  assert.equal(denied.status, 403);
  const deniedBody = await denied.json() as {application?: {status: string}; applications?: unknown[]};
  assert.equal(deniedBody.application, undefined);
  assert.equal(deniedBody.applications, undefined);
});

test("allowlisted admins can list and update the live review queue", async () => {
  resetProviderMemory();
  resetMemberMemory();
  const env = {SALU_ADMIN_EMAILS: "bd@joinsalu.com"};
  const created = await submitApplication(validPayload({email: "queue@joinsalu.com"}));
  const listed = await handleProvidersFetch(new Request("http://localhost/api/providers/applications", {
    headers: sessionHeaders("bd@joinsalu.com"),
  }), env);
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as {applications: Array<{email: string}>; opsOpen: boolean};
  assert.equal(listBody.opsOpen, true);
  assert.equal(listBody.applications.some((row) => row.email === "queue@joinsalu.com"), true);

  const approved = await handleProvidersFetch(new Request("http://localhost/api/providers/applications/status", {
    method: "POST",
    headers: {...sessionHeaders("bd@joinsalu.com"), "Content-Type": "application/json"},
    body: JSON.stringify({id: created.id, status: "approved", docsLicenseProof: "received"}),
  }), env);
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json() as {application: {status: string; docsLicenseProof: string}};
  assert.equal(approvedBody.application.status, "approved");
  assert.equal(approvedBody.application.docsLicenseProof, "received");
});

test("ops secret is an extra lock after the admin session, not a public bypass", async () => {
  resetProviderMemory();
  resetMemberMemory();
  const env = {SALU_ADMIN_EMAILS: "bd@joinsalu.com", SALU_OPS_SECRET: "pipeline-key"};
  const listed = await handleProvidersFetch(new Request("http://localhost/api/providers/applications"), env);
  assert.equal(listed.status, 401);

  const headerOnly = await handleProvidersFetch(new Request("http://localhost/api/providers/applications", {
    headers: {"x-salu-ops": "pipeline-key"},
  }), env);
  assert.equal(headerOnly.status, 401);

  const sessionOnly = await handleProvidersFetch(new Request("http://localhost/api/providers/applications", {
    headers: sessionHeaders("bd@joinsalu.com"),
  }), env);
  assert.equal(sessionOnly.status, 401);

  const opened = await handleProvidersFetch(new Request("http://localhost/api/providers/applications", {
    headers: {...sessionHeaders("bd@joinsalu.com"), "x-salu-ops": "pipeline-key"},
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
    headers: {...sessionHeaders("bd@joinsalu.com"), "Content-Type": "application/json", "x-salu-ops": "pipeline-key"},
    body: JSON.stringify({id: created.id, status: "approved", docsLicenseProof: "received"}),
  }), env);
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json() as {application: {status: string; docsLicenseProof: string}};
  assert.equal(approvedBody.application.status, "approved");
  assert.equal(approvedBody.application.docsLicenseProof, "received");
});

test("approving an application provisions a provider account matched by email on sign-in", async () => {
  resetProviderMemory();
  resetProviderWorkspaceMemory();
  const application = await submitApplication(validPayload({email: "workspace@joinsalu.com"}));
  assert.equal(await resolveProviderAccount({email: "workspace@joinsalu.com"}), null);

  const approved = await updateApplicationStatus({id: application.id, status: "approved"});
  const account = await resolveProviderAccount({email: "WORKSPACE@joinsalu.com"});
  assert.ok(account);
  assert.equal(account.email, "workspace@joinsalu.com");
  assert.equal(account.id, `prov_app_${approved.id}`);
  assert.equal(account.status, "approved");
  assert.equal(account.practiceId, approved.id);
  assert.equal(account.practiceName, "Elena Díaz");
  assert.deepEqual(
    account.serviceIds,
    ["deep-tissue", "sports-massage", "lymphatic-massage"].map((key) =>
      liveServiceId(approved.id, key),
    ),
  );
});

test("request-info moves an application to under review with a required note", async () => {
  resetProviderMemory();
  const application = await submitApplication(validPayload({email: "info@joinsalu.com"}));

  await assert.rejects(
    () => updateApplicationStatus({id: application.id, action: "request-info"}),
    (error: unknown) => error instanceof ProviderError,
  );
  await assert.rejects(
    () => updateApplicationStatus({id: application.id, action: "request-info", reviewNote: "   "}),
    (error: unknown) => error instanceof ProviderError,
  );
  await assert.rejects(
    () => updateApplicationStatus({id: application.id, action: "bogus"}),
    (error: unknown) => error instanceof ProviderError,
  );

  const moved = await updateApplicationStatus({
    id: application.id,
    action: "request-info",
    reviewNote: "Send your Florida license proof.",
  });
  assert.equal(moved.status, "under_review");
  assert.equal(moved.reviewNote, "Send your Florida license proof.");
  const catalog = await listApprovedCatalog();
  assert.equal(catalog.providers.length, 0);
});

test("request-info works through the admin status endpoint", async () => {
  resetProviderMemory();
  resetMemberMemory();
  const env = {SALU_ADMIN_EMAILS: "bd@joinsalu.com"};
  const created = await submitApplication(validPayload({email: "queue-info@joinsalu.com"}));
  const res = await handleProvidersFetch(new Request("http://localhost/api/providers/applications/status", {
    method: "POST",
    headers: {...sessionHeaders("bd@joinsalu.com"), "Content-Type": "application/json"},
    body: JSON.stringify({id: created.id, action: "request-info", reviewNote: "Insurance docs, please."}),
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json() as {application: {status: string; reviewNote: string}};
  assert.equal(body.application.status, "under_review");
  assert.equal(body.application.reviewNote, "Insurance docs, please.");
});

test("demo seed catalog gives every provider a bio and a plausible weekly pattern", () => {
  assert.ok(topProviders.length >= 6, "launch story needs a real bench of providers");
  const areas = new Set(topProviders.map((provider) => provider.area));
  assert.ok(areas.has("Brickell"));
  assert.ok(areas.has("Wynwood") || areas.has("Doral") || areas.has("South Beach"));
  for (const provider of topProviders) {
    assert.ok(provider.bio && provider.bio.length > 40, `${provider.id} needs a bio`);
    assert.ok(Array.isArray(provider.availability) && provider.availability.length > 0, `${provider.id} needs weekly availability`);
    for (const window of provider.availability ?? []) {
      assert.ok(Number.isInteger(window.dayOfWeek) && window.dayOfWeek >= 0 && window.dayOfWeek <= 6);
      assert.match(window.start, /^\d{2}:\d{2}$/);
      assert.match(window.end, /^\d{2}:\d{2}$/);
      assert.ok(window.start < window.end, "window starts before it ends");
    }
    assert.ok(provider.rating >= 4.5 && provider.reviews > 0);
  }
  const specialties = new Set(topProviders.flatMap((provider) => provider.focuses));
  assert.ok([...specialties].some((focus) => /deep tissue/i.test(focus)));
  assert.ok([...specialties].some((focus) => /sports/i.test(focus)));
  assert.ok([...specialties].some((focus) => /prenatal/i.test(focus)));
  assert.ok([...specialties].some((focus) => /stretch/i.test(focus)));
});

test("application submit rejects bad email, missing name, and runaway rate asks", async () => {
  resetProviderMemory();
  await assert.rejects(
    () => submitApplication(validPayload({email: "not-an-email"})),
    (error: unknown) => error instanceof ProviderError && /email/i.test(error.message),
  );
  await assert.rejects(
    () => submitApplication(validPayload({fullName: "   "})),
    (error: unknown) => error instanceof ProviderError && /name/i.test(error.message),
  );
  await assert.rejects(
    () => submitApplication(validPayload({rateAsk: "$1000 / visit plus travel and a very long explanation of rates and logistics and everything"})),
    (error: unknown) => error instanceof ProviderError && /rate ask/i.test(error.message),
  );
});

test("approved catalog providers carry a bio and availability", async () => {
  resetProviderMemory();
  resetLiveCatalogMemory();
  const application = await submitApplication(validPayload({email: "bio@joinsalu.com", notes: "Bilingual — English and Spanish."}));
  await updateApplicationStatus({id: application.id, status: "approved"});
  const catalog = await listApprovedCatalog();
  const provider = catalog.providers[0];
  assert.ok(provider?.bio?.includes("Bilingual"));
  assert.ok(Array.isArray(provider?.availability) && (provider?.availability?.length ?? 0) > 0);
});

test("approving with docs still missing warns BD in the status response", async () => {
  resetProviderMemory();
  resetMemberMemory();
  const env = {SALU_ADMIN_EMAILS: "bd@joinsalu.com"};
  const created = await submitApplication(validPayload({email: "warn@joinsalu.com"}));
  const res = await handleProvidersFetch(new Request("http://localhost/api/providers/applications/status", {
    method: "POST",
    headers: {...sessionHeaders("bd@joinsalu.com"), "Content-Type": "application/json"},
    body: JSON.stringify({id: created.id, status: "approved"}),
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json() as {warning?: string; application: {status: string}};
  assert.equal(body.application.status, "approved");
  assert.match(body.warning ?? "", /license proof.*insurance proof|insurance proof.*license proof/);

  const docsDone = await submitApplication(validPayload({email: "clean@joinsalu.com"}));
  await updateApplicationStatus({id: docsDone.id, docsLicenseProof: "received", docsInsurance: "received"});
  const clean = await handleProvidersFetch(new Request("http://localhost/api/providers/applications/status", {
    method: "POST",
    headers: {...sessionHeaders("bd@joinsalu.com"), "Content-Type": "application/json"},
    body: JSON.stringify({id: docsDone.id, status: "approved"}),
  }), env);
  const cleanBody = await clean.json() as {warning?: string};
  assert.equal(cleanBody.warning, undefined);
});

test("rejected providers lose workspace access after approval", async () => {
  resetProviderMemory();
  resetProviderWorkspaceMemory();
  const application = await submitApplication(validPayload({email: "revoked@joinsalu.com"}));
  await updateApplicationStatus({id: application.id, status: "approved"});
  const account = await resolveProviderAccount({email: "revoked@joinsalu.com"});
  assert.ok(account);
  assert.equal(account.status, "approved");

  await updateApplicationStatus({id: application.id, status: "rejected"});
  assert.equal(await resolveProviderAccount({email: "revoked@joinsalu.com"}), null);
});
