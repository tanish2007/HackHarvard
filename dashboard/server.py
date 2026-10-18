"""Local map server for Rudra's lane.

GET /state prefers Core at http://localhost:3000/state. A good read is
saved as dashboard/backup-state.json. A failed read leaves that file
alone. GET /picture is map chrome only: zones, wind, scenario phones, the
venue center, and where each unit stands when Core has no coordinates.
It is not part of Contract D. GET /firms is the live NASA panel. It is
not the staged fire, and it is not Contract C.

Contract C is also on this server. /weather and /route with no query
stay the map's existing calls. The no-query route is empty until
someone texts help, and then it is an OpenStreetMap walking path.
lat/lng query params call the functions directly.

    python dashboard/server.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_DIR = Path(__file__).resolve().parent
BACKUP = DASHBOARD_DIR / "backup-state.json"
HOST = "127.0.0.1"
PORT = 8080
PICTURE_TTL_SEC = 30
CORE_BASE = "http://localhost:3000"
CORE_STATE_URL = CORE_BASE + "/state"
CORE_TIMEOUT_SEC = 0.8
CONTRACT_LISTS = (
    "hazards",
    "shelters",
    "people",
    "volunteers",
    "reports",
    "units",
    "timeline",
)

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from data.api import get_hazards, get_route, get_shelters, get_weather  # noqa: E402
from data.errors import DataSourceError  # noqa: E402
from data.firms import fetch_fire_hazards  # noqa: E402
from data.routing import fetch_route  # noqa: E402
from data.scenario import load_scenario  # noqa: E402
from data.state import build_state, build_weather  # noqa: E402

_picture_cache = {"at": 0.0, "body": b""}
_live_route_cache = {"key": None, "payload": None}


def fetch_core_state():
    """GET Contract D from Core.

    Returns:
        bytes: Core's JSON body, unchanged.

    Raises:
        urllib.error.URLError: If Core does not answer in time.
        ValueError: If the body is not Contract D.
        json.JSONDecodeError: If the body is not JSON.
    """
    request = urllib.request.Request(
        CORE_STATE_URL,
        headers={"Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=CORE_TIMEOUT_SEC) as response:
        body = response.read()
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("Core state is not an object")
    for key in CONTRACT_LISTS:
        if not isinstance(payload.get(key), list):
            raise ValueError("Missing list: " + key)
    if not isinstance(payload.get("incident"), dict):
        raise ValueError("Core state is missing incident")
    if not isinstance(payload.get("counts"), dict):
        raise ValueError("Core state is missing counts")
    return body


def state_bytes():
    """Return Core's Contract D and refresh the backup file.

    Returns:
        bytes: UTF-8 JSON from Core.

    Raises:
        urllib.error.URLError: If Core does not answer. The backup file
            is left untouched.
        ValueError: If Core's body is not Contract D.
    """
    body = fetch_core_state()
    BACKUP.write_bytes(body)
    return body


def _texted_help(text):
    """Whether a text is the help message that should draw a route.

    Args:
        text (str): The inbound message.

    Returns:
        bool: True for help or SOS, after trimming and lowercasing.
    """
    body = " ".join(str(text or "").split()).lower()
    return body in {"help", "help me", "i need help", "need help", "sos"}


def _empty_route():
    """Return a route body with no line, so the map clears the path.

    Returns:
        dict: Route fields with an empty polyline.
    """
    return {
        "distance_km": 0.0,
        "duration_min": 0.0,
        "steps": [],
        "polyline": [],
        "avoided_hazards": [],
        "source": "fallback",
        "person_name": "",
        "shelter_name": "",
    }


def _help_texter():
    """Find who texted help and is still marked as needing it.

    A phone call does not count. The person has to have sent the word
    over iMessage or SMS, and still be in SOS.

    Returns:
        tuple[str, float, float] | None: Name and live coordinates, or
        None when nobody has texted help.
    """
    try:
        payload = json.loads(fetch_core_state())
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError):
        return None
    by_name = {}
    for person in payload.get("people") or []:
        if person.get("status") != "sos" or str(person.get("person_id") or "").startswith("sim_"):
            continue
        name = person.get("name") or ""
        try:
            by_name[name] = (name, float(person["lat"]), float(person["lng"]))
        except (KeyError, TypeError, ValueError):
            continue
    best = None
    best_at = ""
    for entry in payload.get("timeline") or []:
        if entry.get("channel") not in ("imessage", "sms"):
            continue
        name = entry.get("who") or ""
        if name not in by_name or not _texted_help(entry.get("text")):
            continue
        at = entry.get("at") or ""
        if best is None or at >= best_at:
            best = by_name[name]
            best_at = at
    return best


def _drawn_fires():
    """Return fire circles the map is currently drawing.

    The scenario placeholder is hidden on the map, so it does not bend
    the walking path. A fire that has been turned on does.

    Returns:
        list[dict]: Fire hazards with lat, lng, and radius_km.
    """
    try:
        payload = json.loads(fetch_core_state())
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError):
        return []
    fires = []
    for hazard in payload.get("hazards") or []:
        if hazard.get("kind") != "fire" or hazard.get("source") == "scenario":
            continue
        try:
            fires.append({
                "id": hazard.get("id") or "fire",
                "lat": float(hazard["lat"]),
                "lng": float(hazard["lng"]),
                "radius_km": float(hazard["radius_km"]),
            })
        except (KeyError, TypeError, ValueError):
            continue
    return fires


def map_route():
    """Return a walking route only after someone texts help.

    Until that text, the polyline is empty and the map draws no path.
    The line is an OpenStreetMap foot path from where they are to the
    nearest shelter. It is not the straight demo line. Repeated polls
    reuse it until they move or someone else texts help.

    Returns:
        dict: Route fields plus person_name and shelter_name.
    """
    texter = _help_texter()
    if texter is None:
        return _empty_route()
    name, lat, lng = texter
    key = ("help", name, round(lat, 4), round(lng, 4))
    if _live_route_cache["key"] == key and _live_route_cache["payload"] is not None:
        return _live_route_cache["payload"]
    shelters = get_shelters(lat, lng)
    if not shelters:
        return _empty_route()
    shelter = shelters[0]
    try:
        routed = fetch_route(
            lat,
            lng,
            shelter["lat"],
            shelter["lng"],
            _drawn_fires(),
            shelter["name"],
            profile="foot",
            allow_geometric=False,
        )
    except DataSourceError:
        return _empty_route()
    routed["person_name"] = name
    routed["shelter_name"] = shelter["name"]
    _live_route_cache["key"] = key
    _live_route_cache["payload"] = routed
    return routed


def seed_backup():
    """Make sure a backup file exists before the first poll.

    Core's picture is saved when Core is up. Otherwise the scenario
    picture is written only if the backup file is missing.
    """
    try:
        state_bytes()
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError):
        if not BACKUP.exists():
            BACKUP.write_bytes(json.dumps(build_state()).encode("utf-8"))


def client_config_bytes():
    """Tell the map where Core is, and the admin token if one is set.

    The token stays out of the page source. The map asks for it so a
    confirm can send x-relay-admin. An empty token means the header is
    omitted.

    Returns:
        bytes: UTF-8 JSON with core and admin_token.
    """
    payload = {
        "core": CORE_BASE,
        "admin_token": os.environ.get("RELAY_ADMIN_TOKEN", "").strip(),
    }
    return json.dumps(payload).encode("utf-8")


def _query_float(qs, name):
    """Read one required float from a query string.

    Args:
        qs (dict): Values from parse_qs.
        name (str): Parameter name.

    Returns:
        float: The parsed value.

    Raises:
        ValueError: If the parameter is missing or not a number.
    """
    raw = (qs.get(name) or [None])[0]
    if raw is None or raw == "":
        raise ValueError(name + " is required")
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(name + " must be a number") from exc


def _picture_phones(scenario):
    """Phones for the map drawer, with scenario.local.json winning.

    Args:
        scenario (dict): Loaded scenario, including simulated people.

    Returns:
        list[dict]: person_id and phone for everyone who has a number.
    """
    overrides = {}
    local = ROOT / "scenario.local.json"
    if local.exists():
        try:
            parsed = json.loads(local.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            parsed = {}
        phones = parsed.get("phones") if isinstance(parsed, dict) else None
        if isinstance(phones, dict):
            overrides = phones
    rows = []
    for person in scenario["people"]:
        phone = overrides.get(person["person_id"]) or person.get("phone")
        if phone:
            rows.append({"person_id": person["person_id"], "phone": phone})
    return rows


def firms_hazards(lat, lng, radius_km):
    """Return live FIRMS fires, or nothing when NASA does not answer.

    Args:
        lat (float): Search latitude.
        lng (float): Search longitude.
        radius_km (float): Search radius in kilometers.

    Returns:
        list[dict]: Fire rows. Empty when the key is missing or FIRMS fails.
    """
    try:
        return fetch_fire_hazards(lat, lng, radius_km)
    except DataSourceError:
        return []


def picture_bytes():
    """Serialize zones, wind, phones, the venue, unit stations, and call timers.

    Phones come from scenario.json, replaced by scenario.local.json when
    that file has a number. They are not added to /state.

    Returns:
        bytes: UTF-8 JSON. Cached for PICTURE_TTL_SEC.
    """
    now = time.monotonic()
    if _picture_cache["body"] and now - _picture_cache["at"] < PICTURE_TTL_SEC:
        return _picture_cache["body"]
    scenario = load_scenario()
    center = scenario["incident"]["center"]
    weather = get_weather(center["lat"], center["lng"])
    command_id = scenario["settings"]["command_post"]
    command = next(
        (place for place in scenario.get("places") or [] if place.get("id") == command_id),
        None,
    )
    units = []
    if command:
        for unit in scenario.get("units") or []:
            units.append({
                "unit_id": unit["unit_id"],
                "name": unit["name"],
                "lat": command["lat"],
                "lng": command["lng"],
            })
    payload = {
        "center": {"lat": center["lat"], "lng": center["lng"]},
        "units": units,
        "zones": [
            {
                "id": zone["id"],
                "name": zone["name"],
                "polygon": zone["polygon"],
            }
            for zone in scenario.get("zones") or []
        ],
        "fire_area": scenario.get("fire_area") or None,
        "wind": {
            "summary": weather["summary"],
            "wind_mph": weather["wind_mph"],
            "wind_dir": weather["wind_dir"],
            "temp_f": weather["temp_f"],
            "source": weather["source"],
        },
        "phones": _picture_phones(scenario),
        "checkin_timeout_sec": scenario["settings"]["checkin_timeout_sec"],
        "escalation_timeout_sec": scenario["settings"]["escalation_timeout_sec"],
    }
    body = json.dumps(payload).encode("utf-8")
    _picture_cache["at"] = now
    _picture_cache["body"] = body
    return body


class Handler(SimpleHTTPRequestHandler):
    """Serve the map, /state, and the backup snapshot."""

    def __init__(self, *args, **kwargs):
        """Point the static handler at the dashboard directory.

        Args:
            *args: Base handler arguments.
            **kwargs: Base handler keyword arguments.
        """
        super().__init__(*args, directory=str(DASHBOARD_DIR), **kwargs)

    def do_GET(self):
        """Route state, picture, Contract C, and the backup file.

        A failed /state leaves the backup file untouched so the map can
        still show the last good picture.
        """
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        if path == "/firms":
            self._contract(lambda: firms_hazards(
                _query_float(qs, "lat"),
                _query_float(qs, "lng"),
                _query_float(qs, "radius_km"),
            ))
            return
        if path == "/hazards":
            self._contract(lambda: get_hazards(
                _query_float(qs, "lat"),
                _query_float(qs, "lng"),
                _query_float(qs, "radius_km"),
            ))
            return
        if path == "/shelters":
            self._contract(lambda: get_shelters(
                _query_float(qs, "lat"),
                _query_float(qs, "lng"),
            ))
            return
        if path == "/route":
            if any(key in qs for key in ("from_lat", "from_lng", "to_lat", "to_lng")):
                profile = (qs.get("profile") or ["driving"])[0]
                self._contract(lambda: get_route(
                    _query_float(qs, "from_lat"),
                    _query_float(qs, "from_lng"),
                    _query_float(qs, "to_lat"),
                    _query_float(qs, "to_lng"),
                    profile="foot" if profile == "foot" else "driving",
                ))
            else:
                self._contract(map_route)
            return
        if path == "/weather":
            if "lat" in qs or "lng" in qs:
                self._contract(lambda: get_weather(
                    _query_float(qs, "lat"),
                    _query_float(qs, "lng"),
                ))
            else:
                self._contract(build_weather)
            return
        if path == "/client-config":
            try:
                self._send(client_config_bytes())
            except Exception as exc:
                self._send_error(exc)
            return
        if path == "/state":
            try:
                self._send(state_bytes())
            except Exception as exc:
                self._send_error(exc)
            return
        if path == "/picture":
            try:
                self._send(picture_bytes())
            except Exception as exc:
                self._send_error(exc)
            return
        if path == "/backup-state.json":
            if not BACKUP.exists():
                seed_backup()
            self._send(BACKUP.read_bytes())
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def _contract(self, build):
        """Send a Contract C payload, or a 400 for a bad query.

        Args:
            build (callable): Returns the JSON-ready value.
        """
        try:
            self._send(json.dumps(build()).encode("utf-8"))
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            self._send_error(exc)

    def _send(self, body):
        """Write a JSON response.

        Args:
            body (bytes): JSON payload.
        """
        self._send_json(200, body)

    def _send_json(self, status, body):
        """Write a JSON response with an explicit status.

        Args:
            status (int): HTTP status code.
            body (bytes | dict): JSON payload.
        """
        raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_error(self, exc):
        """Write a JSON error without touching the backup file.

        Args:
            exc (Exception): Failure from a data helper.
        """
        body = json.dumps({"error": str(exc)}).encode("utf-8")
        self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    """Start the map server on port 8080.

    Raises:
        OSError: If the port is already taken.
    """
    seed_backup()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Map at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
