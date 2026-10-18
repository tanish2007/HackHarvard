# Relay

When a wildfire starts, residents, volunteers, and firefighters are on three different systems. Alerts get missed, and the people who go quiet are the ones nobody checks on.

Relay is one AI agent with a real phone number. Residents and volunteers text it. If someone does not answer, Relay calls them and walks them to a shelter. Firefighters talk to it over a GMRS radio. Everyone, the fire, and the shelters show up on one live map.

Built in 36 hours at HackHarvard 2026 by a team of four.

| | |
| --- | --- |
| Text | iMessage through Photon |
| Voice | Phone calls through Photon and ElevenLabs |
| Radio | A phone on speaker next to a GMRS radio. Say "Relay" and it answers |
| Map | Live dashboard of the fire, shelters, people, and the timeline |
| AI | Gemini, with fixed replies when the model is slow or out of quota |
| Data | NASA FIRMS fires, National Weather Service wind, walking routes, and shelters |
| Demo | The Oak Ridge Fire, staged near Harvard, plus live NASA fires that never start a call |
| Tests | 676 automated tests in 54 files. Live model checks stay in a separate command |

## Contents

- [Why we built it](#why-we-built-it)
- [What makes it different](#what-makes-it-different)
- [How an evacuation works](#how-an-evacuation-works)
- [Architecture](#architecture)
- [Libraries and technologies](#libraries-and-technologies)
- [Run it locally](#run-it-locally)
- [Try it in the browser](#try-it-in-the-browser)
- [API endpoints](#api-endpoints)
- [The scenario](#the-scenario)
- [Testing](#testing)
- [Scripts](#scripts)
- [Operating notes](#operating-notes)
- [Project layout](#project-layout)
- [What's next](#whats-next)
- [The people behind it](#the-people-behind-it)

## Why we built it

A resident who needs a way out, a volunteer who can help, and a firefighter who needs a route are usually looking at three different tools. None of them sees the others.

At the same time, an agent that can call people has to know when to stop. Calling 911 on its own would send false alarms onto a real emergency line.

Relay does both jobs. It puts the fire, the people, and the shelter walk on one map, and it will not call the emergency contact until a person on the dashboard says yes.

## What makes it different

- **One agent, no app.** People already have iMessage and a phone. Relay lives there. There is no account and no install.
- **The agent proposes, the timers decide.** Gemini writes the reply. If it times out or the quota is used up, a fixed reply still tells the person which way to walk. The check-in clock does not depend on the model.
- **A missed call is not the same as a person who picked up.** Relay calls the resident first. If they are on the line, the family phone stays quiet. Family is called only after a missed pickup or voicemail. The firefighter unit is called only after the family call fails the same way.
- **Relay never dials 911 by itself.** The firefighter number is a scenario phone (Unit 4). The emergency contact is called only when a human presses confirm on the map.
- **The walk uses the person's real point.** A check-in says the nearest shelter, the direction, the walking time, and the first step. Later replies say whether the last move was toward that shelter or the wrong way.
- **Live fires stay separate from the incident.** NASA satellite detections draw on the map with a wind-driven spread forecast. They do not text or call anyone. The staged Oak Ridge Fire is what starts the demo.
- **The radio stays quiet unless it is asked.** A spare phone sits next to the GMRS radio. Relay answers only when it hears "Relay" first.
- **Fakes and live data share one shape.** Shelters, routes, hazards, and weather can come from the scenario or from FIRMS, NWS, OSRM, and OpenStreetMap. If a live call fails, Core falls back and marks the source. The map does not go blank because one API was slow. Fire rows are the exception: in real mode they are NASA detections or an empty list, never a fake fire pretending to be live.

## How an evacuation works

1. **Send the fire alert.** `POST /admin/alert` loads the staged fire and texts each resident in range. The text names the shelter and the route. The map starts polling.
2. **Wait for a reply.** Safe, help, or a normal message updates that person. `STOP` takes them off the map. If they share a live location, later directions use that point.
3. **Call if they go quiet.** After `checkin_timeout_sec` with no word (10 seconds in the demo scenario), Relay calls them. The opening line includes the walk from their coordinates.
4. **Stay with them if they pick up.** While the call is connected, the family phone is not dialed. If they move, the next reply says whether that move was the right way, then gives the next step.
5. **Call family, then the firefighter.** If the resident does not pick up, or the line is voicemail, Relay waits `escalation_timeout_sec` and calls their family contact. If that call is cut off or goes to voicemail, it waits again, calls Unit 4, and marks the resident SOS.
6. **A person confirms the last call.** The confirm button on the map is the only path to the emergency contact. That number is a teammate's phone for the demo, labeled as 911.

Any real reply from the resident, or from the family contact on that call, stops the chain.

## Architecture

```
iMessage  ->  Text   ->  POST /event  ->  Core  ->  actions  ->  Text sends the message
phone     ->  Voice  ->  POST /event  ->  Core  ->  spoken reply on the open call
radio     ->  Voice  ->  POST /event  ->  Core  ->  spoken reply, or silence
Core timers --------->  POST /actions on Text and Voice (alerts and outbound calls)
Map <---- GET /state every 2 seconds ---- Core
Core <---- shelters, routes, hazards, weather ---- Map server (or the scenario fallback)
```

Core is the brain. It keeps the incident in memory, runs Gemini when a key is set, and owns the check-in clocks. Text and Voice never decide policy. They deliver what Core asks for, and they send back what the person said.

The map server is also the data server. With `DATA_URL` set, Core asks it for Contract C. Without it, Core answers from `scenario.json`.

One decision links a person's status, the timeline line, and the call. Restarting Core clears the incident. Send the alert again.

### Who enforces what

| Step | Enforced by | What it stops |
| --- | --- | --- |
| Alert radius | Core watcher | Texting people who are outside the fire area |
| Check-in timer | Core escalation | Leaving a quiet resident uncalled |
| Pickup | Voice, pinging Core while the call is live | Calling the family while the resident is still on the phone |
| Family and firefighter timers | Core escalation | Skipping a step, or calling Unit 4 before the family call has failed |
| Emergency contact | Dashboard confirm, then Core | Relay dialing that number on its own |
| Keyword replies | Text and Core | Waiting on Gemini for `STOP`, `SOS`, or "I am safe" |
| Route | Data functions | A path that ignores the fire, and a driving route given to someone on foot |
| Live NASA fires | Core live-fire feed | Treating a satellite detection as this incident |

## Libraries and technologies

| Layer | Technology | Role |
| --- | --- | --- |
| Core | Node.js 20+, Express 4, TypeScript | `/event`, `/state`, the agent, and the check-in clocks |
| Agent | Gemini via `@google/genai` | Tool calls for hazards, routes, shelters, weather, and live fires |
| State | In-memory store | People, volunteers, units, hazards, reports, timeline, counts |
| Text | Photon Spectrum, iMessage | Inbound texts, outbound alerts, Find My location |
| Voice | Photon SIP, ElevenLabs | Outbound check-in calls and the radio patch |
| Data | Python | FIRMS, NWS, OSRM, OpenStreetMap shelters |
| Fire model | Rothermel, in Core | Spread forecast from fuel, moisture, and wind |
| Map | Leaflet, plain HTML, CSS, and JavaScript | The screen the demo watches |
| Tests | Vitest, supertest, Node's test runner, Python unittest | Core, Voice, Text, and the data contract |

## Run it locally

You need Node.js 20 or newer, npm, and Python 3. Phone calls also need a Photon number, an ElevenLabs agent, and a public tunnel. The map and Core run without those.

```sh
git clone https://github.com/tanish2007/HackHarvard.git
cd HackHarvard
npm install
cp .env.example .env
```

In `.env`, set at least:

```sh
DATA_URL=http://localhost:8080
TEXT_ACTIONS_URL=http://localhost:3002/actions
VOICE_ACTIONS_URL=http://localhost:3001/actions
```

`GEMINI_API_KEY` turns the agent on. Without it, keyword replies still run.

Copy real phone numbers into `scenario.local.json` (start from `scenario.local.example.json`). That file is gitignored. `scenario.json` keeps fictional `555-01xx` numbers.

Text and Voice have their own env files:

```sh
cp text/.env.example text/.env
cp voice/.env.example voice/.env
cd text && npm install
cd ../voice && npm install
```

Start four processes, each in its own terminal, from the repo root unless noted:

```sh
npm start
python3 dashboard/server.py
cd text && npm start
cd voice && npm start
```

| Process | Address |
| --- | --- |
| Core | http://localhost:3000 |
| Map and data | http://localhost:8080 |
| Text | http://localhost:3002 |
| Voice | http://localhost:3001 |

Then open the map and send the alert:

```sh
curl -X POST http://localhost:3000/admin/alert
```

For a real call, the voice server has to be reachable by ElevenLabs. From `voice/`:

```sh
npm run tunnel
```

That starts a Cloudflare tunnel, waits until it reaches Voice, and points the ElevenLabs agents at it. Leave it running. A free tunnel gets a new address each time, and the call drops after the opening line if this step is skipped.

`DATA_MODE=fake` on the map server reads `scenario.json`. `DATA_MODE=real` calls FIRMS, NWS, OSRM, and OpenStreetMap. Core's own fallback is the scenario whenever `DATA_URL` is down.

### Environment variables

`.env.example`, `text/.env.example`, and `voice/.env.example` explain each name. This table lists names only.

| Area | Variables | Needed for |
| --- | --- | --- |
| Core | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `AGENT_TIMEOUT_MS` | Real replies, and a second model when the first one is rate limited |
| Data | `DATA_MODE`, `DATA_URL`, `FIRMS_MAP_KEY`, `LIVE_FIRES_URL` | Live fires, weather, routes, and shelters |
| Text | `PROJECT_ID`, `PROJECT_SECRET`, `CORE_URL`, `FINDMY_OVERRIDE` | iMessage, and posting Find My over the scenario pin |
| Voice | `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_RADIO_AGENT_ID`, `VOICE_LLM_SECRET`, `PHOTON_SIP_*` | Calls and the radio |
| Admin | `RELAY_ADMIN_TOKEN` | Locking `/admin` and the confirm button when Core is on a public URL |

## Try it in the browser

| URL | What it shows |
| --- | --- |
| http://localhost:8080 | The map: fire, spread, shelters, people, timeline, and the confirm button |
| http://localhost:3000/state | The live incident Core is serving |
| http://localhost:3000/health | Core is up, and which incident is loaded |
| http://localhost:8080/backup-state.json | The last saved picture, if the network dies on stage |

The demo people in `scenario.json`:

| Who | Role | What they are for |
| --- | --- | --- |
| Amit | Resident, English | The check-in call and the walking guide |
| Priya | Family contact, Gujarati | Called only if Amit does not pick up. She starts outside the fire |
| Sam | Volunteer | A second real phone on the text side |
| Unit 4 | Firefighter | Called if Priya's line fails. Not 911 |
| Emergency contact | Teammate's phone | Called only after confirm on the map |
| 48 simulated residents | Map population | Counts on the dashboard. They are not real phones |

## API endpoints

Core answers JSON. If `RELAY_ADMIN_TOKEN` is set, admin and escalation routes need the `x-relay-admin` header.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Liveness. Returns the incident name |
| GET | `/state` | The picture the map polls every 2 seconds |
| POST | `/event` | One text, call, or radio turn in. Actions out |
| POST | `/escalations/:person_id/live` | Voice says this person picked up |
| POST | `/escalations/:person_id/ended` | Voice says the call ended without an answer |
| POST | `/escalations/:person_id/confirm` | A human confirms the emergency-contact call |
| POST | `/admin/alert` | Start the staged fire and text residents in range |
| POST | `/admin/alert/:person_id` | Alert one resident, even if they are outside the radius |
| POST | `/admin/clear-fire` | Take the staged fire off the map. People and the timeline stay |
| POST | `/admin/reset` | Back to the scenario, so the demo can run again |

`GET /state` always includes `incident`, `hazards`, `shelters`, `people`, `volunteers`, `reports`, `units`, `timeline`, and `counts`. `people[].status` is `safe`, `unconfirmed`, `sos`, or `en_route`. `counts` has those four. `last_contact` may be `null`. Empty lists are `[]`.

`POST /event` takes:

```json
{
  "event_id": "evt_123",
  "channel": "imessage",
  "person_id": "p_amit",
  "from": "+15551234567",
  "text": "I need help",
  "location": { "lat": 42.374, "lng": -71.1175 },
  "media_url": null,
  "timestamp": "2026-10-18T14:02:00Z"
}
```

`channel` is `imessage`, `sms`, `voice`, or `radio`. `location` and `media_url` may be `null`. A bad body is `400`. A good one is `200` with `{ "actions": [...] }`.

Actions are `send_text`, `place_call`, or `say`. `say` speaks on the call that is already open. A channel that does not support an action logs it and continues.

The map server, on port 8080, also serves the data functions: `/hazards`, `/shelters`, `/route`, `/weather`, `/firms`, and `/live-weather`.

## The scenario

`scenario.json` is the only committed place for the incident name, the fire, the shelters, and the demo people. Real numbers belong in `scenario.local.json`, which overrides it and is not committed.

| Setting | Demo value | What it changes |
| --- | --- | --- |
| `checkin_timeout_sec` | 10 | How long Relay waits before calling the resident |
| `escalation_timeout_sec` | 10 | How long it waits before family, and again before Unit 4 |
| `alert_radius_km` | 4 | Who gets the first text |
| `alerts` | `manual` | Nothing sends until `POST /admin/alert` |
| `wake_phrase` | `relay` | The radio answers only after this word |
| `extra_fires` | Mount Ida | A second staged fire near a live Find My pin |
| `live_fires` | on, every 10 min | NASA detections and spread, read only |

Languages with fixed replies: English, Spanish, Mandarin, Gujarati, and Hindi. Anything else falls back to English.

## Testing

```sh
npm test                 # Core and Voice (Vitest)
cd text && npm test      # Text
python3 -m unittest discover -s tests
npm run typecheck
```

`npm test` does not call Gemini or the public fire APIs. `npm run test:live` runs the agent checks that do call Gemini, one at a time, so they stay under the free-tier limit.

| Area | What it covers |
| --- | --- |
| Event handling | Safe, SOS, routes, walking directions, and "right way" or "wrong way" |
| Escalation | No family call while the resident is on the phone. Family, then Unit 4, then a human confirm |
| State | Counts, empty lists, reset, and the live-fire rows beside the incident |
| Fire model | Spread rate, perimeter, and the forecast minutes |
| Data contract | Fake and real shapes for hazards, routes, shelters, and weather |
| Text | Alerts, STOP, SOS, location, and Find My posts |
| Voice | Outbound calls, the radio wake word, and the tunnel URL |

## Scripts

| Command | Where | What it does |
| --- | --- | --- |
| `npm start` | repo root | Core on port 3000 |
| `npm run dev` | repo root | Core with reload |
| `npm test` | repo root | Vitest, no network |
| `npm run test:live` | repo root | Gemini agent checks |
| `npm run typecheck` | repo root | TypeScript |
| `python3 dashboard/server.py` | repo root | Map and data on port 8080 |
| `npm start` | `text/` | iMessage bot |
| `npm run findmy-check` | `text/` | See whether Find My is connected |
| `npm start` | `voice/` | Voice server on port 3001 |
| `npm run tunnel` | `voice/` | Public URL, and point ElevenLabs at it |
| `npm run ring` | `voice/` | Place one test call |
| `npm run radio` | `voice/` | Call the phone that sits by the radio |

## Operating notes

**Send the alert again after a restart.** Core keeps the incident in memory. A restart wipes it. `POST /admin/reset` does the same on purpose, so the demo can run twice.

**The tunnel has to stay up.** ElevenLabs plays the opening line from the outbound payload. Later turns need the public URL. If the tunnel dies, the call ends after that first sentence.

**Gemini's free tier is 15 requests a minute** on the default model. When it is exhausted, the caller hears the short fallback line plus the shelter walk. `GEMINI_FALLBACK_MODELS` tries another model. `AGENT_TIMEOUT_MS` is how long Core waits before that fallback. Keep Voice's `VOICE_CORE_TIMEOUT_MS` above it.

**Find My.** Set `FINDMY_OVERRIDE=1` in `text/.env` when the demo should follow the phone instead of the pin in `scenario.json`. The text process reposts the latest point so a Core restart still catches it.

**Foot routes.** Residents get a walking route. Responders get a driving route. Spoken minutes assume the data server is up. The scenario fallback uses a faster default speed, so the minutes can be short if `DATA_URL` is down.

**Phones.** Do not put a real number in `scenario.json`. Put it in `scenario.local.json`. Unit 4 and the emergency contact may share one demo phone. Everyone else needs a unique number.

**Do not commit** `.env`, `text/.env`, `voice/.env`, or `scenario.local.json`.

## Project layout

```
server.ts            Core's entry point
scenario.json        The incident, the people, and the demo timers
core/src
  agent/             Gemini loop, tools, and the prompt
  alerts/            Who gets the fire text
  escalation/        Check-in, family, firefighter, and confirm
  event/             One inbound turn, and the fixed replies
  fire/              Spread model and the live NASA feed
  state/             The incident store behind GET /state
  data/              HTTP client for the map server, and the scenario fallback
dashboard/           The map, and the HTTP API for Contract C
data/                FIRMS, NWS, OSRM, and shelters
text/                iMessage, alerts, and Find My
voice/               Calls, the radio, and the tunnel
tests/               Python tests for the data contract
prd.md               The original spec and the handoff contracts
```

## What's next

- Let each household run its own agent, and roll status up to the county.
- Keep the radio path working when the cell network is down. Texts already last longer than data. A full mesh is future work.
- Host Core and the map on a stable URL, so the voice tunnel is not a new address every restart.
- A human review step before a live NASA fire can ever start an alert. Today those fires are draw-only.

## The people behind it

| Teammate | What they built |
| --- | --- |
| Tirth | The agent, the incident store, `/event` and `/state`, escalation rules, and the fire spread model |
| Tanish Gupta | iMessage through Photon: opt-in, alerts, SOS and STOP, and Find My |
| Junaid Pathan | Phone calls and the radio patch: check-in, family, the firefighter unit, and the tunnel |
| Rudra Patel | FIRMS, weather, walking routes, shelters, and the live map |

The original product spec, the demo script, and the five handoff contracts are in `prd.md`.
