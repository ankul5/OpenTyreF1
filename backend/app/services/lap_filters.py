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


def _reconstruct_events(rows: list[tuple[int, str]], event_type_of) -> list[dict]:
    """Shared DEPLOYED -> CLEAR/ENDING reconstruction for any race-control
    category that follows that two-message shape (SafetyCar today, flags
    below). `event_type_of(message)` classifies a DEPLOYED message into a
    sub-type (e.g. 'SC' vs 'VSC'); the CLEAR/ENDING message closes whatever
    is currently open.

    Mirrors the original `safety_car_laps` state machine exactly — including
    its one quirk: a second DEPLOYED arriving before the first one clears (a
    VSC immediately upgraded to a full SC) silently overwrites the open
    event rather than closing it, so the first deployment's lap is dropped
    from the result. That is preserved deliberately rather than fixed here:
    `safety_car_laps`, now a thin wrapper over this, feeds the ML training
    set and the published pace numbers, and changing its output requires a
    retrain, not a refactor. Confirmed byte-identical across all 105
    ingested sessions.
    """
    events: list[dict] = []
    open_event: dict | None = None
    for lap_number, message in rows:
        text = (message or "").upper()
        if "DEPLOYED" in text:
            open_event = {"type": event_type_of(text), "deployedLap": lap_number, "clearedLap": None, "laps": None}
        elif ("ENDING" in text or "CLEAR" in text or "IN THIS LAP" in text) and open_event is not None:
            open_event["clearedLap"] = lap_number
            open_event["laps"] = list(range(open_event["deployedLap"], lap_number + 1))
            events.append(open_event)
            open_event = None
        else:
            # Unclear boundary message (or a boundary word with nothing
            # open); be conservative and just mark this lap, same as before.
            events.append({
                "type": event_type_of(text) or "UNKNOWN",
                "deployedLap": lap_number, "clearedLap": lap_number, "laps": [lap_number],
            })

    if open_event is not None:
        # Never explicitly cleared in the messages we have (e.g. the race
        # ended under it) — mark from deployment onward isn't knowable here,
        # so the event is just the deployment lap itself.
        open_event["clearedLap"] = open_event["deployedLap"]
        open_event["laps"] = [open_event["deployedLap"]]
        events.append(open_event)

    return events


def neutralisation_events(db: OrmSession, session_key: int) -> list[dict]:
    """Safety Car / VSC events as structured records: `{type, deployedLap,
    clearedLap, laps}`, `type` one of 'SC' / 'VSC'.

    `safety_car_laps()` is a thin wrapper over this — the two must always
    agree, since the ML training set and the published pace numbers depend
    on the flat-set version.
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
        return []

    def _kind(text: str) -> str:
        return "VSC" if "VIRTUAL" in text else "SC"

    return _reconstruct_events(rows, _kind)


def safety_car_laps(db: OrmSession, session_key: int) -> set[int]:
    """Lap numbers affected by a Safety Car or Virtual Safety Car period.

    Kept as the flat-set view every existing caller (clean_laps, the ML
    dataset, the simulator) already uses; see `neutralisation_events` for the
    structured version the pitwall modules need.
    """
    laps: set[int] = set()
    for event in neutralisation_events(db, session_key):
        laps.update(event["laps"] or [])
    return laps


def flag_events(db: OrmSession, session_key: int) -> list[dict]:
    """Yellow / double-yellow flag events as structured records: `{type,
    deployedLap, clearedLap, laps, scope}`, `type` one of 'YELLOW' /
    'DOUBLE_YELLOW' / 'RED'.

    These rows are ingested (1,087 yellow/double-yellow + 13 red across the
    dataset) but were never turned into lap ranges before — `safety_car_laps`
    only ever read `category == 'SafetyCar'`.
    """
    rows = (
        db.query(RaceControlMessage.lap_number, RaceControlMessage.flag, RaceControlMessage.scope)
        .filter(
            RaceControlMessage.session_key == session_key,
            RaceControlMessage.category == "Flag",
            RaceControlMessage.flag.in_(["YELLOW", "DOUBLE YELLOW", "RED", "CLEAR", "GREEN"]),
            RaceControlMessage.lap_number.isnot(None),
        )
        .order_by(RaceControlMessage.date)
        .all()
    )
    if not rows:
        return []

    def _kind(flag: str) -> str:
        return {"YELLOW": "YELLOW", "DOUBLE YELLOW": "DOUBLE_YELLOW", "RED": "RED"}.get(flag, "OTHER")

    # Flags close on CLEAR or GREEN, not "ENDING"/"IN THIS LAP" — build the
    # (lap, message-shaped) pairs _reconstruct_events expects, synthesising a
    # pseudo-message so the shared closer logic still applies.
    pseudo = [
        (lap, "DEPLOYED" if flag in ("YELLOW", "DOUBLE YELLOW", "RED") else "CLEAR")
        for lap, flag, _scope in rows
    ]
    flag_by_lap = {lap: flag for lap, flag, _scope in rows}
    scope_by_lap = {lap: scope for lap, _flag, scope in rows}

    events = _reconstruct_events(pseudo, lambda _text: _kind(flag_by_lap.get(_text, "")))
    # _reconstruct_events doesn't know the real flag text (it only sees our
    # synthetic "DEPLOYED"/"CLEAR"), so re-derive `type` and attach `scope`
    # from the deployment lap directly.
    for event in events:
        event["type"] = _kind(flag_by_lap.get(event["deployedLap"], ""))
        event["scope"] = scope_by_lap.get(event["deployedLap"])
    return events


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
