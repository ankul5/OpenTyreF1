"""Background sync: keeps the dataset current without a manual CLI run.

Before this existed, `/api/sessions/latest` could only ever be as fresh as
whatever someone last ran `python -m app.ingestion.fetch_openf1` and
redeployed with — which is why the app kept showing a race that had finished
hours earlier. This module reuses the existing ingestion functions rather
than reimplementing them, and adds nothing beyond scheduling + a "has this
session's data actually become available yet" check on top.

Three jobs, deliberately split into a cheap step and a gated expensive one —
an earlier version of this file called `ingest_year()` for both, which has no
concept of "hasn't happened yet" and tried the full ~10-endpoint harvest
against every future session on every tick. Verified live: that hit OpenF1's
rate limiter after ~20 wasted attempts against races months out. Split fixes
it:

- `sync_calendar()` — re-run `ingest_schedule()` so postponed/added/cancelled
  races update. Cheap (one Jolpica request), safe to call often.
- `sync_session_catalog()` — one OpenF1 request per session type (3 total),
  writing/updating just the catalog row (`session_key`, `date_start`,
  `date_end`, etc.) for every session of the year, including ones that
  haven't run yet. Deliberately does **not** call `ingest_session()` — a
  session with no laps yet has nothing for that to fetch. This is the step
  that makes a countdown possible: before this, a `Session` row only appeared
  once a session had laps, so the app had no way to know a race was even
  scheduled.
- `sync_recent()` — the actual expensive step, and the only one gated by
  time: reads the Session rows `sync_session_catalog()` just wrote, and only
  calls `ingest_session()` (drivers, stints, laps, pit stops, weather,
  results, overtakes) for ones whose `date_end` is already past OpenF1's
  embargo *and* which have no laps yet. Everything still in the future is
  left alone until its own tick after it actually finishes.

`run_once()` runs all three in order and is what both the background loop and
the manual `/api/admin/sync` trigger call.

Scheduling: `start_background_sync()` launches a daemon thread from
`main.py` at startup. It runs once immediately (non-blocking — the app starts
serving requests right away, this just runs alongside), then re-checks the
Session catalog to decide how soon to run again: 15 minutes if any session's
`date_end` falls within the last hour or the next 3 hours (i.e. a result
might land any moment — OpenF1's free tier makes data available ~30 min after
a session ends), 6 hours otherwise. A module-level lock stops two passes from
ever overlapping and double-inserting.
"""

from __future__ import annotations

import threading
import time
from datetime import date, datetime, timedelta, timezone

from app.database import SessionLocal
from app.models.models import Session, SessionLap, Race
from app.ingestion.fetch_openf1 import fetch, parse_dt, match_race, ingest_session
from app.ingestion.fetch_jolpica import ingest_schedule

# OpenF1 classifies data historical (free) 30 min after a session ends; the
# extra 5 min is margin so a sync tick doesn't land right on the boundary.
EMBARGO_MARGIN_MINUTES = 35

# Qualifying wasn't ingested before this — needed for the starting-grid view
# during a race. Sprint stays because it always was.
SESSION_TYPES = ("Race", "Sprint", "Qualifying")

FAST_INTERVAL_SECONDS = 15 * 60
SLOW_INTERVAL_SECONDS = 6 * 60 * 60

_sync_lock = threading.Lock()
last_run_at: datetime | None = None
last_run_error: str | None = None


def sync_calendar(year: int | None = None) -> None:
    """Re-pull the season schedule so postponed/added/cancelled races update."""
    ingest_schedule(year or date.today().year)


def sync_session_catalog(year: int | None = None) -> None:
    """Create or update a Session row for every session of `year`, whether or
    not it has run yet. One OpenF1 request per session type (3 total) — the
    same `sessions` listing `ingest_year()` fetches — but this only writes the
    catalog row, never calling `ingest_session()`, so a session months away
    costs the same one request as a session tomorrow.
    """
    year = year or date.today().year
    db = SessionLocal()
    try:
        for session_type in SESSION_TYPES:
            for meta in fetch("sessions", year=year, session_type=session_type):
                key = meta.get("session_key")
                if key is None:
                    continue
                race = match_race(db, meta)
                if not race:
                    # No Race row to link to -- e.g. OpenF1 lists a "Sprint
                    # Qualifying" sub-session match_race() can't date-match, or
                    # (verified live) Jolpica's own 2026 calendar genuinely
                    # skips Bahrain/Saudi Arabia even though OpenF1 has their
                    # session data. Skip rather than store an orphaned row --
                    # same discipline match_race()'s docstring establishes:
                    # never fabricate or half-link what isn't really there.
                    continue
                fields = dict(
                    race_id=race.race_id,
                    meeting_key=meta.get("meeting_key"),
                    year=meta.get("year"),
                    session_name=meta.get("session_name"),
                    session_type=meta.get("session_type"),
                    circuit_short_name=meta.get("circuit_short_name"),
                    location=meta.get("location"),
                    country_name=meta.get("country_name"),
                    date_start=meta.get("date_start"),
                    date_end=meta.get("date_end"),
                )
                existing = db.query(Session).filter(Session.session_key == key).first()
                if existing:
                    for k, v in fields.items():
                        setattr(existing, k, v)
                else:
                    db.add(Session(session_key=key, **fields))
        db.commit()
    finally:
        db.close()


def sync_recent(year: int | None = None) -> None:
    """Actually ingest laps/results/etc for sessions that have finished (past
    OpenF1's embargo) but have no laps yet.

    Reads candidates from the Session rows sync_session_catalog() just wrote
    rather than re-fetching OpenF1's session list a second time. This is the
    one call that does real work per session — everything still in the future
    is left alone, cheaply, until its own tick after it actually finishes.
    """
    year = year or date.today().year
    db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=EMBARGO_MARGIN_MINUTES)
        candidates = (
            db.query(Session)
            .filter(Session.year == year, Session.session_name.in_(SESSION_TYPES))
            .all()
        )
        for s in candidates:
            end = parse_dt(s.date_end) or parse_dt(s.date_start)
            if not end or end > cutoff:
                continue  # hasn't finished (or still inside the embargo window)
            if db.query(SessionLap).filter(SessionLap.session_key == s.session_key).count():
                continue  # already has data
            race = db.query(Race).filter(Race.race_id == s.race_id).first() if s.race_id else None
            if not race:
                continue  # unlinked session, nothing ingest_session() can attach laps to
            meta = dict(
                session_key=s.session_key, meeting_key=s.meeting_key, year=s.year,
                session_name=s.session_name, session_type=s.session_type,
                circuit_short_name=s.circuit_short_name, location=s.location,
                country_name=s.country_name, date_start=s.date_start, date_end=s.date_end,
            )
            print(f"[sync] ingesting {s.location} {s.session_name} (sk {s.session_key})")
            ingest_session(db, meta, race)
    finally:
        db.close()


def run_once() -> bool:
    """One full sync pass. Returns False if a pass was already running."""
    global last_run_at, last_run_error
    if not _sync_lock.acquire(blocking=False):
        print("[sync] a pass is already running, skipping this tick")
        return False
    try:
        year = date.today().year
        print(f"[sync] starting pass for {year}")
        sync_calendar(year)
        sync_session_catalog(year)
        sync_recent(year)
        last_run_at = datetime.now(timezone.utc)
        last_run_error = None
        print(f"[sync] pass complete at {last_run_at.isoformat()}")
    except Exception as e:  # noqa: BLE001 - a failed sync must never crash the app
        last_run_error = str(e)
        print(f"[sync] pass failed: {e}")
    finally:
        _sync_lock.release()
    return True


def _next_interval_seconds() -> int:
    """Fast-poll only around when a session is finishing (embargo window),
    since that's the moment new data can actually appear. A race that's
    merely scheduled soon doesn't need faster *ingestion* polling — the
    Live tab polls the API directly on its own schedule for that.
    """
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        window_start = now - timedelta(minutes=EMBARGO_MARGIN_MINUTES + 60)
        window_end = now + timedelta(hours=3)
        for (date_end,) in db.query(Session.date_end).filter(Session.date_end.isnot(None)):
            end = parse_dt(date_end)
            if end and window_start <= end <= window_end:
                return FAST_INTERVAL_SECONDS
        return SLOW_INTERVAL_SECONDS
    finally:
        db.close()


def start_background_sync() -> None:
    """Launch the sync loop in a daemon thread. Call once from main.py."""

    def loop():
        run_once()
        while True:
            time.sleep(_next_interval_seconds())
            run_once()

    threading.Thread(target=loop, daemon=True, name="session-sync").start()
    print("[sync] background thread started")
