"""The single definition of a 'clean' lap.

Before this module, `races.py`'s pace ranking inlined a crude "trim the
slowest 25% of laps" heuristic. That is a blunt tail-cut, not an outlier
filter: a clean race loses laps it didn't need to, and a race with heavy
safety-car running keeps laps it shouldn't. This module is the shared,
explicit replacement — used by the recap's published pace numbers, the 5e
analysis metrics, and Phase 3's model training set, so all three agree.

Two gotchas this exists to handle:

- A Sprint session shares its parent race's `race_id` with the Race session.
  Joining lap data on `race_id` alone silently mixes sprint laps (different
  fuel load, different length) into a race's data. `race_session_key` always
  resolves to the Race session specifically.
- `session_laps` has no `is_pit_in_lap` column, only `is_pit_out_lap`. The
  in-lap (with its slow final sector before entering the pits) is derived
  from `pit_stops.lap_number` instead.
"""

from sqlalchemy.orm import Session as OrmSession

from app.models.models import Session, SessionLap, PitStop, RaceControlMessage


def race_session_key(db: OrmSession, race_id: str) -> int | None:
    """The Race session_key for a race_id, never a Sprint sharing the same id."""
    session = (
        db.query(Session)
        .filter(Session.race_id == race_id, Session.session_name == "Race")
        .first()
    ) or db.query(Session).filter(Session.race_id == race_id).first()
    return session.session_key if session else None


def safety_car_laps(db: OrmSession, session_key: int) -> set[int]:
    """Lap numbers affected by a Safety Car or Virtual Safety Car period.

    race_control_messages carries a DEPLOYED message and a later
    CLEAR/ENDING/'IN THIS LAP' message; every lap number in between (and the
    two boundary laps themselves) is treated as compromised.
    """
    rows = (
        db.query(RaceControlMessage.lap_number, RaceControlMessage.message)
        .filter(
            RaceControlMessage.session_key == session_key,
            RaceControlMessage.category == "SafetyCar",
            RaceControlMessage.lap_number.isnot(None),
        )
        .order_by(RaceControlMessage.date)
        .all()
    )
    if not rows:
        return set()

    laps: set[int] = set()
    deployed_lap: int | None = None
    for lap_number, message in rows:
        text = (message or "").upper()
        if "DEPLOYED" in text:
            deployed_lap = lap_number
        elif ("ENDING" in text or "CLEAR" in text or "IN THIS LAP" in text) and deployed_lap is not None:
            laps.update(range(deployed_lap, lap_number + 1))
            deployed_lap = None
        else:
            # Unclear boundary message; be conservative and just mark this lap.
            laps.add(lap_number)

    if deployed_lap is not None:
        # SC never explicitly cleared in the messages we have (e.g. race ended
        # under SC) — mark from deployment to the end is not knowable here, so
        # just mark the deployment lap itself.
        laps.add(deployed_lap)

    return laps


def pit_in_laps(db: OrmSession, session_key: int) -> set[int]:
    """Lap numbers on which a driver entered the pits, derived from pit_stops.

    session_laps has no is_pit_in_lap column — only is_pit_out_lap, which
    marks the lap leaving the pits, not the one entering them.
    """
    return {
        lap_number
        for (lap_number,) in db.query(PitStop.lap_number)
        .filter(PitStop.session_key == session_key, PitStop.lap_number.isnot(None))
        .all()
    }


def clean_laps(
    db: OrmSession,
    session_key: int,
    *,
    drop_lap_one: bool = True,
    drop_pits: bool = True,
    drop_sc: bool = True,
    pct_107: bool = True,
) -> list[SessionLap]:
    """The filtered lap set that defines a driver's 'representative' pace.

    Filters, in order: drop lap 1 (standing start), drop pit in/out laps, drop
    safety-car-affected laps, then drop each driver's own laps slower than
    107% of their own median (their session median, computed on the already
    lap1/pit/SC-filtered set) — a compromised lap for a backmarker still
    reads as "slow for that driver" even if it's fast in absolute terms.
    """
    q = db.query(SessionLap).filter(
        SessionLap.session_key == session_key,
        SessionLap.lap_time_seconds.isnot(None),
    )
    if drop_lap_one:
        q = q.filter(SessionLap.lap_number > 1)

    rows = q.all()

    if drop_pits:
        pit_in = pit_in_laps(db, session_key)
        rows = [
            r for r in rows
            if not r.is_pit_out_lap and r.lap_number not in pit_in
        ]

    if drop_sc:
        sc_laps = safety_car_laps(db, session_key)
        rows = [r for r in rows if r.lap_number not in sc_laps]

    if not pct_107:
        return rows

    by_driver: dict[str, list[SessionLap]] = {}
    for r in rows:
        by_driver.setdefault(r.driver_id, []).append(r)

    out: list[SessionLap] = []
    for driver_rows in by_driver.values():
        times = sorted(r.lap_time_seconds for r in driver_rows)
        threshold = median_clean_lap(times) * 1.07
        out.extend(r for r in driver_rows if r.lap_time_seconds <= threshold)

    return out


def median_clean_lap(times: list[float]) -> float:
    """True median of a sorted-or-unsorted list of lap times.

    Not the same as the old inline pace calculation, which trimmed the
    slowest 25% then indexed the middle of what remained — that is really
    the ~37.5th percentile of the full distribution, which is fine as a
    relative ranking but wrong as an estimate of "typical lap time".
    """
    if not times:
        return 0.0
    s = sorted(times)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2
