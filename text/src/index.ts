import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { createActionsServer } from "./actionsServer.js";
import { postEvent } from "./coreClient.js";
import { FindMyTracker } from "./findmy.js";
import { openPhotonLocationSource } from "./findmyPhoton.js";
import { publishFindMyLocation, sweepFindMy } from "./findmyPush.js";
import { LOCATING_NOTE, LOCATION_HINT } from "./handler.js";
import { interpretContent, type IncomingContent } from "./incoming.js";
import { loadDirectory, normalizePhone } from "./people.js";
import { Registry } from "./registry.js";
import { findMyFor, processText, type RelayDeps } from "./relay.js";

const coreUrl = process.env.CORE_URL || "http://localhost:3000";
// Saved next to the project, so a restart keeps everyone who has signed up.
const registryFile =
  process.env.REGISTRY_FILE || join(dirname(fileURLToPath(import.meta.url)), "..", "data", "registry.json");
const deps: RelayDeps = {
  registry: new Registry(registryFile),
  directory: loadDirectory(),
  postEvent: (event) => postEvent(event, { coreUrl }),
};
console.log(`[text] sending events to ${coreUrl}`);

// Live Find My locations, for people who share with the line. Set FINDMY=0 to
// turn it off. Scenario people keep their scenario location unless
// FINDMY_OVERRIDE=1, so the demo's fire and map stay consistent.
if (process.env.FINDMY !== "0") {
  const tracker = new FindMyTracker({
    open: () => openPhotonLocationSource(process.env.PROJECT_ID!, process.env.PROJECT_SECRET!),
    onConnect: () => {
      void sweepFindMy(deps);
    },
    onUpdate: (handle, location) => {
      void publishFindMyLocation(deps, handle, location);
    },
  });
  deps.findMy = tracker;
  deps.findMyOverridesScenario = process.env.FINDMY_OVERRIDE === "1";
  tracker.start();
  // Ask again on a timer. The live feed only talks when Apple sends a point,
  // and a remembered point is trusted for ten minutes, so a person can move
  // without Core hearing about it. Fifteen seconds is often enough to catch
  // a new fix without asking the line on every map refresh.
  setInterval(() => {
    void sweepFindMy(deps);
  }, 15_000);
}

// Spectrum bridges a single agent loop to many messaging interfaces.
// Each provider in `providers` adds an interface (terminal TUI, iMessage, …).
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [
    // imessage
    imessage.config(),
  ],
});

// Core pushes alerts here. They go to people who may never have texted first,
// so each one opens a conversation with the phone number instead of replying.
const textPort = Number(process.env.TEXT_PORT) || 3002;
createActionsServer({
  registry: deps.registry,
  directory: deps.directory,
  sendTo: async (phone, text) => {
    const space = await imessage(app).space.create(phone);
    await space.send(text);
  },
}).listen(textPort, () => console.log(`[text] accepting pushed actions on http://localhost:${textPort}/actions`));

// `app.messages` is an async iterable. Each tick yields a `space` (the
// conversation) and an inbound `message`. Reply by awaiting `space.send(...)`.
for await (const [space, message] of app.messages) {
  const phone = normalizePhone(message.sender?.id ?? "");
  console.log("incoming", message.platform, phone, message.content.type);
  if (!phone) continue;

  try {
    const incoming = await interpretContent(message.content as unknown as IncomingContent);
    if (incoming.kind === "ignore") continue;
    if (incoming.kind === "unreadable_location") {
      // Apple's "Share My Location" arrives as a message we cannot decode, but
      // it is also a Find My share. Use their live location if it has come
      // through, and otherwise say it is on its way.
      const found = await findMyFor(deps, phone, 5000);
      if (found) {
        await processText(deps, phone, "", async (reply) => void (await space.send(reply)), { location: found });
      } else {
        await space.send(deps.findMy ? LOCATING_NOTE : LOCATION_HINT);
      }
      continue;
    }
    await processText(
      deps,
      phone,
      incoming.text,
      async (reply) => {
        await space.send(reply);
      },
      { location: incoming.location },
    );
  } catch (err) {
    // One bad message must not stop the bot from reading the next one.
    console.error(`[text] failed to handle a message from ${phone}:`, err);
  }
}
