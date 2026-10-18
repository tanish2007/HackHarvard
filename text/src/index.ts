import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { createActionsServer } from "./actionsServer.js";
import { postEvent } from "./coreClient.js";
import { loadDirectory, normalizePhone } from "./people.js";
import { Registry } from "./registry.js";
import { processText, type RelayDeps } from "./relay.js";

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
  if (message.content.type !== "text" || !phone) continue;

  try {
    await processText(deps, phone, message.content.text, async (reply) => {
      await space.send(reply);
    });
  } catch (err) {
    // One bad message must not stop the bot from reading the next one.
    console.error(`[text] failed to handle a message from ${phone}:`, err);
  }
}
