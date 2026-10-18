import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { handleText } from "./handler.js";
import { Registry } from "./registry.js";

const registry = new Registry();

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

  await space.send(handleText(registry, phone, message.content.text));
}
