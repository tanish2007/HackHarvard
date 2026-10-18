"""Stand-in for Tirth's GET /state.

The body matches core/src/contracts.ts. Swap the URL for his endpoint
when it is live. Do not add keys he does not return.
"""

from __future__ import annotations

from datetime import datetime, timezone

from data.api import get_hazards, get_route, get_shelters, get_weather
from data.scenario import load_scenario

MAP_HAZARD_RADIUS_KM = 25
HAZARD_KEYS = (
    "id",
    "kind",
    "lat",
    "lng",
    "radius_km",
    "severity",
    "source",
    "updated_at",
)


def build_weather():
    """Return the live forecast at the incident center.

    This is Contract C, not a new key on GET /state. The map asks for it
    on its own so Tirth's picture stays unchanged.

    Returns:
        dict: summary, wind_mph, wind_dir, temp_f, next_2h, and source.
    """
    center = load_scenario()["incident"]["center"]
    return get_weather(center["lat"], center["lng"])


def build_route():
    """Return one resident's route to the nearest shelter.

    The resident is the first unconfirmed person in the scenario who is
    not part of the simulated crowd. The map draws this line itself.
    It is not a field on GET /state.

    Returns:
        dict: Route fields plus person_name and shelter_name.
    """
    person = _route_person(load_scenario()["people"])
    shelters = get_shelters(person["lat"], person["lng"])
    if shelters:
        shelter = shelters[0]
        route = get_route(person["lat"], person["lng"], shelter["lat"], shelter["lng"])
        shelter_name = shelter["name"]
    else:
        route = {
            "distance_km": 0.0,
            "duration_min": 0.0,
            "steps": [],
            "polyline": [],
            "avoided_hazards": [],
            "source": "fallback",
        }
        shelter_name = ""
    labeled = dict(route)
    labeled["person_name"] = person["name"]
    labeled["shelter_name"] = shelter_name
    return labeled


def _route_person(people):
    """Pick the resident whose route the map should draw.

    Args:
        people (list[dict]): Scenario people, including simulated rows.

    Returns:
        dict: One resident. Unconfirmed named residents come first.
    """
    residents = [
        person
        for person in people
        if person.get("role") == "resident" and not person.get("simulated")
    ]
    for person in residents:
        if person.get("initial_status") == "unconfirmed":
            return person
    if residents:
        return residents[0]
    return people[0]


def build_state():
    """Assemble the live picture from the scenario and the data functions.

    The hazard search is at least 25 km. The 4 km alert radius is quiet, and
    the nearest NOAA-21 detections sit farther out.

    Returns:
        dict: Contract D. List fields are always lists.
    """
    scenario = load_scenario()
    fire = scenario["fire_area"]
    center = scenario["incident"]["center"]
    radius = max(scenario["settings"]["alert_radius_km"], MAP_HAZARD_RADIUS_KM)
    hazards = [
        {key: hazard[key] for key in HAZARD_KEYS}
        for hazard in get_hazards(fire["lat"], fire["lng"], radius)
    ]
    shelters = [
        {
            "id": shelter["id"],
            "name": shelter["name"],
            "lat": shelter["lat"],
            "lng": shelter["lng"],
            "distance_km": shelter["distance_km"],
            "capacity_note": shelter["capacity_note"],
        }
        for shelter in get_shelters(center["lat"], center["lng"])
    ]
    people = []
    volunteers = []
    for person in scenario["people"]:
        if person["role"] == "volunteer":
            volunteers.append(
                {
                    "volunteer_id": person["person_id"],
                    "name": person["name"],
                    "lat": person["lat"],
                    "lng": person["lng"],
                    "capacity_note": "",
                    "status": "available",
                }
            )
            continue
        people.append(
            {
                "person_id": person["person_id"],
                "name": person["name"],
                "lat": person["lat"],
                "lng": person["lng"],
                "status": person["initial_status"],
                "last_contact": None,
                "language": person["language"],
            }
        )
    people.sort(key=lambda person: person["status"] != "sos")
    return {
        "incident": {
            "name": scenario["incident"]["name"],
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        },
        "hazards": hazards,
        "shelters": shelters,
        "people": people,
        "volunteers": volunteers,
        "reports": [],
        "units": [
            {"unit_id": unit["unit_id"], "name": unit["name"], "last_heard": None}
            for unit in scenario["units"]
        ],
        "timeline": [],
        "counts": {
            "safe": _count(people, "safe"),
            "unconfirmed": _count(people, "unconfirmed"),
            "sos": _count(people, "sos"),
            "en_route": _count(people, "en_route"),
        },
    }


def _count(people, status):
    """Count residents in one status.

    Args:
        people (list[dict]): Contract D people rows.
        status (str): safe, unconfirmed, sos, or en_route.

    Returns:
        int: How many rows match.
    """
    return sum(1 for person in people if person["status"] == status)
