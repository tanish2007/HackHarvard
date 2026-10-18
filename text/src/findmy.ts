/**
 * Keeps the latest Find My location of everyone who shares with the Relay line.
 *
 * A background loop reads the live feed and remembers the newest point for each
 * person. Asking for someone's location is then an instant lookup, and falls
 * back to a quick direct request if nothing is remembered. This module has no
 * Photon code in it: the feed is injected, so it can be tested on its own.
 */
import type { Location } from "./contracts.js";
import { normalizePhone } from "./people.js";

/** One location from the feed. Photon leaves the coordinates out while it is still locating. */
export interface LocationUpdate {
  address: string;
  latitude?: number;
  longitude?: number;
}

/** A connection to the Find My feed. */
export interface LocationSource {
  /** Live updates for everyone sharing with the line. Ends when the connection drops. */
  watch(): AsyncIterable<LocationUpdate>;
  /** The current location of one person, or null if they are not sharing. */
  get(address: string): Promise<LocationUpdate | null>;
  /** Close the connection. */
  close(): Promise<void> | void;
}

/** Options for {@link FindMyTracker}. */
export interface TrackerOptions {
  /** Opens a connection. Called again after the feed drops. */
  open: () => Promise<LocationSource>;
  /** Clock in milliseconds, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** A remembered location older than this is looked up again. Defaults to 10 minutes. */
  staleMs?: number;
  /** Wait before reconnecting after the feed drops. Defaults to 1000, doubling up to 30000. */
  retryMs?: number;
  /** Logger. Defaults to console.log. */
  log?: (msg: string) => void;
  /** Called after the feed connects, so known phones can be looked up. */
  onConnect?: () => void;
  /** Called when a usable location is remembered. */
  onUpdate?: (handle: string, location: Location) => void;
}

interface Entry {
  location: Location;
  at: number;
}

/** Remembers each person's newest Find My location. */
export class FindMyTracker {
  private readonly seen = new Map<string, Entry>();
  private source: LocationSource | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly log: (msg: string) => void;

  /**
   * Create a tracker. Call {@link start} to connect.
   *
   * Args:
   *     options: How to open the feed, and timing.
   */
  constructor(private readonly options: TrackerOptions) {
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? 600_000;
    this.log = options.log ?? ((m) => console.log(m));
  }

  /** Connect and keep the feed running in the background. Returns at once. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  /** Stop reading the feed and close the connection. */
  async stop(): Promise<void> {
    this.running = false;
    await this.source?.close();
    this.source = null;
  }

  /**
   * Find someone's current Find My location.
   *
   * Args:
   *     handle: Their phone number or iMessage email.
   *     timeoutMs: How long to wait for a direct request if nothing fresh is
   *         remembered. Defaults to 1500.
   *
   * Returns:
   *     Location | null: The location, or null if they are not sharing, the
   *         lookup fails or it takes too long. Never throws.
   */
  async latest(handle: string, timeoutMs = 1500): Promise<Location | null> {
    const key = normalizePhone(handle);
    const known = this.seen.get(key);
    if (known && this.now() - known.at <= this.staleMs) return known.location;
    if (!this.source) return known?.location ?? null;

    try {
      const update = await withTimeout(this.source.get(handle), timeoutMs);
      this.remember(update);
    } catch {
      // Fall through to whatever is remembered, however old.
    }
    return this.seen.get(key)?.location ?? null;
  }

  /** Read the feed until stopped, reconnecting with a growing wait if it drops. */
  private async loop(): Promise<void> {
    let wait = this.options.retryMs ?? 1000;
    while (this.running) {
      try {
        this.source = await this.options.open();
        this.log("[findmy] connected");
        this.options.onConnect?.();
        for await (const update of this.source.watch()) {
          wait = this.options.retryMs ?? 1000;
          this.remember(update);
        }
        this.log("[findmy] feed ended");
      } catch (err) {
        this.log(`[findmy] feed failed: ${String(err)}`);
      }
      await this.source?.close();
      this.source = null;
      if (!this.running) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 30_000);
    }
  }

  /** Remember an update if it has usable coordinates. */
  private remember(update: LocationUpdate | null): void {
    if (!update || update.latitude === undefined || update.longitude === undefined) return;
    if (Math.abs(update.latitude) > 90 || Math.abs(update.longitude) > 180) return;
    const handle = normalizePhone(update.address);
    const location = { lat: update.latitude, lng: update.longitude };
    this.seen.set(handle, { location, at: this.now() });
    this.options.onUpdate?.(handle, location);
  }
}

/**
 * Wait for a promise, but give up after a time limit.
 *
 * Args:
 *     promise: The work to wait for.
 *     ms: How long to wait, in milliseconds.
 *
 * Returns:
 *     The promise's result.
 *
 * Raises:
 *     Error: "timed out" if the limit passes first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
