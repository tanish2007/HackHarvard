"""Distance and fire-avoidance geometry.

Coordinates come from the caller or from scenario.json. This module does
not store places of its own.
"""

from __future__ import annotations

import math


def haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance between two points.

    Args:
        lat1 (float): Latitude of the first point.
        lng1 (float): Longitude of the first point.
        lat2 (float): Latitude of the second point.
        lng2 (float): Longitude of the second point.

    Returns:
        float: Distance in kilometers.
    """
    radius = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


def to_local_km(lat, lng, origin_lat, origin_lng):
    """Project a point into kilometers east and north of an origin.

    Args:
        lat (float): Point latitude.
        lng (float): Point longitude.
        origin_lat (float): Origin latitude.
        origin_lng (float): Origin longitude.

    Returns:
        tuple[float, float]: East and north offsets in kilometers.
    """
    east = (lng - origin_lng) * math.cos(math.radians(origin_lat)) * 111.32
    north = (lat - origin_lat) * 110.574
    return east, north


def from_local_km(east, north, origin_lat, origin_lng):
    """Invert a local kilometer offset back to latitude and longitude.

    Args:
        east (float): Kilometers east of the origin.
        north (float): Kilometers north of the origin.
        origin_lat (float): Origin latitude.
        origin_lng (float): Origin longitude.

    Returns:
        tuple[float, float]: Latitude and longitude.
    """
    lat = origin_lat + north / 110.574
    lng = origin_lng + east / (math.cos(math.radians(origin_lat)) * 111.32)
    return lat, lng


def segment_distance_km(ax, ay, bx, by):
    """Distance from the local origin to a segment.

    Args:
        ax (float): Segment start, east kilometers.
        ay (float): Segment start, north kilometers.
        bx (float): Segment end, east kilometers.
        by (float): Segment end, north kilometers.

    Returns:
        float: Shortest distance from (0, 0) to the segment, in kilometers.
    """
    abx, aby = bx - ax, by - ay
    length_sq = abx * abx + aby * aby
    if length_sq == 0:
        return math.hypot(ax, ay)
    t = max(0.0, min(1.0, (-ax * abx + -ay * aby) / length_sq))
    return math.hypot(ax + t * abx, ay + t * aby)


def detour_around(lat1, lng1, lat2, lng2, hazard):
    """Bend a straight route so it stays outside a hazard circle.

    Args:
        lat1 (float): Start latitude.
        lng1 (float): Start longitude.
        lat2 (float): End latitude.
        lng2 (float): End longitude.
        hazard (dict): Hazard with lat, lng, and radius_km.

    Returns:
        list[dict] | None: Waypoint as {lat, lng}, or None if the straight
        line already clears the circle or an endpoint is inside it.
    """
    origin_lat = hazard["lat"]
    origin_lng = hazard["lng"]
    radius = float(hazard["radius_km"])
    ax, ay = to_local_km(lat1, lng1, origin_lat, origin_lng)
    bx, by = to_local_km(lat2, lng2, origin_lat, origin_lng)
    if math.hypot(ax, ay) <= radius or math.hypot(bx, by) <= radius:
        return None
    if segment_distance_km(ax, ay, bx, by) >= radius:
        return None

    dx, dy = bx - ax, by - ay
    length = math.hypot(dx, dy) or 1.0
    px, py = -dy / length, dx / length
    waypoint = None
    for scale in (1.15, 1.4, 1.8, 2.4, 3.2):
        reach = radius * scale
        for sign in (1.0, -1.0):
            wx, wy = px * reach * sign, py * reach * sign
            first = segment_distance_km(ax, ay, wx, wy)
            second = segment_distance_km(wx, wy, bx, by)
            if first >= radius and second >= radius:
                waypoint = (wx, wy)
                break
        if waypoint is not None:
            break
    if waypoint is None:
        return None
    lat, lng = from_local_km(waypoint[0], waypoint[1], origin_lat, origin_lng)
    return {"lat": round(lat, 6), "lng": round(lng, 6)}
