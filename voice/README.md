# Voice lane

Photon carries the phone line over SIP. ElevenLabs hears the caller and speaks. Core decides what to say. This server connects ElevenLabs to Core.

```
caller -> Photon number -> ElevenLabs -> /llm endpoint (this server) -> Core /event
                                      <- spoken reply <---------------- Core actions
Core -> POST /actions (this server) -> ElevenLabs outbound call -> phone
```

## Run it

1. `cd voice && npm install`
2. Copy `.env.example` to `.env` and fill it in. Never commit `.env`.
3. Start Core from the repo root (`npm start`), then Voice (`cd voice && npm start`, port 3001).
4. Put `VOICE_ACTIONS_URL=http://localhost:3001/actions` in the root `.env` so Core can push calls here.
5. Expose port 3001 with a tunnel, for example `cloudflared tunnel --url http://localhost:3001`. The address changes each restart.
6. Place a test call: `RING_PERSON_ID=p_amit npm run ring` (rings `TEST_CALL_TO`). Set `RING_SCRIPT` to change the opening line.

## ElevenLabs agent settings that must be right

- **LLM:** Custom LLM. Server URL is `https://<tunnel>/llm/<VOICE_LLM_SECRET>/v1`. ElevenLabs adds `/chat/completions` itself, so the `/v1` must be in the URL. Model ID is `relay`. Leave the API key as None, the secret in the URL is the protection.
- **Overrides:** turn on **First message** and **Language** under the agent's Security or Settings. Without First message every call is dropped after one second with "Override for field 'first_message' is not allowed by config". Language is needed so a call can run in the person's language.
- **System prompt:** the first line must be `RELAY_CALL person_id={{person_id}} caller_number={{caller_number}}`. The server reads who the call is about from it.
- **Backup LLMs:** set to Disabled while testing. Otherwise a failure silently falls back to a generic model that never talks to Core.
- **Radio agent (separate agent):** Model ID `relay-radio`, and the `skip_turn` system tool enabled. When Core returns nothing, the server asks the agent to skip its turn so Relay stays quiet.
- **Languages:** Core supports en, es, zh, gu and hi. Add each language you want to the agent and use a multilingual voice. `ELEVENLABS_LANGUAGES` (default `es,gu,hi`) lists the ones the agent has, and a call to a person in one of them runs in their language, read from Core's `GET /state`. English and anything not listed use the agent's default. Gujarati works but sounds less natural than Hindi or Spanish.

## Photon and ElevenLabs trunk

- Photon, Voice, Outbound calls: enable outbound with SHA-256. The password is shown once.
- ElevenLabs, Phone Numbers, import from SIP trunk: outbound address `sip.photon.codes:5061`, TLS, media encryption Allowed, codecs G.722, PCMU, PCMA, and the Photon outbound username and password. Assign the agent to the number.

## Debugging a failed call

Read the conversation record from ElevenLabs. Its `termination_reason` says why a call ended:

```
curl -s "https://api.elevenlabs.io/v1/convai/conversations?agent_id=$ELEVENLABS_AGENT_ID&page_size=1" -H "xi-api-key: $ELEVENLABS_API_KEY"
```

## Endpoints

- `POST /actions`: Core pushes `place_call` here. Answers 200 only if every call was requested, 502 if any failed.
- `POST /llm/:secret/v1/chat/completions`: ElevenLabs custom LLM. Streams server-sent events.
- `GET /health`.
