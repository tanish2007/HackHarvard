/**
 * Shared shapes for the hand-off contracts between channels and Core.
 *
 * Contract A is what a channel posts to Core's /event endpoint. Contract B
 * is what Core returns. Do not rename fields here without agreeing it in the
 * group chat and updating the PRD first.
 */

/** Channels a Contract A event can come from. */
export type Channel = "imessage" | "sms" | "voice" | "radio";

/** A geographic point. */
export interface Location {
  lat: number;
  lng: number;
}

/**
 * Contract A: an event handed from a channel to Core.
 *
 * `location` and `media_url` may be null but are never missing. `person_id`
 * may be null: Core then resolves the person from `from`.
 */
export interface RelayEvent {
  event_id: string;
  channel: Channel;
  person_id: string | null;
  from: string;
  text: string;
  location: Location | null;
  media_url: string | null;
  timestamp: string;
}

/** Contract B: send a text to a person. Owned by the text lane. */
export interface SendTextAction {
  type: "send_text";
  person_id: string;
  /** The person's handle, for people who are not in scenario.json. */
  to: string | null;
  text: string;
  map_url: string | null;
}

/** Contract B: place an outbound call to a person. */
export interface PlaceCallAction {
  type: "place_call";
  person_id: string;
  /** Phone number to call, for people who are not in scenario.json. */
  to: string | null;
  script: string;
  reason: string;
}

/** Contract B: speak on the call that is already open. */
export interface SayAction {
  type: "say";
  text: string;
}

/** Any action Core can return. */
export type RelayAction = SendTextAction | PlaceCallAction | SayAction;

/** Contract B: the response body from Core's /event endpoint. */
export interface CoreResponse {
  actions: RelayAction[];
}
