"""Deeper race-analysis metrics (5e), all built on the shared clean-lap filter
in lap_filters.py so these numbers, the recap's published pace, and Phase 3's
training set never contradict each other.
"""

from collections import defaultdict
from statistics import median, pstdev

from sqlalchemy.orm import Session as OrmSession

from app.models.models import SessionLap, SessionDriver, SessionStint, Result
from app.services.lap_filters import clean_laps, median_clean_lap
from app.services.presentation import driver_meta_by_id, TEAM_FALLBACK


def _linreg_slope(xs: list[float], ys: list[float]) -> float:
    """Ordinary least-squares slope of y on x. 0.0 if x has no spread."""
    n = len(xs)
    if n < 2:
        return 0.0
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    var_x = sum((x - mean_x) ** 2 for x in xs)
    if var_x == 0:
        return 0.0
    cov_xy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    return cov_xy / var_x


def degradation_curves(db: OrmSession, session_key: int) -> list[dict]:
    """Fuel-corrected tyre degradation: the lap-time-vs-tyre-age slope within
    each stint, minus the session's global fuel-burn slope (lap time vs lap
    number, across all clean laps), so what remains is tyre wear, not fuel
    burning off masking or exaggerating it.
    """
    all_clean = clean_laps(db, session_key)
    if len(all_clean) < 2:
        return []

    global_fuel_slope = _linreg_slope(
        [float(l.lap_number) for l in all_clean],
        [l.lap_time_seconds for l in all_clean],
    )

    by_stint: dict[tuple[str, int], list[SessionLap]] = defaultdict(list)
    for lap in all_clean:
        if lap.stint is not None and lap.tyre_life is not None:
            by_stint[(lap.driver_id, lap.stint)].append(lap)

    meta = driver_meta_by_id(db, session_key)
    curves = []
    for (driver_id, stint_no), laps in by_stint.items():
        if len(laps) < 3:
            continue
        laps.sort(key=lambda l: l.tyre_life)
        raw_slope = _linreg_slope(
            [float(l.tyre_life) for l in laps],
            [l.lap_time_seconds for l in laps],
        )
        deg_slope = raw_slope - global_fuel_slope
        m = meta.get(driver_id, {})
        curves.append({
            "driverId": driver_id,
            "code": m.get("code"),
            "teamColour": m.get("teamColour", TEAM_FALLBACK),
            "stint": stint_no,
            "compound": laps[0].tyre_compound,
            "degradationPerLap": round(deg_slope, 4),
            "laps": len(laps),
        })
    curves.sort(key=lambda c: (c["driverId"], c["stint"]))
    return curves


def teammate_gaps(db: OrmSession, session_key: int) -> list[dict]:
    """Median clean-lap gap between each pair of teammates."""
    laps = clean_laps(db, session_key)
    times_by_driver: dict[str, list[float]] = defaultdict(list)
    for l in laps:
        times_by_driver[l.driver_id].append(l.lap_time_seconds)

    team_of: dict[str, str] = {}
    drivers_by_team: dict[str, list[str]] = defaultdict(list)
    for entry in db.query(SessionDriver).filter(SessionDriver.session_key == session_key).all():
        if entry.driver_id and entry.team_name:
            team_of[entry.driver_id] = entry.team_name
            if entry.driver_id not in drivers_by_team[entry.team_name]:
                drivers_by_team[entry.team_name].append(entry.driver_id)

    meta = driver_meta_by_id(db, session_key)
    out = []
    for team, driver_ids in drivers_by_team.items():
        if len(driver_ids) != 2:
            continue
        a, b = driver_ids
        times_a, times_b = times_by_driver.get(a, []), times_by_driver.get(b, [])
        if not times_a or not times_b:
            continue
        med_a, med_b = median_clean_lap(sorted(times_a)), median_clean_lap(sorted(times_b))
        faster, slower = (a, b) if med_a <= med_b else (b, a)
        out.append({
            "team": team,
            "fasterDriverId": faster, "fasterCode": meta.get(faster, {}).get("code"),
            "slowerDriverId": slower, "slowerCode": meta.get(slower, {}).get("code"),
            "gapSeconds": round(abs(med_a - med_b), 3),
            "teamColour": meta.get(faster, {}).get("teamColour", TEAM_FALLBACK),
        })
    out.sort(key=lambda x: x["gapSeconds"])
    return out


def biggest_gainers(db: OrmSession, race_id: str, session_key: int) -> list[dict]:
    """Grid position minus finishing position, most positions gained first."""
    from app.models.models import SessionResult
    grid_by_driver = dict(
        db.query(Result.driver_id, Result.grid)
        .filter(Result.race_id == race_id, Result.grid.isnot(None))
        .all()
    )
    meta = driver_meta_by_id(db, session_key)
    out = []
    for r in db.query(SessionResult).filter(SessionResult.session_key == session_key).all():
        grid = grid_by_driver.get(r.driver_id)
        if grid is None or r.position is None or grid == 0:
            continue
        m = meta.get(r.driver_id, {})
        out.append({
            "driverId": r.driver_id, "code": m.get("code"),
            "teamColour": m.get("teamColour", TEAM_FALLBACK),
            "grid": grid, "finish": r.position,
            "positionsGained": grid - r.position,
        })
    out.sort(key=lambda x: -x["positionsGained"])
    return out


def consistency(db: OrmSession, session_key: int) -> list[dict]:
    """Population std-dev of each driver's clean lap times — a lower number
    means a more repeatable, less erratic driver over the race."""
    laps = clean_laps(db, session_key)
    times_by_driver: dict[str, list[float]] = defaultdict(list)
    for l in laps:
        times_by_driver[l.driver_id].append(l.lap_time_seconds)

    meta = driver_meta_by_id(db, session_key)
    out = []
    for driver_id, times in times_by_driver.items():
        if len(times) < 3:
            continue
        m = meta.get(driver_id, {})
        out.append({
            "driverId": driver_id, "code": m.get("code"),
            "teamColour": m.get("teamColour", TEAM_FALLBACK),
            "stdDevSeconds": round(pstdev(times), 3),
            "laps": len(times),
        })
    out.sort(key=lambda x: x["stdDevSeconds"])
    return out


def sector_deltas(db: OrmSession, session_key: int) -> list[dict]:
    """Each driver's best sector time vs the field's best in that sector."""
    rows = (
        db.query(SessionLap.driver_id, SessionLap.sector_1_seconds,
                  SessionLap.sector_2_seconds, SessionLap.sector_3_seconds)
        .filter(SessionLap.session_key == session_key)
        .all()
    )
    best_by_driver: dict[str, list[float | None]] = {}
    field_best = [None, None, None]
    for driver_id, s1, s2, s3 in rows:
        cur = best_by_driver.setdefault(driver_id, [None, None, None])
        for i, v in enumerate((s1, s2, s3)):
            if v is not None:
                if cur[i] is None or v < cur[i]:
                    cur[i] = v
                if field_best[i] is None or v < field_best[i]:
                    field_best[i] = v

    meta = driver_meta_by_id(db, session_key)
    out = []
    for driver_id, (b1, b2, b3) in best_by_driver.items():
        m = meta.get(driver_id, {})
        out.append({
            "driverId": driver_id, "code": m.get("code"),
            "teamColour": m.get("teamColour", TEAM_FALLBACK),
            "sector1": b1, "sector2": b2, "sector3": b3,
            "sector1Delta": round(b1 - field_best[0], 3) if b1 is not None and field_best[0] is not None else None,
            "sector2Delta": round(b2 - field_best[1], 3) if b2 is not None and field_best[1] is not None else None,
            "sector3Delta": round(b3 - field_best[2], 3) if b3 is not None and field_best[2] is not None else None,
        })
    out.sort(key=lambda x: (x["sector1Delta"] or 0) + (x["sector2Delta"] or 0) + (x["sector3Delta"] or 0))
    return out


def dirty_air_loss(db: OrmSession, session_key: int) -> dict:
    """Median lap time while following a car closely (< 1.5s gap to the car
    ahead) vs. running in clear air. gap_to_leader_seconds has 90.5% coverage
    in practice, so the sample size is reported alongside the numbers.
    """
    rows = (
        db.query(SessionLap)
        .filter(
            SessionLap.session_key == session_key,
            SessionLap.lap_time_seconds.isnot(None),
            SessionLap.position.isnot(None),
            SessionLap.gap_to_leader_seconds.isnot(None),
            SessionLap.lap_number > 1,
            (SessionLap.is_pit_out_lap.is_(None)) | (SessionLap.is_pit_out_lap == False),  # noqa: E712
        )
        .all()
    )
    by_lap: dict[int, list[SessionLap]] = defaultdict(list)
    for r in rows:
        by_lap[r.lap_number].append(r)

    following_times, clear_times = [], []
    for lap_number, entries in by_lap.items():
        entries.sort(key=lambda l: l.position)
        for i in range(1, len(entries)):
            gap_to_ahead = entries[i].gap_to_leader_seconds - entries[i - 1].gap_to_leader_seconds
            if gap_to_ahead < 0:
                continue
            (following_times if gap_to_ahead < 1.5 else clear_times).append(entries[i].lap_time_seconds)

    return {
        "followingMedian": round(median(following_times), 3) if following_times else None,
        "clearAirMedian": round(median(clear_times), 3) if clear_times else None,
        "lossSeconds": (
            round(median(following_times) - median(clear_times), 3)
            if following_times and clear_times else None
        ),
        "followingSampleSize": len(following_times),
        "clearAirSampleSize": len(clear_times),
    }


def full_analysis(db: OrmSession, race_id: str, session_key: int) -> dict:
    return {
        "degradation": degradation_curves(db, session_key),
        "teammateGaps": teammate_gaps(db, session_key),
        "biggestGainers": biggest_gainers(db, race_id, session_key),
        "consistency": consistency(db, session_key),
        "sectorDeltas": sector_deltas(db, session_key),
        "dirtyAirLoss": dirty_air_loss(db, session_key),
    }
