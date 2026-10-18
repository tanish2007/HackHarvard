"""OpenStreetMap shelters via the Overpass API.

An empty answer raises DataSourceError so the caller can use the
scenario list instead.
"""

from __future__ import annotations

from urllib.parse import urlencode

from data import http
from data.errors import DataSourceError
from data.geo import haversine_km

AROUND_METERS = 8000


def fetch_shelters(lat, lng):
    """Download shelters near a point.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.

    Returns:
        list[dict]: Shelter rows, nearest first.

    Raises:
        DataSourceError: If Overpass fails or returns nothing.
    """
    query = (
        f"[out:json][timeout:4];("
        f'node["amenity"="shelter"](around:{AROUND_METERS},{lat},{lng});'
        f'way["amenity"="shelter"](around:{AROUND_METERS},{lat},{lng});'
        f'node["social_facility"="shelter"](around:{AROUND_METERS},{lat},{lng});'
        f");out center 15;"
    )
    url = "https://overpass-api.de/api/interpreter?" + urlencode({"data": query})
    headers = {"User-Agent": "Relay/1.0 (HackHarvard demo)", "Accept": "application/json"}
    return shelters_from_overpass(http.fetch_json(url, headers=headers), lat, lng)


def shelters_from_overpass(payload, lat, lng):
    """Map an Overpass document onto the shelter shape.

    Args:
        payload (dict): Overpass JSON.
        lat (float): Origin latitude for distance_km.
        lng (float): Origin longitude for distance_km.

    Returns:
        list[dict]: Shelter rows, nearest first.

    Raises:
        DataSourceError: If elements is missing or empty.
    """
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise DataSourceError("Overpass payload has no elements")
    rows = []
    for element in elements:
        point = _point(element)
        if point is None:
            continue
        tags = element.get("tags") or {}
        rows.append(
            {
                "id": f"osm_{element.get('type', 'node')}_{element.get('id')}",
                "name": tags.get("name") or "Shelter",
                "lat": point[0],
                "lng": point[1],
                "distance_km": round(haversine_km(lat, lng, point[0], point[1]), 2),
                "capacity_note": tags.get("capacity") or tags.get("description") or "Listed on OpenStreetMap",
                "source": "osm",
            }
        )
    if not rows:
        raise DataSourceError("Overpass returned no shelters")
    rows.sort(key=lambda row: row["distance_km"])
    return rows


def _point(element):
    """Read a node coordinate or a way center.

    Args:
        element (dict): One Overpass element.

    Returns:
        tuple[float, float] | None: Latitude and longitude.
    """
    if "lat" in element and "lon" in element:
        return float(element["lat"]), float(element["lon"])
    center = element.get("center") or {}
    if "lat" in center and "lon" in center:
        return float(center["lat"]), float(center["lon"])
    return None
