"""Driving routes that stay outside fire circles.

Public OSRM cannot exclude a polygon. The call goes through a waypoint
from detour_around. If the road line still enters a fire, the geometric
detour is returned instead, and source is not osrm.
"""

from __future__ import annotations

from data import http
from data.errors import DataSourceError
from data.geo import detour_around, haversine_km

EVAC_KMH = 40.0


def fetch_route(from_lat, from_lng, to_lat, to_lng, fires, shelter_name):
    """Ask OSRM for a road line, or use the geometric detour if it clips.

    Args:
        from_lat (float): Start latitude.
        from_lng (float): Start longitude.
        to_lat (float): End latitude.
        to_lng (float): End longitude.
        fires (list[dict]): Fire hazards with lat, lng, radius_km, and id.
        shelter_name (str): Name used in the step text.

    Returns:
        dict: Route fields. source is osrm only when the road line is used.

    Raises:
        DataSourceError: If OSRM rejects the request or returns no route.
    """
    start = {"lat": from_lat, "lng": from_lng}
    end = {"lat": to_lat, "lng": to_lng}
    via, avoided = via_points(start, end, fires)
    payload = http.fetch_json(_osrm_url(via))
    road = polyline_from_osrm(payload)
    if enters_any(road, fires):
        return geometric_route(from_lat, from_lng, to_lat, to_lng, fires, shelter_name)
    route = payload["routes"][0]
    return {
        "distance_km": round(float(route["distance"]) / 1000.0, 2),
        "duration_min": round(float(route["duration"]) / 60.0, 1),
        "steps": _osrm_steps(route, shelter_name),
        "polyline": road,
        "avoided_hazards": avoided,
        "source": "osrm",
    }


def geometric_route(from_lat, from_lng, to_lat, to_lng, fires, shelter_name):
    """Build the straight route that bends around each fire circle.

    Args:
        from_lat (float): Start latitude.
        from_lng (float): Start longitude.
        to_lat (float): End latitude.
        to_lng (float): End longitude.
        fires (list[dict]): Fire hazards with lat, lng, radius_km, and id.
        shelter_name (str): Name used in the step text.

    Returns:
        dict: Route fields with source fake.
    """
    start = {"lat": from_lat, "lng": from_lng}
    end = {"lat": to_lat, "lng": to_lng}
    via, avoided = via_points(start, end, fires)
    distance = 0.0
    for left, right in zip(via, via[1:]):
        distance += haversine_km(left["lat"], left["lng"], right["lat"], right["lng"])
    steps = [f"Leave toward {shelter_name}."]
    for fire_id in avoided:
        steps.append(f"Stay outside the {fire_id} fire circle.")
    steps.append(f"Arrive at {shelter_name}.")
    return {
        "distance_km": round(distance, 2),
        "duration_min": round(distance / EVAC_KMH * 60, 1),
        "steps": steps,
        "polyline": via,
        "avoided_hazards": avoided,
        "source": "fake",
    }


def via_points(start, end, fires):
    """Insert a waypoint for each fire the straight line would enter.

    Args:
        start (dict): Point with lat and lng.
        end (dict): Point with lat and lng.
        fires (list[dict]): Fire hazards.

    Returns:
        tuple[list[dict], list[str]]: Polyline points, and the fire ids
        that forced a waypoint.
    """
    points = [start]
    cursor_lat, cursor_lng = start["lat"], start["lng"]
    avoided = []
    for fire in fires:
        waypoint = detour_around(cursor_lat, cursor_lng, end["lat"], end["lng"], fire)
        if not waypoint:
            continue
        points.append(waypoint)
        cursor_lat, cursor_lng = waypoint["lat"], waypoint["lng"]
        avoided.append(fire["id"])
    points.append(end)
    return points, avoided


def polyline_from_osrm(payload):
    """Read a lat/lng polyline from an OSRM route document.

    Args:
        payload (dict): OSRM JSON.

    Returns:
        list[dict]: Points as {lat, lng}.

    Raises:
        DataSourceError: If OSRM did not return a route.
    """
    if payload.get("code") != "Ok" or not payload.get("routes"):
        message = payload.get("message") or "OSRM rejected the route"
        raise DataSourceError(str(message))
    coordinates = payload["routes"][0].get("geometry", {}).get("coordinates") or []
    if len(coordinates) < 2:
        raise DataSourceError("OSRM returned no road line")
    return [{"lat": lat, "lng": lng} for lng, lat in coordinates]


def enters_any(polyline, fires):
    """Check whether a polyline comes inside any fire circle.

    Args:
        polyline (list[dict]): Points with lat and lng.
        fires (list[dict]): Fire hazards with lat, lng, and radius_km.

    Returns:
        bool: True when any sampled segment enters a circle.
    """
    for fire in fires:
        if _closest(polyline, fire) <= float(fire["radius_km"]):
            return True
    return False


def _closest(polyline, fire):
    """Sample a polyline and return the closest approach to a fire.

    Args:
        polyline (list[dict]): Points with lat and lng.
        fire (dict): Hazard center.

    Returns:
        float: Smallest sampled distance in kilometers.
    """
    closest = haversine_km(polyline[0]["lat"], polyline[0]["lng"], fire["lat"], fire["lng"])
    for left, right in zip(polyline, polyline[1:]):
        for step in range(1, 21):
            t = step / 20
            lat = left["lat"] + (right["lat"] - left["lat"]) * t
            lng = left["lng"] + (right["lng"] - left["lng"]) * t
            closest = min(closest, haversine_km(lat, lng, fire["lat"], fire["lng"]))
    return closest


def _osrm_url(points):
    """Build an OSRM driving URL.

    Args:
        points (list[dict]): Ordered points with lat and lng.

    Returns:
        str: Request URL with a full GeoJSON overview.
    """
    coords = ";".join(f"{point['lng']:.5f},{point['lat']:.5f}" for point in points)
    return (
        "https://router.project-osrm.org/route/v1/driving/"
        f"{coords}?overview=full&geometries=geojson&steps=true"
    )


def _osrm_steps(route, shelter_name):
    """Turn OSRM steps into short sentences.

    Args:
        route (dict): One OSRM route object.
        shelter_name (str): Destination name.

    Returns:
        list[str]: Step sentences.
    """
    sentences = []
    for leg in route.get("legs") or []:
        for step in leg.get("steps") or []:
            maneuver = (step.get("maneuver") or {}).get("type") or "continue"
            road = step.get("name") or "the road"
            sentences.append(f"{maneuver.replace('_', ' ')} on {road}.")
    if not sentences:
        sentences.append(f"Follow the road toward {shelter_name}.")
    sentences.append(f"Arrive at {shelter_name}.")
    return sentences
