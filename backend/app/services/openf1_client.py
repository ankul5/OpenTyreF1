"""On-demand OpenF1 access with an in-process TTL cache.

`car_data` and `location` are far too large to bulk-ingest (a single race is
millions of rows), so they are fetched per driver/lap when a screen asks for
them. OpenF1ow solves the same problem with Cloudflare R2; at this scale a
process-local cache is enough, and it keeps the phone from ever calling
OpenF1 directly (which would blow the 3 req/s free-tier limit).
"""

import os
import time
import threading

import requests

OPENF1_BASE = "https://api.openf1.org/v1"
CACHE_TTL_SECONDS = 60 * 60  # session data is immutable once a race is over
MAX_CACHE_ENTRIES = 256

# Set OPENF1_API_KEY in backend/.env to enable the paid sponsor tier, which
# unlocks live data during a running session. Everything works without it;
# only true-live mode requires it.
OPENF1_API_KEY = os.getenv("OPENF1_API_KEY")

_cache: dict[str, tuple[float, list]] = {}
_lock = threading.Lock()


def _headers():
    return {"Authorization": f"Bearer {OPENF1_API_KEY}"} if OPENF1_API_KEY else {}


def has_live_access() -> bool:
    return bool(OPENF1_API_KEY)


def get(endpoint: str, **params) -> list:
    query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
    url = f"{OPENF1_BASE}/{endpoint}" + (f"?{query}" if query else "")

    with _lock:
        hit = _cache.get(url)
        if hit and time.time() - hit[0] < CACHE_TTL_SECONDS:
            return hit[1]

    try:
        resp = requests.get(url, timeout=60, headers=_headers())
        if resp.status_code != 200:
            return []
        data = resp.json()
    except Exception:
        return []

    with _lock:
        if len(_cache) >= MAX_CACHE_ENTRIES:
            oldest = min(_cache, key=lambda k: _cache[k][0])
            _cache.pop(oldest, None)
        _cache[url] = (time.time(), data)
    return data


def car_data(session_key: int, driver_number: int, date_gt: str | None = None, date_lt: str | None = None):
    """Telemetry samples (~3.7 Hz): speed, throttle, brake, drs, n_gear, rpm."""
    params = {"session_key": session_key, "driver_number": driver_number}
    if date_gt:
        params["date>"] = date_gt
    if date_lt:
        params["date<"] = date_lt
    return get("car_data", **params)


def location(session_key: int, driver_number: int, date_gt: str | None = None, date_lt: str | None = None):
    """Track coordinates (x, y, z) for drawing a real circuit map."""
    params = {"session_key": session_key, "driver_number": driver_number}
    if date_gt:
        params["date>"] = date_gt
    if date_lt:
        params["date<"] = date_lt
    return get("location", **params)
