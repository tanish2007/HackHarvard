import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { postEvent } from "./coreClient.js";
import { loadDirectory } from "./people.js";
import { Registry } from "./registry.js";
import { processText, type RelayDeps } from "./relay.js";

const coreUrl = process.env.CORE_URL || "http://localhost:3000";
const deps: RelayDeps = {
  registry: new Registry(),
  directory: loadDirectory(),
  postEvent: (event) => postEvent(event, { coreUrl }),
};
console.log(`[text] sending events to ${coreUrl}`);

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

// `app.messages` is an async iterable. Each tick yields a `space` (the
// conversation) and an inbound `message`. Reply by awaiting `space.send(...)`.
for await (const [space, message] of app.messages) {
  const phone = message.sender?.id;
  console.log("incoming", message.platform, phone, message.content.type);
  if (message.content.type !== "text" || !phone) continue;

  try {
    for (const reply of await processText(deps, phone, message.content.text)) {
      await space.send(reply);
    }
  } catch (err) {
    // One bad message must not stop the bot from reading the next one.
    console.error(`[text] failed to handle a message from ${phone}:`, err);
  }
}
