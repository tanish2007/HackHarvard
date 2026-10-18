/**
 * Helpers for pointing the ElevenLabs agents at the public tunnel.
 *
 * A free Cloudflare tunnel gets a new address every time it starts, and the
 * agents must call that address to reach the speech endpoint. These functions
 * find the address, check it really reaches this server, and update the
 * agents, so a restart is one command instead of two manual edits.
 *
 * The URL given to ElevenLabs contains the secret path segment. It is never
 * put in an error message or log line.
 */

const API = "https://api.elevenlabs.io";

/** The shape of an agent's custom LLM setting that this file reads and keeps. */
interface CustomLlm {
  url?: string;
  [field: string]: unknown;
}

/** Options for {@link setAgentLlmUrl}. */
export interface SetAgentLlmUrlOptions {
  /** ElevenLabs API key. */
  apiKey: string;
  /** The agent to update. */
  agentId: string;
  /** The full custom LLM URL, including the secret path and `/v1`. */
  url: string;
  /** Fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** API host. Defaults to https://api.elevenlabs.io. */
  baseUrl?: string;
}

/**
 * Find a quick tunnel address in a line of cloudflared output.
 *
 * Args:
 *   line: One line of cloudflared's log.
 *
 * Returns:
 *   The https address, for example https://word-word.trycloudflare.com, or
 *   null if the line has none.
 */
export function extractTunnelUrl(line: string): string | null {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line)?.[0] ?? null;
}

/**
 * Build the URL the agents use as their custom LLM server.
 *
 * ElevenLabs adds `/chat/completions` itself, so this ends in `/v1`.
 *
 * Args:
 *   tunnelUrl: The tunnel address, without a trailing slash.
 *   secret: The VOICE_LLM_SECRET that guards the speech endpoint.
 *
 * Returns:
 *   The address to give ElevenLabs.
 */
export function llmBaseUrl(tunnelUrl: string, secret: string): string {
  return `${tunnelUrl.replace(/\/+$/, "")}/llm/${secret}/v1`;
}

/**
 * Check that a tunnel address reaches the voice server.
 *
 * A new tunnel needs a few seconds before its address resolves, so this
 * tries several times.
 *
 * Args:
 *   tunnelUrl: The tunnel address.
 *   fetchImpl: Fetch implementation, injectable for tests.
 *   attempts: How many tries before giving up. Defaults to 15.
 *   delayMs: Pause between tries. Defaults to 2000.
 *
 * Returns:
 *   True once `/health` answers with the voice lane, false if it never does.
 */
export async function waitForTunnel(
  tunnelUrl: string,
  fetchImpl: typeof fetch = fetch,
  attempts = 15,
  delayMs = 2000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${tunnelUrl}/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok && ((await res.json()) as { lane?: string }).lane === "voice") return true;
    } catch {
      // Not reachable yet. Try again.
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

/**
 * Point one ElevenLabs agent at a new custom LLM URL, and confirm it stuck.
 *
 * Only the `custom_llm` setting is sent, with its existing fields kept and
 * the URL replaced, so the prompt, voice, tools and backups are untouched.
 *
 * Args:
 *   options: The API key, the agent, the new URL and test hooks.
 *
 * Raises:
 *   Error: If the agent does not use a custom LLM, a request fails, or the
 *     agent does not show the new URL afterwards. The message never contains
 *     the URL, since it holds the secret.
 */
export async function setAgentLlmUrl(options: SetAgentLlmUrlOptions): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  const agentUrl = `${options.baseUrl ?? API}/v1/convai/agents/${options.agentId}`;
  const headers = { "xi-api-key": options.apiKey, "content-type": "application/json" };

  /** Read the agent's current custom LLM setting. */
  const read = async (): Promise<CustomLlm | undefined> => {
    const res = await doFetch(agentUrl, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`could not read agent ${options.agentId}: ${res.status}`);
    const body = (await res.json()) as {
      conversation_config?: { agent?: { prompt?: { custom_llm?: CustomLlm } } };
    };
    return body.conversation_config?.agent?.prompt?.custom_llm ?? undefined;
  };

  const current = await read();
  if (!current) throw new Error(`agent ${options.agentId} does not use a custom LLM`);

  const patch = await doFetch(agentUrl, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      conversation_config: { agent: { prompt: { custom_llm: { ...current, url: options.url } } } },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!patch.ok) throw new Error(`could not update agent ${options.agentId}: ${patch.status}`);

  if ((await read())?.url !== options.url) {
    throw new Error(`agent ${options.agentId} did not keep the new URL`);
  }
}
