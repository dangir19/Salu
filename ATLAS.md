# Atlas

Atlas is Salu’s wellness concierge. It coordinates independent Miami marketplace services. It is **not** a physician and does not diagnose, prescribe, or replace emergency care.

The chat path is a **structured tool layer**, not free-form booking. Atlas discovers services, reads catalog availability windows, and creates reservations through the same booking service as `POST /api/bookings`. When a language-model key is absent, a deterministic planner still runs those tools.

## Safety

| Signal | Behavior |
| --- | --- |
| Emergency language (chest pain, can’t breathe, fainting, …) | No tools. Tell the member to call **911**. Never book. |
| Diagnosis / prescribing language | Refuse clinical advice. Offer general wellness coordination only. |
| Ordinary booking / education | Discover, check windows, and book only through tools. |

The composer and footer repeat: Atlas shares general information, does not diagnose or prescribe, and emergencies go to 911.

## Tools

| Tool | What it does |
| --- | --- |
| `discover_services` | Search the Miami catalog (`domain/mock-data.ts`). Never invent a service. |
| `check_availability` | Return open windows from the catalog (`service.next` plus matching provider demo openings). Not a held-slot table. |
| `create_booking` | Same persistence path as `/api/bookings` (`createMemberBooking`). |

## Planner

| Mode | When |
| --- | --- |
| **Deterministic** | Default. No secrets required. Intent + catalog tools. |
| **OpenAI** | Optional. Set `OPENAI_API_KEY` (and optional `OPENAI_MODEL`, default `gpt-4o-mini`). Failures fall back to the deterministic planner. |

`GET /api/atlas` reports the active planner and tool names. Tests never call a live model.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/atlas` | Planner, tools, `/appointments` deep-link. |
| `POST` | `/api/atlas` | Body: `message`, optional `history`, `pending`, `entitlements`, `planId`. |

The Worker intercepts `/api/atlas` (same pattern as auth, payments, and bookings).

### Persistence

| Session | Result |
| --- | --- |
| Signed-in member | `create_booking` writes through the booking service (D1 when `DB` is bound, otherwise in-process). That also opens an assignable provider request ([PROVIDER.md](./PROVIDER.md)). The chat confirmation card deep-links to **Appointments**. |
| No session | Tools still discover and read windows. `create_booking` returns a labeled **demo** reservation for the client to keep in `localStorage`. |

A local preview session (development bypass) is a real member session, so Atlas bookings persist like any other `/api/bookings` confirm.

## Environment

| Key | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | No | Enables the optional language-model planner. |
| `OPENAI_MODEL` | No | Defaults to `gpt-4o-mini`. |

Copy `.env.example` to `.env` or `.dev.vars`. You do **not** need an OpenAI key to compile, lint, or test.

On the Cloudflare Worker, paste `OPENAI_API_KEY` as a secret if you want the model path in production. Provider Connect and Cloudflare DNS cutover are out of scope here.

## Still demo

- Availability inventory remains the Miami catalog, not a held-slot table.
- Package remaining-session counts still live in the browser unless the client sends `entitlements`.
- Provider names, credentials, and openings stay fabricated prototype data.
- Atlas does not review live credentials, process insurance, or store medical records.
