"""NASA FIRMS active fire detections.

The area is the caller's lat, lng, and radius. An empty detection list is
a successful response. A missing key or a bad payload raises DataSourceError
so the caller can fall back.
"""

from __future__ import annotations

import csv
import io
import math
import os

from data import http
from data.errors import DataSourceError
from data.geo import haversine_km

SOURCE = "VIIRS_SNPP_NRT"
MAX_CLUSTERS = 8
MIN_RADIUS_KM = 0.4


def fetch_fire_hazards(lat, lng, radius_km):
    """Download FIRMS detections and cluster them into hazard rows.

    Args:
        lat (float): Search latitude.
        lng (float): Search longitude.
        radius_km (float): Search radius in kilometers.

    Returns:
        list[dict]: Fire hazards. Empty when FIRMS reports none.

    Raises:
        DataSourceError: If FIRMS_MAP_KEY is missing or the request fails.
    """
    if float(radius_km) <= 0:
        return []
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not key:
        raise DataSourceError("FIRMS_MAP_KEY is not set")
    west, south, east, north = _bbox(lat, lng, radius_km)
    area = f"{west:.4f},{south:.4f},{east:.4f},{north:.4f}"
    url = (
        "https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
        f"{key}/{SOURCE}/{area}/1"
    )
    return hazards_from_csv(http.fetch_text(url), lat, lng, radius_km)


def hazards_from_csv(text, lat, lng, radius_km):
    """Turn a FIRMS CSV body into clustered hazard rows.

    Args:
        text (str): CSV body, including the header row.
        lat (float): Search latitude.
        lng (float): Search longitude.
        radius_km (float): Search radius in kilometers.

    Returns:
        list[dict]: At most MAX_CLUSTERS fire hazards inside the radius.

    Raises:
        DataSourceError: If the body is an error page instead of CSV.
    """
    stripped = (text or "").lstrip()
    if not stripped:
        raise DataSourceError("FIRMS returned an empty body")
    header = stripped.splitlines()[0].lower()
    if "latitude" not in header or "longitude" not in header:
        raise DataSourceError(stripped.splitlines()[0][:180])
    points = []
    for row in csv.DictReader(io.StringIO(stripped)):
        point = _point(row)
        if point is None:
            continue
        if haversine_km(lat, lng, point["lat"], point["lng"]) > float(radius_km):
            continue
        points.append(point)
    return _cluster(points)


def _bbox(lat, lng, radius_km):
    """Build a west, south, east, north box around a point.

    Args:
        lat (float): Center latitude.
        lng (float): Center longitude.
        radius_km (float): Half-size of the box in kilometers.

    Returns:
        tuple[float, float, float, float]: West, south, east, north.
    """
    delta_lat = float(radius_km) / 110.574
    cosine = math.cos(math.radians(lat))
    if abs(cosine) < 0.01:
        cosine = 0.01 if cosine >= 0 else -0.01
    delta_lng = float(radius_km) / (111.32 * abs(cosine))
    return lng - delta_lng, lat - delta_lat, lng + delta_lng, lat + delta_lat


def _point(row):
    """Read one FIRMS CSV row.

    Args:
        row (dict): A DictReader row.

    Returns:
        dict | None: lat, lng, severity rank, and updated_at. None if the
        coordinates are missing.
    """
    try:
        lat = float(row.get("latitude"))
        lng = float(row.get("longitude"))
    except (TypeError, ValueError):
        return None
    return {
        "lat": lat,
        "lng": lng,
        "rank": _rank(row.get("confidence", "")),
        "updated_at": _updated_at(row.get("acq_date", ""), row.get("acq_time", "")),
        "frp": _frp(row.get("frp")),
    }


def _rank(confidence):
    """Map a FIRMS confidence label to a severity rank.

    Args:
        confidence (str): FIRMS confidence value.

    Returns:
        int: 1 moderate, 2 severe, 3 extreme.
    """
    label = str(confidence or "").strip().lower()
    if label in ("h", "high"):
        return 3
    if label in ("n", "nominal"):
        return 2
    return 1


def _frp(value):
    """Parse fire radiative power.

    Args:
        value (str | None): FRP column.

    Returns:
        float: FRP, or 0 when the column is blank.
    """
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _updated_at(date, clock):
    """Build an ISO timestamp from FIRMS date and time columns.

    Args:
        date (str): acq_date, YYYY-MM-DD.
        clock (str): acq_time, HHMM.

    Returns:
        str: UTC timestamp, or an empty string when the date is missing.
    """
    if not date:
        return ""
    digits = "".join(ch for ch in str(clock) if ch.isdigit()).zfill(4)
    return f"{date}T{digits[:2]}:{digits[2:4]}:00Z"


def _cluster(points):
    """Group nearby detections into a few circles.

    Args:
        points (list[dict]): Detections already inside the search radius.

    Returns:
        list[dict]: Hazard rows with the frozen keys.
    """
    remaining = list(points)
    groups = []
    while remaining:
        group = [remaining.pop(0)]
        still = []
        for point in remaining:
            close = any(
                haversine_km(point["lat"], point["lng"], member["lat"], member["lng"]) <= 2
                for member in group
            )
            if close:
                group.append(point)
            else:
                still.append(point)
        remaining = still
        groups.append(group)
    groups.sort(key=lambda members: sum(item["frp"] for item in members), reverse=True)
    return [_cluster_row(members) for members in groups[:MAX_CLUSTERS]]


def _cluster_row(members):
    """Collapse one group of detections into a hazard row.

    Args:
        members (list[dict]): Detections that belong together.

    Returns:
        dict: One fire hazard.
    """
    lat = sum(item["lat"] for item in members) / len(members)
    lng = sum(item["lng"] for item in members) / len(members)
    spread = max(haversine_km(lat, lng, item["lat"], item["lng"]) for item in members)
    rank = max(item["rank"] for item in members)
    if any(item["frp"] >= 20 for item in members):
        rank = 3
    return {
        "id": f"firms_{lat:.2f}_{lng:.2f}",
        "kind": "fire",
        "lat": round(lat, 5),
        "lng": round(lng, 5),
        "radius_km": round(max(MIN_RADIUS_KM, spread + 0.3), 2),
        "severity": {1: "moderate", 2: "severe", 3: "extreme"}[rank],
        "source": "firms",
        "updated_at": max(item["updated_at"] for item in members),
    }
