"""Data tools for Relay.

Tirth calls these four functions and does not talk to FIRMS, NWS, or OSRM
directly. Fake mode and live mode return the same keys.
"""

from data.api import get_hazards, get_route, get_shelters, get_weather
from data.state import build_state

__all__ = [
    "build_state",
    "get_hazards",
    "get_route",
    "get_shelters",
    "get_weather",
]
