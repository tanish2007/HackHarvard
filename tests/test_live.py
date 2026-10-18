"""Fixture tests for FIRMS, NWS, OSRM, and Overpass parsers."""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from data import http
from data.api import get_hazards, get_route, get_weather
from data.errors import DataSourceError
from data.firms import hazards_from_csv
from data.geo import haversine_km
from data.nws import hazards_from_alerts, weather_from_hourly
from data.overpass import shelters_from_overpass
from data.routing import fetch_route

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIRE = {"id": "hz_oak_ridge", "lat": 37.72, "lng": -122.45, "radius_km": 1.2}


class LiveFixtureTests(unittest.TestCase):
    """Live parsers keep the frozen shapes without calling the network."""

    def setUp(self):
        """Remember the HTTP helpers so a test can stub them."""
        self.fetch_text = http.fetch_text
        self.fetch_json = http.fetch_json
        self.firms_key = os.environ.get("FIRMS_MAP_KEY")

    def tearDown(self):
        """Restore HTTP helpers and the FIRMS key."""
        http.fetch_text = self.fetch_text
        http.fetch_json = self.fetch_json
        os.environ.pop("DATA_MODE", None)
        if self.firms_key is None:
            os.environ.pop("FIRMS_MAP_KEY", None)
        else:
            os.environ["FIRMS_MAP_KEY"] = self.firms_key

    def test_firms_csv_clusters_inside_the_radius(self):
        """Two nearby detections become one fire, and a far one stays separate."""
        text = (FIXTURES / "firms.csv").read_text(encoding="utf-8")
        rows = hazards_from_csv(text, 37.72, -122.45, 20)
        self.assertGreaterEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(row["kind"], "fire")
            self.assertEqual(row["source"], "firms")
            self.assertIn(row["severity"], ("moderate", "severe", "extreme"))
            self.assertLessEqual(
                haversine_km(37.72, -122.45, row["lat"], row["lng"]),
                20,
            )
        near = hazards_from_csv(text, 37.72, -122.45, 2)
        self.assertEqual(len(near), 1)
        self.assertEqual(near[0]["severity"], "extreme")

    def test_firms_error_body_raises(self):
        """A non-CSV body is a failure, not an empty fire list."""
        with self.assertRaises(DataSourceError) as caught:
            hazards_from_csv("Invalid MAP_KEY", 37.72, -122.45, 5)
        self.assertIn("Invalid", str(caught.exception))

    def test_nws_hourly_shape(self):
        """The hourly fixture fills the frozen forecast keys."""
        payload = json.loads((FIXTURES / "nws_hourly.json").read_text(encoding="utf-8"))
        forecast = weather_from_hourly(payload)
        self.assertEqual(forecast["source"], "nws")
        self.assertEqual(forecast["wind_mph"], 28)
        self.assertEqual(forecast["wind_dir"], "NE")
        self.assertEqual(forecast["temp_f"], 86)
        self.assertIn("Gusts ease", forecast["next_2h"])

    def test_nws_alert_becomes_a_weather_hazard(self):
        """An active alert becomes one weather row at the query point."""
        payload = json.loads((FIXTURES / "nws_alerts.json").read_text(encoding="utf-8"))
        rows = hazards_from_alerts(payload, 37.71, -122.44)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["kind"], "weather")
        self.assertEqual(rows[0]["source"], "nws")
        self.assertEqual(rows[0]["severity"], "severe")
        self.assertEqual(rows[0]["id"], "urn:oid:red-flag")

    def test_real_hazards_join_fixtures(self):
        """DATA_MODE=real returns FIRMS fires and NWS alerts from fixtures."""
        os.environ["DATA_MODE"] = "real"
        os.environ["FIRMS_MAP_KEY"] = "test-key"
        csv_text = (FIXTURES / "firms.csv").read_text(encoding="utf-8")
        alerts = json.loads((FIXTURES / "nws_alerts.json").read_text(encoding="utf-8"))

        def fetch_text(url, headers=None, timeout=4):
            """Return the FIRMS fixture.

            Args:
                url (str): Request URL.
                headers (dict | None): Ignored.
                timeout (float): Ignored.

            Returns:
                str: CSV body.

            Raises:
                DataSourceError: If the URL is not the FIRMS area call.
            """
            if "firms.modaps.eosdis.nasa.gov" not in url or "VIIRS_NOAA21_NRT" not in url or not url.endswith("/2"):
                raise DataSourceError(url)
            return csv_text

        def fetch_json(url, headers=None, timeout=4):
            """Return the alerts fixture.

            Args:
                url (str): Request URL.
                headers (dict | None): Ignored.
                timeout (float): Ignored.

            Returns:
                dict: Alerts payload.

            Raises:
                DataSourceError: If the URL is not the alerts call.
            """
            if "alerts/active" not in url:
                raise DataSourceError(url)
            return alerts

        http.fetch_text = fetch_text
        http.fetch_json = fetch_json
        rows = get_hazards(37.72, -122.45, 20)
        sources = {row["source"] for row in rows}
        self.assertIn("firms", sources)
        self.assertIn("nws", sources)
        self.assertTrue(all(row["kind"] in ("fire", "weather") for row in rows))

    def test_clear_road_keeps_the_osrm_source(self):
        """A road line outside the fire is returned as osrm."""
        payload = _osrm([[-122.50, 37.70], [-122.50, 37.74]])

        def fetch_json(url, headers=None, timeout=4):
            """Return a road line west of the fire.

            Args:
                url (str): Request URL.
                headers (dict | None): Ignored.
                timeout (float): Ignored.

            Returns:
                dict: OSRM payload.
            """
            del url, headers, timeout
            return payload

        http.fetch_json = fetch_json
        route = fetch_route(37.70, -122.50, 37.74, -122.50, [FIRE], "Civic Center Shelter")
        self.assertEqual(route["source"], "osrm")
        self.assertEqual(route["polyline"][0]["lng"], -122.50)
        self.assertGreater(route["distance_km"], 0)

    def test_clipping_road_uses_the_geometric_detour(self):
        """A road line through the fire is dropped for the tested detour."""
        payload = _osrm([[-122.47, 37.70], [-122.43, 37.74]])

        def fetch_json(url, headers=None, timeout=4):
            """Return a road line that crosses the fire.

            Args:
                url (str): Request URL.
                headers (dict | None): Ignored.
                timeout (float): Ignored.

            Returns:
                dict: OSRM payload.
            """
            del url, headers, timeout
            return payload

        http.fetch_json = fetch_json
        route = fetch_route(37.70, -122.47, 37.74, -122.43, [FIRE], "Civic Center Shelter")
        self.assertNotEqual(route["source"], "osrm")
        self.assertIn(FIRE["id"], route["avoided_hazards"])
        for left, right in zip(route["polyline"], route["polyline"][1:]):
            self.assertGreater(_closest(left, right, FIRE), FIRE["radius_km"])

    def test_get_route_labels_a_clear_fixture_as_osrm(self):
        """The public route function keeps source osrm when the line is clear."""
        os.environ["DATA_MODE"] = "real"
        os.environ["FIRMS_MAP_KEY"] = "test-key"
        calls = {"text": 0}

        def fetch_text(url, headers=None, timeout=4):
            """Return a header-only FIRMS file so the corridor has no fires.

            Args:
                url (str): Request URL.
                headers (dict | None): Ignored.
                timeout (float): Ignored.

            Returns:
                str: CSV header.
            """
            del url, headers, timeout
            calls["text"] += 1
            return "latitude,longitude,acq_date,acq_time,confidence,frp\n"

        def fetch_json(url, headers=None, timeout=4):
            """Return a short clear road line.

            Args:
                url (str): Request URL.
                headers (dict | None): Ignored.
                timeout (float): Ignored.

            Returns:
                dict: OSRM payload.
            """
            del url, headers, timeout
            return _osrm([[-122.47, 37.70], [-122.46, 37.705]])

        http.fetch_text = fetch_text
        http.fetch_json = fetch_json
        route = get_route(37.70, -122.47, 37.705, -122.46)
        self.assertEqual(route["source"], "osrm")
        self.assertGreater(calls["text"], 0)

    def test_weather_fixture_through_the_public_function(self):
        """get_weather in real mode reads the hourly fixture."""
        os.environ["DATA_MODE"] = "real"
        hourly = json.loads((FIXTURES / "nws_hourly.json").read_text(encoding="utf-8"))

        def fetch_json(url, headers=None, timeout=4):
            """Serve a points redirect and then the hourly fixture.

            Args:
                url (str): Request URL.
                headers (dict | None): Ignored.
                timeout (float): Ignored.

            Returns:
                dict: Points or hourly payload.

            Raises:
                DataSourceError: If the URL is neither call.
            """
            del headers, timeout
            if url.endswith("/hourly"):
                return hourly
            if "api.weather.gov/points/" in url:
                return {"properties": {"forecastHourly": url + "/hourly"}}
            raise DataSourceError(url)

        http.fetch_json = fetch_json
        forecast = get_weather(37.71, -122.44)
        self.assertEqual(forecast["source"], "nws")
        self.assertEqual(forecast["wind_dir"], "NE")

    def test_overpass_maps_and_sorts(self):
        """Shelter elements gain distance and come back nearest first."""
        payload = json.loads((FIXTURES / "overpass.json").read_text(encoding="utf-8"))
        rows = shelters_from_overpass(payload, 37.71, -122.44)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["source"], "osm")
        self.assertLessEqual(rows[0]["distance_km"], rows[1]["distance_km"])
        self.assertEqual(rows[0]["name"], "Ocean Shelter")

    def test_overpass_skips_unnamed_and_gazebos(self):
        """Park shelters and blank pins are not evacuation shelters."""
        payload = {
            "elements": [
                {
                    "type": "node",
                    "id": 1,
                    "lat": 37.71,
                    "lon": -122.44,
                    "tags": {"amenity": "shelter"},
                },
                {
                    "type": "node",
                    "id": 2,
                    "lat": 37.72,
                    "lon": -122.44,
                    "tags": {"name": "Pergola", "amenity": "shelter", "shelter_type": "gazebo"},
                },
                {
                    "type": "node",
                    "id": 3,
                    "lat": 37.70,
                    "lon": -122.44,
                    "tags": {"name": "Hope", "social_facility": "shelter"},
                },
            ]
        }
        rows = shelters_from_overpass(payload, 37.71, -122.44)
        self.assertEqual([row["name"] for row in rows], ["Hope"])

    def test_overpass_empty_raises(self):
        """No shelters is a failure so the scenario list can take over."""
        with self.assertRaises(DataSourceError) as caught:
            shelters_from_overpass({"elements": []}, 37.71, -122.44)
        self.assertIn("no shelters", str(caught.exception))


def _osrm(coordinates):
    """Build a minimal OSRM route document.

    Args:
        coordinates (list[list[float]]): [lng, lat] pairs.

    Returns:
        dict: OSRM payload with one route.
    """
    return {
        "code": "Ok",
        "routes": [
            {
                "distance": 4200,
                "duration": 480,
                "geometry": {"coordinates": coordinates},
                "legs": [
                    {
                        "steps": [
                            {"name": "Mission St", "maneuver": {"type": "depart"}}
                        ]
                    }
                ],
            }
        ],
    }


def _closest(left, right, fire):
    """Sample a segment and return the closest approach to a fire.

    Args:
        left (dict): Polyline point.
        right (dict): Polyline point.
        fire (dict): Hazard center.

    Returns:
        float: Smallest sampled distance in kilometers.
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
