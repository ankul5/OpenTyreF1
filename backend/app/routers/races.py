from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session as OrmSession

from app.database import get_db
from app.models.models import (
    Race, Session, SessionLap, SessionStint, SessionResult,
    PitStop, RaceControlMessage, SessionWeather, Overtake, Result,
)
from app.services.presentation import driver_lookup as _driver_lookup, driver_meta_by_id as _driver_meta_by_id, TEAM_FALLBACK
from app.services.lap_filters import race_session_key, clean_laps, median_clean_lap
from app.services.analysis import full_analysis

router = APIRouter(prefix="/api/races", tags=["races"])


def _session_for_race(db: OrmSession, race_id: str) -> Session:
    sk = race_session_key(db, race_id)
    session = db.query(Session).filter(Session.session_key == sk).first() if sk else None
    if not session:
        raise HTTPException(status_code=404, detail=f"No ingested session for race '{race_id}'")
    return session


@router.get("")
def list_races(
    season: int | None = Query(None),
    search: str | None = Query(None),
    limit: int = Query(60, ge=1, le=200),
    db: OrmSession = Depends(get_db),
):
    """Races that have ingested lap data, i.e. those that can actually be replayed."""
    q = (
        db.query(Race, Session)
        .join(Session, Session.race_id == Race.race_id)
        .filter(Session.session_name == "Race")
    )
    if season is not None:
        q = q.filter(Race.season_year == season)
    if search:
        term = f"%{search.strip().lower()}%"
        q = q.filter(func.lower(Race.race_name).like(term) | func.lower(Race.circuit_name).like(term))

    rows = q.order_by(Race.season_year.desc(), Race.round.desc()).limit(limit).all()
    return {
        "items": [
            {
                "raceId": race.race_id,
                "season": race.season_year,
                "round": race.round,
                "raceName": race.race_name,
                "circuitName": race.circuit_name,
                "date": race.date,
                "sessionKey": session.session_key,
            }
            for race, session in rows
        ]
    }


@router.get("/upcoming")
def upcoming_races(
    limit: int = Query(5, ge=1, le=30),
    db: OrmSession = Depends(get_db),
):
    """Next races by date, from the full-calendar schedule ingest.

    Declared above /{race_id}/... so the literal path "upcoming" can never be
    swallowed by the race_id path parameter.
    """
    today = date.today()
    rows = (
        db.query(Race)
        .filter(Race.date.isnot(None), Race.date >= today.isoformat())
        .order_by(Race.date)
        .limit(limit)
        .all()
    )
    # The upcoming Saturday/Sunday (or today, if today is itself a weekend day).
    days_to_saturday = (5 - today.weekday()) % 7
    upcoming_saturday = today + timedelta(days=days_to_saturday)
    upcoming_sunday = upcoming_saturday + timedelta(days=1)

    items = []
    for r in rows:
        race_date = date.fromisoformat(r.date)
        items.append({
            "raceId": r.race_id,
            "season": r.season_year,
            "round": r.round,
            "raceName": r.race_name,
            "circuitName": r.circuit_name,
            "country": r.country,
            "locality": r.locality,
            "date": r.date,
            "time": r.race_time,
            "lat": r.lat,
            "lng": r.lng,
            "daysUntil": (race_date - today).days,
            "isThisWeekend": race_date in (upcoming_saturday, upcoming_sunday),
        })
    return {"items": items}


@router.get("/{race_id}/replay")
def race_replay(race_id: str, db: OrmSession = Depends(get_db)):
    """Ordered per-lap frames for the replay player.

    One entry per lap (not raw telemetry) so playback stays smooth on a phone.
    Shape is deliberately identical to what the strategy simulator returns, so
    the same <RaceReplayPlayer> renders both.
    """
    session = _session_for_race(db, race_id)
    meta = _driver_meta_by_id(db, session.session_key)

    laps = (
        db.query(SessionLap)
        .filter(SessionLap.session_key == session.session_key, SessionLap.position.isnot(None))
        .order_by(SessionLap.lap_number, SessionLap.position)
        .all()
    )
    if not laps:
        raise HTTPException(status_code=404, detail=f"No lap data for race '{race_id}'")

    by_lap = defaultdict(list)
    for lap in laps:
        d = meta.get(lap.driver_id, {})
        by_lap[lap.lap_number].append({
            "position": lap.position,
            "driverId": lap.driver_id,
            "code": d.get("code"),
            "name": d.get("name"),
            "team": d.get("team"),
            "teamColour": d.get("teamColour", TEAM_FALLBACK),
            "gap": lap.gap_to_leader_seconds,
            "tyreCompound": lap.tyre_compound,
            "tyreLife": lap.tyre_life,
            "lapTime": lap.lap_time_seconds,
            "isPitOutLap": lap.is_pit_out_lap,
        })

    frames = [
        {"lap": lap_no, "leaderboard": sorted(entries, key=lambda e: e["position"])}
        for lap_no, entries in sorted(by_lap.items())
    ]

    race = db.query(Race).filter(Race.race_id == race_id).first()
    return {
        "raceId": race_id,
        "raceName": race.race_name if race else None,
        "circuitName": race.circuit_name if race else None,
        "season": race.season_year if race else None,
        "sessionKey": session.session_key,
        "totalLaps": frames[-1]["lap"] if frames else 0,
        "frames": frames,
    }


@router.get("/{race_id}/recap")
def race_recap(race_id: str, db: OrmSession = Depends(get_db)):
    """Everything the race-detail screen charts: classification, stints, pits,
    position changes, race control, pace ranking, weather, overtakes."""
    session = _session_for_race(db, race_id)
    sk = session.session_key
    race = db.query(Race).filter(Race.race_id == race_id).first()
    meta_by_id = _driver_meta_by_id(db, sk)
    meta_by_num = _driver_lookup(db, sk)

    # Grid position comes from the Jolpica `results` table, not OpenF1 — it's
    # the pre-race grid, which OpenF1's session_results has no equivalent of.
    grid_by_driver = dict(
        db.query(Result.driver_id, Result.grid)
        .filter(Result.race_id == race_id, Result.grid.isnot(None))
        .all()
    )

    # --- Classification ---
    classification = []
    for r in db.query(SessionResult).filter(SessionResult.session_key == sk).order_by(SessionResult.position.is_(None), SessionResult.position).all():
        m = meta_by_num.get(r.driver_number, {})
        classification.append({
            "position": r.position, "driverId": r.driver_id, "code": m.get("code"),
            "name": m.get("name"), "team": m.get("team"),
            "teamColour": m.get("teamColour", TEAM_FALLBACK),
            "headshotUrl": m.get("headshotUrl"),
            "grid": grid_by_driver.get(r.driver_id),
            "gap": r.gap_to_leader, "laps": r.number_of_laps, "points": r.points,
            "dnf": bool(r.dnf), "dns": bool(r.dns), "dsq": bool(r.dsq),
        })

    # --- Tyre stints (one bar row per driver) ---
    stints = defaultdict(list)
    for s in db.query(SessionStint).filter(SessionStint.session_key == sk).order_by(SessionStint.stint_number).all():
        if not s.driver_id or s.lap_start is None or s.lap_end is None:
            continue
        stints[s.driver_id].append({
            "stint": s.stint_number, "compound": s.compound,
            "lapStart": s.lap_start, "lapEnd": s.lap_end,
            "laps": s.lap_end - s.lap_start + 1,
            "tyreAgeAtStart": s.tyre_age_at_start,
        })
    tyre_strategy = [
        {
            "driverId": did, "code": meta_by_id.get(did, {}).get("code"),
            "name": meta_by_id.get(did, {}).get("name"),
            "teamColour": meta_by_id.get(did, {}).get("teamColour", TEAM_FALLBACK),
            "stints": sorted(v, key=lambda x: x["lapStart"]),
        }
        for did, v in stints.items()
    ]
    order = {c["driverId"]: c["position"] for c in classification if c["position"]}
    tyre_strategy.sort(key=lambda d: order.get(d["driverId"], 99))

    # --- Position changes over laps (one line per driver) ---
    pos_series = defaultdict(list)
    for lap in (
        db.query(SessionLap)
        .filter(SessionLap.session_key == sk, SessionLap.position.isnot(None))
        .order_by(SessionLap.lap_number).all()
    ):
        pos_series[lap.driver_id].append({"lap": lap.lap_number, "position": lap.position})
    position_chart = [
        {
            "driverId": did, "code": meta_by_id.get(did, {}).get("code"),
            "teamColour": meta_by_id.get(did, {}).get("teamColour", TEAM_FALLBACK),
            "points": pts,
        }
        for did, pts in pos_series.items()
    ]
    position_chart.sort(key=lambda d: order.get(d["driverId"], 99))

    # --- Pit stops, fastest first ---
    pit_stops = []
    for p in db.query(PitStop).filter(PitStop.session_key == sk).all():
        if p.pit_duration is None:
            continue
        m = meta_by_num.get(p.driver_number, {})
        pit_stops.append({
            "driverId": p.driver_id, "code": m.get("code"), "team": m.get("team"),
            "teamColour": m.get("teamColour", TEAM_FALLBACK),
            "lap": p.lap_number, "duration": round(p.pit_duration, 3),
        })
    pit_stops.sort(key=lambda x: x["duration"])

    # --- Pace ranking: true median of each driver's clean (green-flag, non-pit,
    # non-SC, within-107%) laps. Shared with the 5e analysis metrics and
    # Phase 3's training set via lap_filters, so the numbers always agree.
    pace_laps = defaultdict(list)
    for lap in clean_laps(db, sk):
        pace_laps[lap.driver_id].append(lap)

    pace = []
    for did, laps in pace_laps.items():
        if not laps:
            continue
        times = sorted(l.lap_time_seconds for l in laps)
        best_lap = min(laps, key=lambda l: l.lap_time_seconds)
        pace.append({
            "driverId": did, "code": meta_by_id.get(did, {}).get("code"),
            "teamColour": meta_by_id.get(did, {}).get("teamColour", TEAM_FALLBACK),
            "medianLap": round(median_clean_lap(times), 3),
            "bestLap": round(times[0], 3),
            "bestLapNumber": best_lap.lap_number,
            "laps": len(times),
        })
    pace.sort(key=lambda x: x["medianLap"])
    if pace:
        leader = pace[0]["medianLap"]
        for p in pace:
            p["deltaToBest"] = round(p["medianLap"] - leader, 3)

    # --- Race control ---
    race_control = [
        {
            "lap": m.lap_number, "category": m.category, "flag": m.flag,
            "scope": m.scope, "message": m.message, "date": m.date,
        }
        for m in db.query(RaceControlMessage)
        .filter(RaceControlMessage.session_key == sk)
        .order_by(RaceControlMessage.date).all()
    ]

    # --- Weather over the session ---
    weather = [
        {
            "date": w.date, "airTemperature": w.air_temperature,
            "trackTemperature": w.track_temperature, "humidity": w.humidity,
            "windSpeed": w.wind_speed, "rainfall": w.rainfall,
        }
        for w in db.query(SessionWeather)
        .filter(SessionWeather.session_key == sk)
        .order_by(SessionWeather.date).all()
    ]

    # --- Overtake tally ---
    tally = defaultdict(int)
    for o in db.query(Overtake).filter(Overtake.session_key == sk).all():
        tally[o.overtaking_driver_number] += 1
    overtakes = [
        {
            "driverId": meta_by_num.get(num, {}).get("driverId"),
            "code": meta_by_num.get(num, {}).get("code"),
            "teamColour": meta_by_num.get(num, {}).get("teamColour", TEAM_FALLBACK),
            "count": count,
        }
        for num, count in sorted(tally.items(), key=lambda kv: -kv[1]) if num in meta_by_num
    ]

    # --- At-a-glance summary card: podium, fastest lap, biggest gainer,
    # winning strategy, conditions. Computed once here so the Live tab and the
    # race-detail header don't each re-derive it from the raw arrays above. ---
    podium = [c for c in classification if c["position"] in (1, 2, 3)]
    podium.sort(key=lambda c: c["position"])

    fastest_lap = min(pace, key=lambda p: p["bestLap"]) if pace else None

    biggest_gainer = None
    best_gain = 0
    for c in classification:
        grid = grid_by_driver.get(c["driverId"])
        if grid is None or c["position"] is None or grid == 0:
            continue
        gain = grid - c["position"]
        if gain > best_gain:
            best_gain = gain
            biggest_gainer = {
                "driverId": c["driverId"], "code": c["code"], "name": c["name"],
                "teamColour": c["teamColour"], "grid": grid, "finish": c["position"],
                "positionsGained": gain,
            }

    winner_strategy = tyre_strategy[0] if tyre_strategy else None
    winning_strategy = None
    if winner_strategy and winner_strategy["stints"]:
        compounds = [s["compound"] for s in winner_strategy["stints"] if s["compound"]]
        winning_strategy = {
            "driverId": winner_strategy["driverId"], "code": winner_strategy["code"],
            "sequence": compounds,
            "stops": max(0, len(winner_strategy["stints"]) - 1),
        }

    conditions = None
    if weather:
        w0 = weather[0]
        conditions = {
            "airTemperature": w0["airTemperature"], "trackTemperature": w0["trackTemperature"],
            "wet": any(w["rainfall"] for w in weather),
        }

    summary = {
        "podium": podium,
        "fastestLap": fastest_lap,
        "biggestGainer": biggest_gainer,
        "winningStrategy": winning_strategy,
        "conditions": conditions,
    }

    return {
        "raceId": race_id,
        "raceName": race.race_name if race else None,
        "circuitName": race.circuit_name if race else None,
        "season": race.season_year if race else None,
        "date": race.date if race else None,
        "sessionKey": sk,
        "totalLaps": db.query(func.max(SessionLap.lap_number)).filter(SessionLap.session_key == sk).scalar() or 0,
        "classification": classification,
        "tyreStrategy": tyre_strategy,
        "positionChart": position_chart,
        "pitStops": pit_stops,
        "pace": pace,
        "raceControl": race_control,
        "weather": weather,
        "overtakes": overtakes,
        "summary": summary,
    }


@router.get("/{race_id}/analysis")
def race_analysis(race_id: str, db: OrmSession = Depends(get_db)):
    """5e deeper metrics: fuel-corrected degradation, teammate gaps, biggest
    gainers, consistency, sector deltas, dirty-air loss.

    Kept separate from /recap, which already issues ~8 unbounded queries and
    pulls the whole lap table into Python for the position chart.
    """
    session = _session_for_race(db, race_id)
    return full_analysis(db, race_id, session.session_key)
