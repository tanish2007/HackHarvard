/**
 * Starts the public tunnel and points the ElevenLabs agents at it.
 *
 * Usage (from voice/, with the voice server already running):
 *   npm run tunnel
 *
 * A free Cloudflare tunnel gets a new address each time it starts. This starts
 * it, waits until the address really reaches the voice server, then updates the
 * custom LLM URL on the main agent and on the radio agent (if one is set), so
 * a restart needs nothing else. Leave it running. Ctrl+C stops the tunnel.
 *
 * Needs in .env: VOICE_LLM_SECRET, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID.
 * Optional: ELEVENLABS_RADIO_AGENT_ID, VOICE_PORT (default 3001), and
 * CLOUDFLARED_PATH if cloudflared is not on the PATH.
 *
 * It prints the tunnel address without the secret path, never the secret.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { extractTunnelUrl, llmBaseUrl, setAgentLlmUrl, waitForTunnel } from "../src/tunnel.js";

/** Where `winget install Cloudflare.cloudflared` puts it on Windows. */
const WINDOWS_PATHS = [
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
];

/**
 * Read a required environment variable.
 *
 * Args:
 *   name: The variable name.
 *
 * Returns:
 *   The variable's value.
 *
 * Raises:
 *   Error: If the variable is missing or empty.
 */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

/**
 * Find the cloudflared program.
 *
 * Returns:
 *   CLOUDFLARED_PATH if set, else the Windows install location if it exists,
 *   else plain `cloudflared` to be found on the PATH.
 */
function findCloudflared(): string {
  return process.env.CLOUDFLARED_PATH || WINDOWS_PATHS.find((p) => existsSync(p)) || "cloudflared";
}

const secret = need("VOICE_LLM_SECRET");
const apiKey = need("ELEVENLABS_API_KEY");
const agents = [
  { name: "main agent", id: need("ELEVENLABS_AGENT_ID") },
  ...(process.env.ELEVENLABS_RADIO_AGENT_ID ? [{ name: "radio agent", id: process.env.ELEVENLABS_RADIO_AGENT_ID }] : []),
];
const port = Number(process.env.VOICE_PORT ?? 3001);

const child = spawn(findCloudflared(), ["tunnel", "--url", `http://localhost:${port}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
child.on("error", (err) => {
  console.error(`could not start cloudflared: ${err.message}. Install it with: winget install Cloudflare.cloudflared`);
  process.exit(1);
});
child.on("exit", (code) => {
  console.error(`cloudflared stopped (exit ${code ?? "unknown"}). The agents still point at the old address.`);
  process.exit(code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill());

let announced = false;
for (const stream of [child.stdout, child.stderr]) {
  createInterface({ input: stream }).on("line", async (line) => {
    const url = extractTunnelUrl(line);
    if (!url || announced) return;
    announced = true;
    console.log(`tunnel started: ${url}`);

    if (!(await waitForTunnel(url))) {
      console.error(`the tunnel never reached the voice server on port ${port}. Is "npm start" running? The agents were not changed.`);
      child.kill();
      return;
    }
    console.log("the tunnel reaches the voice server");

    let failed = 0;
    for (const agent of agents) {
      try {
        await setAgentLlmUrl({ apiKey, agentId: agent.id, url: llmBaseUrl(url, secret) });
        console.log(`updated the ${agent.name}`);
      } catch (err) {
        failed += 1;
        console.error(`FAILED to update the ${agent.name}: ${(err as Error).message}`);
      }
    }
    console.log(
      failed === 0
        ? "done: the agents now call this tunnel. Leave this running."
        : `${failed} agent(s) still point at the old address. Fix that before taking calls.`,
    );
  });
}
