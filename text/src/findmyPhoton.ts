/**
 * Connects to Photon's Find My feed for the Relay line.
 *
 * Spectrum itself does not expose Find My, so this talks to the iMessage line
 * directly with Photon's advanced-imessage client, using a token minted from
 * the same project credentials Spectrum uses. Everything else in the lane sees
 * only the small LocationSource interface from findmy.ts.
 */
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
import { cloud } from "spectrum-ts";

import type { LocationSource, LocationUpdate } from "./findmy.js";

const SHARED_ADDRESS = "imessage.spectrum.photon.codes:443";

/** Re-mint the token once this share of its lifetime has passed. */
const REFRESH_AT = 0.8;

/**
 * Open a connection to the Find My feed.
 *
 * Args:
 *     projectId: The Photon project id.
 *     projectSecret: The Photon project secret.
 *     env: Environment variables. SPECTRUM_IMESSAGE_ADDRESS and
 *         SPECTRUM_IMESSAGE_LINE_ID override the address and line when needed.
 *
 * Returns:
 *     LocationSource: A live feed plus on-demand lookups.
 *
 * Raises:
 *     Error: If the project has no iMessage line or the tokens cannot be issued.
 */
export async function openPhotonLocationSource(
  projectId: string,
  projectSecret: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocationSource> {
  let minted = await cloud.issueImessageTokens(projectId, projectSecret);
  let mintedAt = Date.now();
  let refreshing: Promise<void> | null = null;

  const lineId =
    minted.type === "dedicated" ? (env.SPECTRUM_IMESSAGE_LINE_ID ?? Object.keys(minted.auth)[0]) : undefined;
  if (minted.type === "dedicated" && !lineId) throw new Error("the project has no iMessage line");

  const address =
    env.SPECTRUM_IMESSAGE_ADDRESS ?? (minted.type === "dedicated" ? `${lineId}.imsg.photon.codes:443` : SHARED_ADDRESS);

  const tokenOf = (): string => {
    if (minted.type === "shared") return minted.token;
    const token = minted.auth[lineId!];
    if (!token) throw new Error(`no token for line ${lineId}`);
    return token;
  };

  const client = createGrpcClient({
    address,
    retry: true,
    token: async () => {
      if (Date.now() - mintedAt > minted.expiresIn * 1000 * REFRESH_AT) {
        refreshing ??= cloud
          .issueImessageTokens(projectId, projectSecret)
          .then((fresh) => {
            minted = fresh;
            mintedAt = Date.now();
          })
          .finally(() => {
            refreshing = null;
          });
        await refreshing;
      }
      return tokenOf();
    },
  });

  let closing = false;

  return {
    async *watch(): AsyncGenerator<LocationUpdate> {
      try {
        for await (const update of client.locations.watch()) yield toUpdate(update.location);
      } catch (err) {
        // Closing the connection on purpose ends the feed with an error. That is not a failure.
        if (!closing) throw err;
      }
    },
    async get(handle) {
      try {
        return toUpdate(await client.locations.get(handle));
      } catch {
        // Not sharing with the line, or the lookup failed. Either way, no location.
        return null;
      }
    },
    async close() {
      closing = true;
      await client.close();
    },
  };
}

/**
 * Keep just the fields the tracker uses.
 *
 * Args:
 *     location: A location from the Photon client.
 *
 * Returns:
 *     LocationUpdate: The address and coordinates, if present.
 */
function toUpdate(location: { address: string; latitude?: number; longitude?: number }): LocationUpdate {
  return { address: location.address, latitude: location.latitude, longitude: location.longitude };
}
