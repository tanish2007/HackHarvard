"""HTTP helpers for the live data sources.

Responses are cached for a minute so the map can poll every two seconds
without hammering FIRMS, NWS, OSRM, or Overpass.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path

from data.errors import DataSourceError

TIMEOUT_SECONDS = 4
CACHE_SECONDS = 60
_CACHE = {}


def load_local_env():
    """Load a repo .env file without overriding existing variables.

    A missing file is fine. Values already in the environment win.
    """
    path = Path(__file__).resolve().parents[1] / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def fetch_text(url, headers=None, timeout=TIMEOUT_SECONDS):
    """GET a URL and return the body as text.

    Args:
        url (str): Absolute URL.
        headers (dict | None): Extra request headers.
        timeout (float): Seconds before the call fails.

    Returns:
        str: Response body.

    Raises:
        DataSourceError: On timeout, HTTP error, or a network failure.
    """
    cached = _read_cache(url)
    if cached is not None:
        return cached
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except Exception as exc:
        raise DataSourceError(str(exc)) from exc
    text = raw.decode("utf-8", errors="replace")
    _CACHE[url] = (time.monotonic(), text)
    return text


def fetch_json(url, headers=None, timeout=TIMEOUT_SECONDS):
    """GET a URL and parse a JSON object.

    Args:
        url (str): Absolute URL.
        headers (dict | None): Extra request headers.
        timeout (float): Seconds before the call fails.

    Returns:
        dict: Parsed JSON object.

    Raises:
        DataSourceError: If the body is not a JSON object, or the GET fails.
    """
    try:
        payload = json.loads(fetch_text(url, headers=headers, timeout=timeout))
    except json.JSONDecodeError as exc:
        raise DataSourceError("Response was not JSON") from exc
    if not isinstance(payload, dict):
        raise DataSourceError("Response JSON was not an object")
    return payload


def _read_cache(url):
    """Return a fresh cached body, or None.

    Args:
        url (str): Absolute URL.

    Returns:
        str | None: Cached body when it is younger than CACHE_SECONDS.
    """
    hit = _CACHE.get(url)
    if not hit:
        return None
    saved_at, text = hit
    if time.monotonic() - saved_at > CACHE_SECONDS:
        return None
    return text


load_local_env()
