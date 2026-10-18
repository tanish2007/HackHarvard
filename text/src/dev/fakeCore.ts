/**
 * A stand-in for Core's /event endpoint, for testing the text lane alone.
 *
 * It answers every event with one send_text action for the sender, so the whole
 * path from iMessage to Core and back can be tried before Core's real /event
 * exists. Run it with `npm run fake-core`, then start the bot with
 * CORE_URL=http://localhost:3001.
 */
import { createServer } from "node:http";

import type { CoreResponse, RelayEvent } from "../contracts.js";

const port = Number(process.env.FAKE_CORE_PORT ?? 3001);

/**
 * Build the fake Core's answer to one event.
 *
 * Args:
 *     event: The Contract A event the text lane posted.
 *
 * Returns:
 *     CoreResponse: One send_text action addressed to the sender.
 */
function respond(event: RelayEvent): CoreResponse {
  return {
    actions: [
      {
        type: "send_text",
        person_id: event.person_id,
        text: `(fake Core) ${event.person_id} said: "${event.text}"`,
        map_url: null,
      },
    ],
  };
}

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/event") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const event = JSON.parse(body) as RelayEvent;
      console.log("[fake core] event", JSON.stringify(event));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(respond(event)));
    } catch {
      res.writeHead(400).end();
    }
  });
}).listen(port, () => console.log(`[fake core] listening on http://localhost:${port}`));
