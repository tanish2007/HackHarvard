"""Shape tests for Contract C and the /state stand-in."""

from __future__ import annotations

import os
import unittest

from data.api import get_hazards, get_route, get_shelters, get_weather
from data.errors import DataSourceError
from data.geo import haversine_km
from data.scenario import load_scenario
from data.state import build_route, build_state, build_weather
from data import http


class ContractTests(unittest.TestCase):
    """The fake payloads match the frozen keys."""

    def setUp(self):
        """Keep .env from turning these tests into live calls."""
        os.environ["DATA_MODE"] = "fake"

    def tearDown(self):
        """Drop the data mode set by a test or by .env."""
        os.environ.pop("DATA_MODE", None)

    def test_hazards_near_the_fire(self):
        """A search on the fire returns fire and weather rows."""
        fire = load_scenario()["fire_area"]
        rows = get_hazards(fire["lat"], fire["lng"], 5)
        self.assertGreaterEqual(len(rows), 1)
        kinds = {row["kind"] for row in rows}
        self.assertIn("fire", kinds)
        for row in rows:
            self.assertEqual(
                set(row),
                {
                    "id",
                    "kind",
                    "lat",
                    "lng",
                    "radius_km",
                    "severity",
                    "source",
                    "updated_at",
                },
            )
            self.assertEqual(row["source"], "fake")
            self.assertIn(row["kind"], ("fire", "weather"))

    def test_far_search_is_an_empty_list(self):
        """A distant search returns an empty list, not null."""
        rows = get_hazards(0, 0, 1)
        self.assertEqual(rows, [])

    def test_shelters_are_sorted_and_complete(self):
        """Shelters include distance and come back nearest first."""
        rows = get_shelters(37.71, -122.44)
        self.assertGreaterEqual(len(rows), 2)
        distances = [row["distance_km"] for row in rows]
        self.assertEqual(distances, sorted(distances))
        self.assertIn("capacity_note", rows[0])
        self.assertEqual(rows[0]["source"], "fake")

    def test_route_for_the_map(self):
        """The map route is Amit's line to the nearest scenario shelter."""
        route = build_route()
        self.assertEqual(
            {"distance_km", "duration_min", "steps", "polyline", "avoided_hazards", "source"}
            <= set(route),
            True,
        )
        self.assertEqual(route["person_name"], "Amit")
        self.assertEqual(route["shelter_name"], "Shelter C")
        self.assertGreater(len(route["polyline"]), 1)
        self.assertNotIn("route", build_state())

    def test_forecast_for_the_map(self):
        """The map forecast uses the incident center and the weather shape."""
        forecast = build_weather()
        self.assertEqual(
            set(forecast),
            {"summary", "wind_mph", "wind_dir", "temp_f", "next_2h", "source"},
        )
        self.assertEqual(forecast["source"], "fake")

    def test_weather_shape(self):
        """Weather returns the frozen forecast keys."""
        forecast = get_weather(37.71, -122.44)
        self.assertEqual(
            set(forecast),
            {"summary", "wind_mph", "wind_dir", "temp_f", "next_2h", "source"},
        )

    def test_route_avoids_the_fire(self):
        """A line through the fire gains a waypoint outside the circle."""
        fire = load_scenario()["fire_area"]
        route = get_route(fire["lat"] - 0.01, fire["lng"] - 0.015, fire["lat"] + 0.01, fire["lng"] + 0.015)
        self.assertEqual(route["source"], "fake")
        self.assertIn("hz_scenario_fire", route["avoided_hazards"])
        self.assertGreaterEqual(len(route["polyline"]), 3)
        self.assertIsInstance(route["steps"], list)
        for left, right in zip(route["polyline"], route["polyline"][1:]):
            self.assertGreater(
                _segment_clears(left, right, fire),
                fire["radius_km"],
            )

    def test_real_mode_falls_back(self):
        """A dead live source falls back, except fires, which stay empty."""
        os.environ["DATA_MODE"] = "real"
        os.environ.pop("FIRMS_MAP_KEY", None)

        def fail(url, headers=None, timeout=4):
            """Refuse every live call.

            Args:
                url (str): Request URL.
                headers (dict | None): Ignored.
                timeout (float): Ignored.

            Raises:
                DataSourceError: Always.
            """
            del url, headers, timeout
            raise DataSourceError("down")

        original_text = http.fetch_text
        original_json = http.fetch_json
        http.fetch_text = fail
        http.fetch_json = fail
        try:
            fire = load_scenario()["fire_area"]
            rows = get_hazards(fire["lat"], fire["lng"], 10)
            route = get_route(fire["lat"] - 0.01, fire["lng"] - 0.015, fire["lat"] + 0.01, fire["lng"] + 0.015)
            shelters = get_shelters(fire["lat"], fire["lng"])
            forecast = get_weather(fire["lat"], fire["lng"])
        finally:
            http.fetch_text = original_text
            http.fetch_json = original_json
        self.assertEqual(rows, [])
        self.assertEqual(route["source"], "fallback")
        self.assertTrue(shelters)
        self.assertTrue(all(row["source"] == "fallback" for row in shelters))
        self.assertEqual(forecast["source"], "fallback")

    def test_live_error_message_is_plain_text(self):
        """Callers can match a live failure by its message string."""
        os.environ.pop("FIRMS_MAP_KEY", None)
        try:
            from data.api import _real_hazards

            _real_hazards(37.72, -122.45, 5)
        except DataSourceError as exc:
            self.assertIn("FIRMS_MAP_KEY", str(exc))
        else:
            self.fail("expected DataSourceError")

    def test_state_lists_and_counts(self):
        """The stand-in /state has every Contract D list and the counts."""
        state = build_state()
        for key in ("hazards", "shelters", "people", "volunteers", "reports", "units", "timeline"):
            self.assertIsInstance(state[key], list)
        self.assertEqual(state["counts"], {"safe": 45, "unconfirmed": 5, "sos": 0, "en_route": 0})
        self.assertEqual(len(state["people"]), 50)
        self.assertEqual(state["volunteers"][0]["volunteer_id"], "v_sam")
        self.assertIsNone(state["people"][0]["last_contact"])
        self.assertNotIn("phone", state["people"][0])
        self.assertEqual(state["incident"]["name"], "Oak Ridge Fire")
        self.assertEqual(state["units"][0]["unit_id"], "u_4")


def _segment_clears(left, right, fire):
    """Sample a segment and return the closest approach to the fire.

    Args:
        left (dict): Polyline point with lat and lng.
        right (dict): Polyline point with lat and lng.
        fire (dict): Hazard center.

    Returns:
        float: Smallest sampled distance to the fire center, in kilometers.
    """
    closest = haversine_km(left["lat"], left["lng"], fire["lat"], fire["lng"])
    for step in range(1, 21):
        t = step / 20
        lat = left["lat"] + (right["lat"] - left["lat"]) * t
        lng = left["lng"] + (right["lng"] - left["lng"]) * t
        closest = min(closest, haversine_km(lat, lng, fire["lat"], fire["lng"]))
    return closest


if __name__ == "__main__":
    unittest.main()
