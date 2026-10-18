"""Contract C. Four functions Tirth can call.

DATA_MODE=fake reads scenario.json. DATA_MODE=real tries the live source
and, on failure, returns the same shape with source set to fallback.
Fire rows are the exception: real mode returns NASA FIRMS only, or an
empty list when FIRMS does not answer. The scenario fire is never a stand-in.
"""

from __future__ import annotations

import os

from data.errors import DataSourceError
from data.firms import fetch_fire_hazards
from data.geo import haversine_km
from data.nws import fetch_weather, fetch_weather_hazards
from data.overpass import fetch_shelters
from data.routing import fetch_route, geometric_route
from data.scenario import load_scenario


def get_hazards(lat, lng, radius_km):
    """Return fire and weather hazards near a point.

    Args:
        lat (float): Search latitude.
        lng (float): Search longitude.
        radius_km (float): How far to look, in kilometers.

    Returns:
        list[dict]: Hazard rows. Empty when nothing is in range.
        In real mode, fire rows are FIRMS detections only.
    """
    if os.environ.get("DATA_MODE", "fake") != "real":
        return _fake_hazards(lat, lng, radius_km)
    fires = _live_fires(lat, lng, radius_km)
    try:
        weather = fetch_weather_hazards(lat, lng)
    except DataSourceError:
        weather = []
    return fires + weather


def get_route(from_lat, from_lng, to_lat, to_lng, profile="driving"):
    """Return a route that stays outside known fire circles.

    Args:
        from_lat (float): Start latitude.
        from_lng (float): Start longitude.
        to_lat (float): End latitude.
        to_lng (float): End longitude.
        profile (str): "foot" asks OpenStreetMap for a walking path.
            Anything else keeps the driving route.

    Returns:
        dict: distance_km, duration_min, steps, polyline, avoided_hazards, source.
    """
    if profile == "foot":
        try:
            return _walking_route(from_lat, from_lng, to_lat, to_lng)
        except DataSourceError:
            fallback = _fake_route(from_lat, from_lng, to_lat, to_lng)
            fallback["source"] = "fallback"
            return fallback
    return _with_fallback(
        lambda: _real_route(from_lat, from_lng, to_lat, to_lng),
        lambda: _fake_route(from_lat, from_lng, to_lat, to_lng),
        _stamp_obj,
    )


def get_shelters(lat, lng):
    """Return shelters nearest to a point.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.

    Returns:
        list[dict]: Shelter rows, nearest first. Empty if none exist.
    """
    return _with_fallback(
        lambda: _real_shelters(lat, lng),
        lambda: _fake_shelters(lat, lng),
        _stamp_rows,
    )


def get_weather(lat, lng):
    """Return the short forecast for a point.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.

    Returns:
        dict: summary, wind_mph, wind_dir, temp_f, next_2h, and source.
    """
    return _with_fallback(
        lambda: _real_weather(lat, lng),
        lambda: _fake_weather(lat, lng),
        _stamp_obj,
    )


def _with_fallback(real, fake, stamp):
    """Call the live source, or the fake if live mode is off or it fails.

    Args:
        real (callable): Live implementation. May raise DataSourceError.
        fake (callable): Fake implementation with the same return shape.
        stamp (callable): Marks a fallback payload with source fallback.

    Returns:
        list | dict: The live payload, or the stamped fake payload.
    """
    if os.environ.get("DATA_MODE", "fake") != "real":
        return fake()
    try:
        return real()
    except DataSourceError:
        payload = fake()
        stamp(payload)
        return payload


def _stamp_rows(rows):
    """Mark every row as a fallback.

    Args:
        rows (list[dict]): Fake rows that include a source key.
    """
    for row in rows:
        row["source"] = "fallback"


def _stamp_obj(payload):
    """Mark one object as a fallback.

    Args:
        payload (dict): Fake object that includes a source key.
    """
    payload["source"] = "fallback"


def _live_fires(lat, lng, radius_km):
    """Return FIRMS fires, or nothing when FIRMS does not answer.

    Args:
        lat (float): Search latitude.
        lng (float): Search longitude.
        radius_km (float): Search radius in kilometers.

    Returns:
        list[dict]: Fire rows with source firms. Empty on failure.
    """
    try:
        return fetch_fire_hazards(lat, lng, radius_km)
    except DataSourceError:
        return []


def _real_hazards(lat, lng, radius_km):
    """Fetch FIRMS fires and NWS alerts near a point.

    Args:
        lat (float): Search latitude.
        lng (float): Search longitude.
        radius_km (float): Search radius in kilometers.

    Returns:
        list[dict]: Fire rows, then weather rows. Empty when both are quiet.

    Raises:
        DataSourceError: If FIRMS or NWS fails. An empty list is not a failure.
    """
    fires = fetch_fire_hazards(lat, lng, radius_km)
    weather = fetch_weather_hazards(lat, lng)
    return fires + weather


def _real_route(from_lat, from_lng, to_lat, to_lng):
    """Fetch a road route that stays outside live fire circles.

    Args:
        from_lat (float): Start latitude.
        from_lng (float): Start longitude.
        to_lat (float): End latitude.
        to_lng (float): End longitude.

    Returns:
        dict: Route fields. source is osrm only when the road line is used.

    Raises:
        DataSourceError: If FIRMS or OSRM fails.
    """
    mid_lat = (from_lat + to_lat) / 2
    mid_lng = (from_lng + to_lng) / 2
    span = haversine_km(from_lat, from_lng, to_lat, to_lng)
    fires = fetch_fire_hazards(mid_lat, mid_lng, max(span / 2 + 5, 10))
    scenario = load_scenario()
    shelter_name = _nearest_shelter_name(to_lat, to_lng, scenario)
    return fetch_route(from_lat, from_lng, to_lat, to_lng, fires, shelter_name)


def _real_shelters(lat, lng):
    """Fetch OpenStreetMap shelters near a point.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.

    Returns:
        list[dict]: Shelter rows, nearest first.

    Raises:
        DataSourceError: If Overpass fails or finds nothing. The caller
        then uses the scenario list.
    """
    return fetch_shelters(lat, lng)


def _real_weather(lat, lng):
    """Fetch the NWS hourly forecast for a point.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.

    Returns:
        dict: Forecast fields plus source.

    Raises:
        DataSourceError: If NWS fails.
    """
    return fetch_weather(lat, lng)


def _fake_hazards(lat, lng, radius_km):
    """Build hazards from the scenario that overlap the search circle.

    Args:
        lat (float): Search latitude.
        lng (float): Search longitude.
        radius_km (float): Search radius in kilometers.

    Returns:
        list[dict]: Matching hazard rows.
    """
    rows = []
    for fire in _scenario_fires(load_scenario()):
        distance = haversine_km(lat, lng, fire["lat"], fire["lng"])
        if distance <= float(radius_km) + float(fire["radius_km"]):
            rows.append(fire)
    return rows


def _fake_shelters(lat, lng):
    """Build the scenario shelter list with distances filled in.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.

    Returns:
        list[dict]: Shelters sorted nearest first.
    """
    rows = []
    for shelter in load_scenario()["shelters"]:
        rows.append(
            {
                "id": shelter["id"],
                "name": shelter["name"],
                "lat": shelter["lat"],
                "lng": shelter["lng"],
                "distance_km": round(haversine_km(lat, lng, shelter["lat"], shelter["lng"]), 2),
                "capacity_note": shelter["capacity_note"],
                "source": "fake",
            }
        )
    rows.sort(key=lambda row: row["distance_km"])
    return rows


def _fake_weather(lat, lng):
    """Return the scenario's demo forecast.

    Reads fake_weather from scenario.json, the same block Core's stub uses,
    so the map's wind and Core's fire spread forecast always agree. Falls
    back to a standing forecast if the scenario has no weather block.

    Args:
        lat (float): Latitude in decimal degrees. Unused by the fake.
        lng (float): Longitude in decimal degrees. Unused by the fake.

    Returns:
        dict: Forecast fields plus source fake.
    """
    del lat, lng
    weather = load_scenario().get("fake_weather")
    if weather:
        return {
            "summary": weather["summary"],
            "wind_mph": weather["wind_mph"],
            "wind_dir": weather["wind_dir"],
            "temp_f": weather["temp_f"],
            "next_2h": weather["next_2h"],
            "source": "fake",
        }
    return {
        "summary": "Dry and gusty",
        "wind_mph": 18,
        "wind_dir": "NE",
        "temp_f": 84,
        "next_2h": "Gusts continue from the northeast",
        "source": "fake",
    }


def _walking_route(from_lat, from_lng, to_lat, to_lng):
    """Ask OpenStreetMap for a foot path to the point.

    The scenario fire is the circle to stay outside of. The geometry stays
    the walking path even if that circle is unavoidable.

    Args:
        from_lat (float): Start latitude.
        from_lng (float): Start longitude.
        to_lat (float): End latitude.
        to_lng (float): End longitude.

    Returns:
        dict: Route fields. source is osrm when the path is used.

    Raises:
        DataSourceError: If OpenStreetMap returns no path.
    """
    scenario = load_scenario()
    return fetch_route(
        from_lat,
        from_lng,
        to_lat,
        to_lng,
        _scenario_fires(scenario),
        _nearest_shelter_name(to_lat, to_lng, scenario),
        profile="foot",
        allow_geometric=False,
    )


def _fake_route(from_lat, from_lng, to_lat, to_lng):
    """Build a straight route, detouring around the scenario fire.

    Args:
        from_lat (float): Start latitude.
        from_lng (float): Start longitude.
        to_lat (float): End latitude.
        to_lng (float): End longitude.

    Returns:
        dict: Route fields plus source fake.
    """
    scenario = load_scenario()
    shelter_name = _nearest_shelter_name(to_lat, to_lng, scenario)
    return geometric_route(
        from_lat,
        from_lng,
        to_lat,
        to_lng,
        _scenario_fires(scenario),
        shelter_name,
    )


def _scenario_fire(scenario):
    """Return the scenario fire in the hazard shape.

    Args:
        scenario (dict): Loaded scenario. The fire lives under fire_area.

    Returns:
        dict: One fire hazard. The id matches Core's placeholder.
    """
    fire = scenario["fire_area"]
    return _fire_row("hz_scenario_fire", fire)


def _scenario_fires(scenario):
    """Return every dummy fire, the main one first.

    Args:
        scenario (dict): Loaded scenario. Extra fires live under extra_fires.

    Returns:
        list[dict]: Fire hazards in the Contract C shape.
    """
    fires = [_scenario_fire(scenario)]
    for extra in scenario.get("extra_fires") or []:
        fires.append(_fire_row(extra["id"], extra))
    return fires


def _fire_row(fire_id, fire):
    """One fire circle in the hazard shape.

    Args:
        fire_id (str): Hazard id.
        fire (dict): lat, lng, and radius_km.

    Returns:
        dict: A fire hazard with source fake.
    """
    return {
        "id": fire_id,
        "kind": "fire",
        "lat": fire["lat"],
        "lng": fire["lng"],
        "radius_km": fire["radius_km"],
        "severity": "high",
        "source": "fake",
        "updated_at": "",
    }


def _nearest_shelter_name(lat, lng, scenario):
    """Pick the shelter name closest to a point.

    Args:
        lat (float): Latitude in decimal degrees.
        lng (float): Longitude in decimal degrees.
        scenario (dict): Loaded scenario.

    Returns:
        str: Shelter name, or "the shelter" if the list is empty.
    """
    shelters = scenario["shelters"]
    if not shelters:
        return "the shelter"
    nearest = min(
        shelters,
        key=lambda shelter: haversine_km(lat, lng, shelter["lat"], shelter["lng"]),
    )
    return nearest["name"]
