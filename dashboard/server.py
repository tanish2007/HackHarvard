"""Local map server for Rudra's lane.

Serves the dashboard and a stand-in GET /state until Tirth's endpoint is
live. Also writes dashboard/backup-state.json on each successful read.

    python dashboard/server.py
"""

from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_DIR = Path(__file__).resolve().parent
BACKUP = DASHBOARD_DIR / "backup-state.json"
HOST = "127.0.0.1"
PORT = 8080

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from data.state import build_state  # noqa: E402


def state_bytes():
    """Serialize Contract D and refresh the backup file.

    Returns:
        bytes: UTF-8 JSON for the current picture.
    """
    body = json.dumps(build_state()).encode("utf-8")
    BACKUP.write_bytes(body)
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
        """Route /state and the backup file, then static assets.

        Sends JSON for the two data paths. A failed /state leaves the
        backup file untouched so the map can still show the last good picture.
        """
        path = urlparse(self.path).path
        if path == "/state":
            try:
                self._send(state_bytes())
            except Exception as exc:
                body = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
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
