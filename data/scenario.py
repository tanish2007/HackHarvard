"""Load the shared scenario file.

Tirth owns scenario.json. Phone numbers, names, and coordinates for this
lane are read from that file and nowhere else.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def scenario_path() -> Path:
    """Return the path to scenario.json.

    Returns:
        Path: Scenario file. Override with the SCENARIO_PATH env var.
    """
    override = os.environ.get("SCENARIO_PATH")
    if override:
        return Path(override)
    return ROOT / "scenario.json"


def load_scenario() -> dict:
    """Read scenario.json and append the simulated residents.

    The simulated people use the same seed as Core, so the map matches
    GET /state. Real phone numbers stay in scenario.local.json and are
    not read here, because this lane does not dial or text.

    Returns:
        dict: The scenario, with simulated residents added to people.

    Raises:
        FileNotFoundError: If scenario.json is missing.
        ValueError: If the file is not a JSON object.
    """
    path = scenario_path()
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"Scenario must be an object, got {type(data).__name__}")
    data["people"] = list(data["people"]) + _simulated_people(data)
    return data


def _simulated_people(scenario):
    """Build the simulated residents Core also generates.

    Args:
        scenario (dict): Parsed scenario.json, before people are expanded.

    Returns:
        list[dict]: Simulated residents. Empty when the count is 0.
    """
    sim = scenario.get("simulated_population") or {}
    count = int(sim.get("count") or 0)
    zones = scenario.get("zones") or []
    if count == 0 or not zones:
        return []
    rand = _mulberry32(int(sim["seed"]))
    names = sim["names"]
    languages = sim["languages"]
    sos = int(sim["sos"])
    unconfirmed = int(sim["unconfirmed"])
    people = []
    for index in range(count):
        zone = zones[index % len(zones)]
        lats = [point[0] for point in zone["polygon"]]
        lngs = [point[1] for point in zone["polygon"]]
        round_index = index // len(names)
        suffix = "" if round_index == 0 else f" {chr(65 + ((round_index - 1) % 26))}."
        if index < sos:
            status = "sos"
        elif index < sos + unconfirmed:
            status = "unconfirmed"
        else:
            status = "safe"
        people.append(
            {
                "person_id": f"sim_{index + 1:03d}",
                "name": f"{names[index % len(names)]}{suffix}",
                "role": "resident",
                "phone": None,
                "lat": _between(rand(), min(lats), max(lats)),
                "lng": _between(rand(), min(lngs), max(lngs)),
                "language": languages[index % len(languages)],
                "zone": zone["id"],
                "household_id": None,
                "family_contact": None,
                "initial_status": status,
                "simulated": True,
            }
        )
    return people


def _between(unit, low, high):
    """Map a 0 to 1 value onto a range, rounded to 5 decimal places.

    Args:
        unit (float): Value in [0, 1).
        low (float): Range start.
        high (float): Range end.

    Returns:
        float: A value in [low, high).
    """
    return round((low + unit * (high - low)) * 1e5) / 1e5


def _mulberry32(seed):
    """Match Core's seeded random generator.

    Args:
        seed (int): The scenario seed.

    Returns:
        callable: A function returning values in [0, 1).
    """
    state = _uint32(seed)

    def rand():
        """Return the next value in [0, 1).

        Returns:
            float: The next sample.
        """
        nonlocal state
        state = _uint32(state + 0x6D2B79F5)
        value = state
        value = _imul(value ^ _shr(value, 15), value | 1)
        value = _int32(value ^ _int32(value + _imul(value ^ _shr(value, 7), value | 61)))
        return _uint32(value ^ _shr(value, 14)) / 4294967296

    return rand


def _imul(left, right):
    """Match JavaScript Math.imul.

    Args:
        left (int): First factor.
        right (int): Second factor.

    Returns:
        int: The low 32 bits, as a signed integer.
    """
    return _int32(_int32(left) * _int32(right))


def _shr(value, bits):
    """Match JavaScript's unsigned right shift.

    Args:
        value (int): Value to shift.
        bits (int): How far to shift.

    Returns:
        int: The shifted unsigned value.
    """
    return _uint32(value) >> bits


def _uint32(value):
    """Keep the low 32 bits as a non-negative integer.

    Args:
        value (int): Any integer.

    Returns:
        int: Value in [0, 2^32).
    """
    return value & 0xFFFFFFFF


def _int32(value):
    """Keep the low 32 bits as a signed integer.

    Args:
        value (int): Any integer.

    Returns:
        int: Value in [-2^31, 2^31).
    """
    value = _uint32(value)
    if value >= 0x80000000:
        return value - 0x100000000
    return value
