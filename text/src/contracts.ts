/**
 * Shapes for the hand-off contracts between the text lane and Core.
 *
 * Contract A is what this lane posts to Core's /event endpoint. Contract B is
 * what Core returns. Do not rename fields here without agreeing it in the
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
 * `location` and `media_url` may be null but are never missing.
 */
export interface RelayEvent {
  event_id: string;
  channel: Channel;
  person_id: string;
  from: string;
  text: string;
  location: Location | null;
  media_url: string | null;
  timestamp: string;
}

/**
 * Contract B: send a text to a person. Carried out by this lane.
 *
 * `to` is the person's phone number or iMessage email. Core fills it in for
 * people who signed up by text and are not in scenario.json, so this lane has
 * no other way to find them. It may be null for scenario people.
 */
export interface SendTextAction {
  type: "send_text";
  person_id: string;
  to: string | null;
  text: string;
  map_url: string | null;
}

/** Contract B: place an outbound call. Carried out by the voice lane. */
export interface PlaceCallAction {
  type: "place_call";
  person_id: string;
  to: string | null;
  script: string;
  reason: string;
}

/** Contract B: speak on the call that is already open. Voice lane only. */
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
