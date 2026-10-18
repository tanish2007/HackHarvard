"""Local map server for Rudra's lane.

Serves the dashboard and a stand-in GET /state until Tirth's endpoint is
live. Also writes dashboard/backup-state.json on each successful read.
GET /picture is map chrome only: zones, wind, and scenario phones. It is
not part of Contract D.

    python dashboard/server.py
"""

from __future__ import annotations

import json
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_DIR = Path(__file__).resolve().parent
BACKUP = DASHBOARD_DIR / "backup-state.json"
HOST = "127.0.0.1"
PORT = 8080
PICTURE_TTL_SEC = 30

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from data.api import get_weather  # noqa: E402
from data.scenario import load_scenario  # noqa: E402
from data.state import build_route, build_state, build_weather  # noqa: E402

_picture_cache = {"at": 0.0, "body": b""}


def state_bytes():
    """Serialize Contract D and refresh the backup file.

    Returns:
        bytes: UTF-8 JSON for the current picture.
    """
    body = json.dumps(build_state()).encode("utf-8")
    BACKUP.write_bytes(body)
    return body


def picture_bytes():
    """Serialize zones, wind, and phones for the map chrome.

    Phones are read from scenario.json. They are not added to /state.

    Returns:
        bytes: UTF-8 JSON. Cached for PICTURE_TTL_SEC.
    """
    now = time.monotonic()
    if _picture_cache["body"] and now - _picture_cache["at"] < PICTURE_TTL_SEC:
        return _picture_cache["body"]
    scenario = load_scenario()
    center = scenario["incident"]["center"]
    weather = get_weather(center["lat"], center["lng"])
    payload = {
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
        "phones": [
            {"person_id": person["person_id"], "phone": person["phone"]}
            for person in scenario["people"]
            if person.get("phone")
        ],
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
        """Route /state, /picture, /weather, /route, and the backup file.

        Sends JSON for the data paths. A failed /state leaves the backup
        file untouched so the map can still show the last good picture.
        """
        path = urlparse(self.path).path
        if path == "/route":
            try:
                self._send(json.dumps(build_route()).encode("utf-8"))
            except Exception as exc:
                self._send_error(exc)
            return
        if path == "/weather":
            try:
                self._send(json.dumps(build_weather()).encode("utf-8"))
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
                state_bytes()
            self._send(BACKUP.read_bytes())
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def _send(self, body):
        """Write a JSON response.

        Args:
            body (bytes): JSON payload.
        """
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
    state_bytes()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Map at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
