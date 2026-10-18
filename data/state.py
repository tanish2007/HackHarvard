"""Stand-in for Tirth's GET /state.

The body matches core/src/contracts.ts. Swap the URL for his endpoint
when it is live. Do not add keys he does not return.
"""

from __future__ import annotations

from datetime import datetime, timezone

from data.api import get_hazards, get_shelters
from data.scenario import load_scenario

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


def build_state():
    """Assemble the live picture from the scenario and the data functions.

    Returns:
        dict: Contract D. List fields are always lists.
    """
    scenario = load_scenario()
    fire = scenario["fire_area"]
    center = scenario["incident"]["center"]
    radius = scenario["settings"]["alert_radius_km"]
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
