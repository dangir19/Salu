import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const app = await readFile(new URL("../components/SaluApp.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const atlasMd = await readFile(new URL("../ATLAS.md", import.meta.url), "utf8");
const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("wires Atlas chat to the tool API and confirmation card", () => {
  for (const term of [
    "/api/atlas",
    "applyAtlasBooking",
    "atlas-confirm-card",
    "View appointments",
    "go(\"bookings\")",
    "does not diagnose or prescribe",
    "Emergencies: call 911",
  ]) {
    assert.match(app, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(worker, /\/api\/atlas/);
});

test("documents the deterministic planner, safety, and optional OpenAI path", () => {
  for (const term of [
    "discover_services",
    "check_availability",
    "create_booking",
    "911",
    "does not diagnose",
    "OPENAI_API_KEY",
    "deterministic",
    "/api/bookings",
    "/appointments",
  ]) {
    assert.match(atlasMd, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(example, /OPENAI_API_KEY/);
  assert.match(readme, /ATLAS\.md/);
});
