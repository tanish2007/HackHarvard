/**
 * Checks whether Photon can see someone's Find My location, without any texting.
 *
 * Run with `npm run findmy-check -- +14134727634`. It asks for that person's
 * current location, then prints live updates for everyone sharing with the line
 * for 20 seconds. Needs PROJECT_ID and PROJECT_SECRET in .env.
 */
import { openPhotonLocationSource } from "../findmyPhoton.js";

const handles = process.argv.slice(2);
const source = await openPhotonLocationSource(process.env.PROJECT_ID!, process.env.PROJECT_SECRET!);
console.log("[findmy-check] connected to the line");

for (const handle of handles) {
  const found = await source.get(handle);
  console.log(
    found && found.latitude !== undefined
      ? `[findmy-check] ${handle}: ${found.latitude}, ${found.longitude}`
      : `[findmy-check] ${handle}: not sharing with the line, or still locating`,
  );
}

console.log("[findmy-check] watching live updates for 20 seconds...");
const stop = setTimeout(() => void source.close(), 20_000);
try {
  for await (const update of source.watch()) {
    console.log(`[findmy-check] update ${update.address}: ${update.latitude}, ${update.longitude}`);
  }
} finally {
  clearTimeout(stop);
}
console.log("[findmy-check] done");
