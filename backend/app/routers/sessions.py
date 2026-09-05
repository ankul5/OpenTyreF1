from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session as OrmSession

from app.database import get_db
from app.models.models import (
    Session, SessionLap, SessionResult, SessionWeather,
    Race, Result, Driver, Constructor,
)
from app.services import openf1_client
from app.services.presentation import driver_lookup as _driver_lookup, TEAM_FALLBACK

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _format_lap_time(seconds: float | None) -> str | None:
    """90.456 -> '1:30.456'. Lap times read as minutes everywhere in F1."""
    if seconds is None:
        return None
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes)}:{rest:06.3f}"


@router.get("")
def list_sessions(
    season: int | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: OrmSession = Depends(get_db),
):
    """Sessions available for the Live/Replay pickers, newest first."""
    q = db.query(Session)
    if season is not None:
        q = q.filter(Session.year == season)
    rows = q.order_by(Session.date_start.desc()).limit(limit).all()
    return {
        "items": [
            {
                "sessionKey": s.session_key,
                "raceId": s.race_id,
                "year": s.year,
                "sessionName": s.session_name,
                "circuit": s.circuit_short_name,
                "location": s.location,
                "country": s.country_name,
                "dateStart": s.date_start,
            }
            for s in rows
        ]
    }


@router.get("/latest")
def latest_session(db: OrmSession = Depends(get_db)):
    """Most recent session that actually has lap data ingested."""
    s = (
        db.query(Session)
        .join(SessionLap, SessionLap.session_key == Session.session_key)
        .group_by(Session.session_key)
        .order_by(Session.date_start.desc())
        .first()
    )
    if not s:
        raise HTTPException(status_code=404, detail="No sessions ingested yet")
    return session_live(s.session_key, db)


@router.get("/{session_key}/live")
def session_live(session_key: int, db: OrmSession = Depends(get_db)):
    """Leaderboard snapshot for a session.

    Free OpenF1 tier is historical-only, so `mode` reports which data this is:
    "latest_completed" (the reliable path) or "live" when a sponsor key is set
    and the session is actually running.
    """
    session = db.query(Session).filter(Session.session_key == session_key).first()
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_key} not found")

    drivers = _driver_lookup(db, session_key)

    # Final classification if present; otherwise fall back to the last lap seen.
    results = (
        db.query(SessionResult)
        .filter(SessionResult.session_key == session_key)
        .order_by(SessionResult.position.is_(None), SessionResult.position)
        .all()
    )

    total_laps = (
        db.query(func.max(SessionLap.lap_number))
        .filter(SessionLap.session_key == session_key)
        .scalar()
    ) or 0

    # Last compound each driver ran, for the tyre column.
    last_compound = {}
    for driver_id, compound in (
        db.query(SessionLap.driver_id, SessionLap.tyre_compound)
        .filter(SessionLap.session_key == session_key, SessionLap.tyre_compound.isnot(None))
        .order_by(SessionLap.lap_number)
        .all()
    ):
        last_compound[driver_id] = compound

    leaderboard = []
    for r in results:
        meta = drivers.get(r.driver_number, {})
        leaderboard.append({
            "position": r.position,
            "driverId": r.driver_id,
            "driverNumber": r.driver_number,
            "name": meta.get("name"),
            "code": meta.get("code"),
            "team": meta.get("team"),
            "teamColour": meta.get("teamColour", TEAM_FALLBACK),
            "headshotUrl": meta.get("headshotUrl"),
            "gap": r.gap_to_leader,
            "laps": r.number_of_laps,
            "points": r.points,
            "tyreCompound": last_compound.get(r.driver_id),
            "dnf": bool(r.dnf), "dns": bool(r.dns), "dsq": bool(r.dsq),
        })

    weather = (
        db.query(SessionWeather)
        .filter(SessionWeather.session_key == session_key)
        .order_by(SessionWeather.date.desc())
        .first()
    )

    return {
        "sessionKey": session.session_key,
        "raceId": session.race_id,
        "sessionName": session.session_name,
        "circuit": session.circuit_short_name,
        "location": session.location,
        "country": session.country_name,
        "year": session.year,
        "dateStart": session.date_start,
        "mode": "live" if openf1_client.has_live_access() else "latest_completed",
        "liveAvailable": openf1_client.has_live_access(),
        "totalLaps": total_laps,
        "leaderboard": leaderboard,
        "weather": {
            "airTemperature": weather.air_temperature,
            "trackTemperature": weather.track_temperature,
            "humidity": weather.humidity,
            "windSpeed": weather.wind_speed,
            "rainfall": weather.rainfall,
        } if weather else None,
    }


@router.get("/{session_key}/track")
def session_track(session_key: int, db: OrmSession = Depends(get_db)):
    """Circuit dossier for the session: where it is, conditions, and its history.

    The identity of a circuit across seasons is `races.circuit_name`, not the
    session's `circuit_short_name` — OpenF1 only covers 2023+, while `races`
    goes back to 2002, so joining on the race is what makes "past winners here"
    reach further than three years.
    """
    session = db.query(Session).filter(Session.session_key == session_key).first()
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_key} not found")

    race = (
        db.query(Race).filter(Race.race_id == session.race_id).first()
        if session.race_id else None
    )
    circuit_name = race.circuit_name if race else None

    weather = (
        db.query(SessionWeather)
        .filter(SessionWeather.session_key == session_key)
        .order_by(SessionWeather.date.desc())
        .first()
    )

    total_laps = (
        db.query(func.max(SessionLap.lap_number))
        .filter(SessionLap.session_key == session_key)
        .scalar()
    ) or 0

    # --- Circuit history, across every season in `races` -------------------
    history = {"timesHeld": 0, "firstGrandPrix": None, "lastGrandPrix": None}
    past_winners: list[dict] = []
    if circuit_name:
        held, first_year, last_year = (
            db.query(
                func.count(Race.race_id),
                func.min(Race.season_year),
                func.max(Race.season_year),
            )
            .filter(Race.circuit_name == circuit_name)
            .first()
        )
        history = {
            "timesHeld": held or 0,
            "firstGrandPrix": first_year,
            "lastGrandPrix": last_year,
        }

        # Winners of the three most recent editions before this one. Excluding
        # the current season stops the panel from spoiling the race the user is
        # looking at with its own result.
        rows = (
            db.query(Race, Result, Driver, Constructor)
            .join(Result, Result.race_id == Race.race_id)
            .join(Driver, Driver.driver_id == Result.driver_id)
            .outerjoin(Constructor, Constructor.constructor_id == Result.constructor_id)
            .filter(
                Race.circuit_name == circuit_name,
                Result.position == 1,
                Race.season_year < session.year,
            )
            .order_by(Race.season_year.desc())
            .limit(3)
            .all()
        )
        past_winners = [
            {
                "year": r.season_year,
                "raceName": r.race_name,
                "driverId": d.driver_id,
                "driverName": f"{d.given_name} {d.family_name}",
                "code": d.code,
                "team": c.name if c else None,
                "grid": res.grid,
            }
            for r, res, d, c in rows
        ]

    # --- Fastest race lap ever recorded here (OpenF1 era, 2023+) -----------
    lap_record = None
    if circuit_name:
        best = (
            db.query(SessionLap.lap_time_seconds, SessionLap.driver_id, Session.year)
            .join(Session, Session.session_key == SessionLap.session_key)
            .join(Race, Race.race_id == Session.race_id)
            .filter(
                Race.circuit_name == circuit_name,
                Session.session_name == "Race",
                SessionLap.lap_time_seconds.isnot(None),
                # Pit-out laps and safety-car laps are not representative; a
                # floor of 40s also drops the occasional corrupt timing row.
                SessionLap.lap_time_seconds > 40,
                SessionLap.is_pit_out_lap.isnot(True),
            )
            .order_by(SessionLap.lap_time_seconds)
            .first()
        )
        if best:
            seconds, driver_id, year = best
            driver = db.query(Driver).filter(Driver.driver_id == driver_id).first()
            lap_record = {
                "seconds": round(seconds, 3),
                "time": _format_lap_time(seconds),
                "driverId": driver_id,
                "driverName": f"{driver.given_name} {driver.family_name}" if driver else None,
                "code": driver.code if driver else None,
                "year": year,
                "note": "Fastest race lap since 2023",
            }

    return {
        "sessionKey": session.session_key,
        "raceId": session.race_id,
        "circuit": session.circuit_short_name,
        "circuitName": circuit_name,
        "raceName": race.race_name if race else None,
        "location": session.location or (race.locality if race else None),
        "country": session.country_name or (race.country if race else None),
        "lat": race.lat if race else None,
        "lng": race.lng if race else None,
        "date": race.date if race else session.date_start,
        "year": session.year,
        "totalLaps": total_laps,
        "weather": {
            "airTemperature": weather.air_temperature,
            "trackTemperature": weather.track_temperature,
            "humidity": weather.humidity,
            "windSpeed": weather.wind_speed,
            "rainfall": weather.rainfall,
        } if weather else None,
        "history": history,
        "lapRecord": lap_record,
        "pastWinners": past_winners,
    }
