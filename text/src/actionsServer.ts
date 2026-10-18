/**
 * The text lane's small HTTP server, so Core can push actions to us.
 *
 * Core posts a Contract B body to POST /actions when something happens that no
 * one texted about, such as a fire alert. Nothing else in the contracts
 * changes: Contract A and the /event reply work as before.
 */
import { createServer, type Server } from "node:http";

import { deliverActions, type AlertDeps } from "./alerts.js";
import { parseActions } from "./coreClient.js";

const MAX_BODY_BYTES = 1_000_000;

/**
 * Build the server. Call `.listen(port)` on the result to start it.
 *
 * Args:
 *     deps: What deliverActions needs.
 *
 * Returns:
 *     Server: POST /actions answers 200 with a delivery report, 400 for a body
 *         that is not valid JSON with an actions list, and 413 for a huge body.
 *         GET /health answers 200. Anything else is 404.
 */
export function createActionsServer(deps: AlertDeps): Server {
  const log = deps.log ?? ((m: string) => console.warn(m));

  return createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/health") return reply(200, { status: "ok" });
    if (req.method !== "POST" || req.url !== "/actions") return reply(404, { error: "not found" });

    let body = "";
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES && !tooBig) {
        tooBig = true;
        reply(413, { error: "body too large" });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return reply(400, { error: "body is not valid JSON" });
      }
      const list = (parsed as { actions?: unknown } | null)?.actions;
      if (!Array.isArray(list)) return reply(400, { error: 'body needs an "actions" list' });

      deliverActions(deps, parseActions(parsed, log)).then(
        (report) => reply(200, report),
        (err) => {
          log(`delivering actions failed: ${String(err)}`);
          reply(500, { error: "delivery failed" });
        },
      );
    });
  });
}
