"""National Weather Service forecast and active alerts.

NWS requires a User-Agent and no key. Empty alerts are a success.
"""

from __future__ import annotations

import os
import re

from data import http
from data.errors import DataSourceError
from data.geo import haversine_km

NWS_SEVERITY = {
    "extreme": "extreme",
    "severe": "severe",
    "moderate": "moderate",
    "minor": "minor",
}


def _headers():
    """Build the User-Agent header NWS requires.

    Returns:
        dict: Request headers.
    """
    agent = os.environ.get("NWS_USER_AGENT", "Relay/1.0 (HackHarvard demo)")
    return {"User-Agent": agent, "Accept": "application/json"}


def fetch_weather(lat, lng):
    """Download the short forecast for a point.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.

    Returns:
        dict: summary, wind_mph, wind_dir, temp_f, next_2h, and source.

    Raises:
        DataSourceError: If the points or hourly payload is unusable.
    """
    points_url = f"https://api.weather.gov/points/{lat:.4f},{lng:.4f}"
    points = http.fetch_json(points_url, headers=_headers())
    hourly_url = (points.get("properties") or {}).get("forecastHourly")
    if not hourly_url:
        raise DataSourceError("NWS points payload has no hourly forecast")
    return weather_from_hourly(http.fetch_json(hourly_url, headers=_headers()))


def fetch_weather_hazards(lat, lng):
    """Download active alerts and turn them into weather hazards.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.

    Returns:
        list[dict]: Weather hazard rows. Empty when no alert is active.

    Raises:
        DataSourceError: If the alerts payload is not a feature collection.
    """
    url = f"https://api.weather.gov/alerts/active?point={lat:.4f},{lng:.4f}"
    return hazards_from_alerts(http.fetch_json(url, headers=_headers()), lat, lng)


def weather_from_hourly(payload):
    """Read the frozen forecast shape from an hourly forecast document.

    Args:
        payload (dict): NWS hourly forecast JSON.

    Returns:
        dict: Forecast fields plus source nws.

    Raises:
        DataSourceError: If the first period is missing wind or temperature.
    """
    periods = (payload.get("properties") or {}).get("periods") or []
    if not periods:
        raise DataSourceError("NWS hourly forecast had no periods")
    current = periods[0]
    upcoming = periods[1] if len(periods) > 1 else current
    unit = current.get("temperatureUnit") or payload["properties"].get("temperatureUnit") or "F"
    try:
        temp = float(current["temperature"])
    except (KeyError, TypeError, ValueError) as exc:
        raise DataSourceError("NWS temperature was missing") from exc
    if str(unit).upper().startswith("C"):
        temp = temp * 9.0 / 5.0 + 32.0
    return {
        "summary": current.get("shortForecast") or "Forecast unavailable",
        "wind_mph": _wind_mph(current.get("windSpeed")),
        "wind_dir": current.get("windDirection") or "",
        "temp_f": round(temp, 1),
        "next_2h": upcoming.get("shortForecast") or current.get("shortForecast") or "",
        "source": "nws",
    }


def hazards_from_alerts(payload, lat, lng):
    """Turn an alerts feature collection into weather hazard rows.

    Args:
        payload (dict): NWS alerts JSON.
        lat (float): Fallback latitude when an alert has no geometry.
        lng (float): Fallback longitude when an alert has no geometry.

    Returns:
        list[dict]: Weather hazards, at most five.

    Raises:
        DataSourceError: If features is missing.
    """
    features = payload.get("features")
    if not isinstance(features, list):
        raise DataSourceError("NWS alerts payload has no features")
    rows = []
    for feature in features[:5]:
        props = feature.get("properties") or {}
        center_lat, center_lng, radius = _center(feature.get("geometry"), lat, lng)
        severity = NWS_SEVERITY.get(str(props.get("severity") or "").lower(), "moderate")
        alert_id = props.get("id") or feature.get("id") or f"nws_{len(rows)}"
        rows.append(
            {
                "id": str(alert_id).split("/")[-1][:80],
                "kind": "weather",
                "lat": round(center_lat, 5),
                "lng": round(center_lng, 5),
                "radius_km": round(radius, 2),
                "severity": severity,
                "source": "nws",
                "updated_at": props.get("sent") or props.get("onset") or "",
            }
        )
    return rows


def _wind_mph(text):
    """Pull the first number out of an NWS wind string.

    Args:
        text (str | None): Values such as "28 mph".

    Returns:
        float: Wind speed in miles per hour.

    Raises:
        DataSourceError: If no number is present.
    """
    match = re.search(r"(\d+(?:\.\d+)?)", text or "")
    if not match:
        raise DataSourceError("NWS wind speed was missing")
    return float(match.group(1))


def _center(geometry, lat, lng):
    """Estimate a circle from an alert geometry.

    Args:
        geometry (dict | None): GeoJSON geometry.
        lat (float): Fallback latitude.
        lng (float): Fallback longitude.

    Returns:
        tuple[float, float, float]: Center latitude, longitude, and radius km.
    """
    coords = []
    if geometry and geometry.get("coordinates"):
        _walk(geometry["coordinates"], coords)
    if not coords:
        return lat, lng, 8.0
    center_lat = sum(item[1] for item in coords) / len(coords)
    center_lng = sum(item[0] for item in coords) / len(coords)
    radius = max(haversine_km(center_lat, center_lng, item[1], item[0]) for item in coords)
    return center_lat, center_lng, max(1.0, radius)


def _walk(node, found):
    """Collect coordinate pairs from nested GeoJSON coordinates.

    Args:
        node (list): A coordinate or a nested list of coordinates.
        found (list): Pairs appended in place as [lng, lat].
    """
    if not node:
        return
    if isinstance(node[0], (int, float)):
        found.append(node)
        return
    for child in node:
        _walk(child, found)
