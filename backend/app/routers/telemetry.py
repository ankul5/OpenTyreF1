"""Telemetry + track-map endpoints, served on demand from OpenF1.

These read `car_data` and `location`, which are far too large to bulk-ingest,
so they proxy through app/services/openf1_client.py's TTL cache. The phone
never calls OpenF1 directly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session as OrmSession

from app.database import get_db
from app.models.models import Session, SessionDriver, SessionLap
from app.services import openf1_client

router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])

# One lap of car_data is ~2-3k samples; a phone chart needs far fewer.
TARGET_SAMPLES = 220


def _downsample(rows: list, target: int = TARGET_SAMPLES):
    if len(rows) <= target:
        return rows
    step = len(rows) / target
    return [rows[int(i * step)] for i in range(target)]


def _lap_window(db: OrmSession, session_key: int, driver_id: str, lap_number: int):
    """Start/end timestamps for one driver's lap, used to slice the OpenF1 feed."""
    lap = (
        db.query(SessionLap)
        .filter(
            SessionLap.session_key == session_key,
            SessionLap.driver_id == driver_id,
            SessionLap.lap_number == lap_number,
        ).first()
    )
    if not lap:
        return None, None, None
    nxt = (
        db.query(SessionLap)
        .filter(
            SessionLap.session_key == session_key,
            SessionLap.driver_id == driver_id,
            SessionLap.lap_number == lap_number + 1,
        ).first()
    )
    number = (
        db.query(SessionDriver.driver_number)
        .filter(SessionDriver.session_key == session_key, SessionDriver.driver_id == driver_id)
        .scalar()
    )
    return lap, nxt, number


@router.get("/lap")
def lap_telemetry(
    session_key: int = Query(...),
    driver_id: str = Query(...),
    lap: int = Query(..., ge=1),
    db: OrmSession = Depends(get_db),
):
    """Speed / throttle / brake / gear / DRS trace for one driver's lap."""
    lap_row, next_lap, driver_number = _lap_window(db, session_key, driver_id, lap)
    if not lap_row:
        raise HTTPException(status_code=404, detail=f"No lap {lap} for driver '{driver_id}'")
    if driver_number is None:
        raise HTTPException(status_code=404, detail=f"No driver number for '{driver_id}' in this session")

    start = lap_row.date_start
    rows = openf1_client.car_data(
        session_key, driver_number,
        date_gt=start, date_lt=next_lap.date_start if next_lap else None,
    )
    rows = [r for r in rows if r.get("speed") is not None]
    rows.sort(key=lambda r: r.get("date") or "")
    rows = _downsample(rows)

    return {
        "sessionKey": session_key,
        "driverId": driver_id,
        "driverNumber": driver_number,
        "lap": lap,
        "lapTime": lap_row.lap_time_seconds,
        "samples": [
            {
                "date": r.get("date"), "speed": r.get("speed"), "throttle": r.get("throttle"),
                "brake": r.get("brake"), "gear": r.get("n_gear"), "drs": r.get("drs"),
                "rpm": r.get("rpm"),
            }
            for r in rows
        ],
    }


@router.get("/compare")
def compare_telemetry(
    session_key: int = Query(...),
    driver_a: str = Query(...),
    driver_b: str = Query(...),
    lap_a: int = Query(..., ge=1),
    lap_b: int | None = Query(None, ge=1),
    db: OrmSession = Depends(get_db),
):
    """Two drivers' traces for overlay comparison, normalised to 0-100% of lap.

    Normalising by lap progress rather than wall-clock is what makes the two
    traces comparable when the laps have different durations.
    """
    out = []
    for driver_id, lap_no in ((driver_a, lap_a), (driver_b, lap_b or lap_a)):
        data = lap_telemetry(session_key=session_key, driver_id=driver_id, lap=lap_no, db=db)
        samples = data["samples"]
        n = max(len(samples) - 1, 1)
        for i, s in enumerate(samples):
            s["progress"] = round(i / n * 100, 2)
        out.append(data)

    return {"sessionKey": session_key, "drivers": out}


@router.get("/track-map")
def track_map(
    session_key: int = Query(...),
    driver_id: str | None = Query(None),
    lap: int | None = Query(None, ge=1),
    db: OrmSession = Depends(get_db),
):
    """x/y track outline traced from a real lap, for the animated circuit map.

    Falls back to whichever driver has lap data if none is specified, so the
    map still renders without the caller picking someone.
    """
    session = db.query(Session).filter(Session.session_key == session_key).first()
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_key} not found")

    if not driver_id:
        driver_id = (
            db.query(SessionLap.driver_id)
            .filter(SessionLap.session_key == session_key, SessionLap.position == 1)
            .first()
        )
        driver_id = driver_id[0] if driver_id else None
    if not driver_id:
        raise HTTPException(status_code=404, detail="No driver with lap data in this session")

    if lap is None:
        # A mid-race green lap traces a cleaner outline than lap 1.
        mid = (
            db.query(SessionLap.lap_number)
            .filter(SessionLap.session_key == session_key, SessionLap.driver_id == driver_id)
            .order_by(SessionLap.lap_number).all()
        )
        lap = mid[len(mid) // 2][0] if mid else 1

    lap_row, next_lap, driver_number = _lap_window(db, session_key, driver_id, lap)
    if driver_number is None:
        raise HTTPException(status_code=404, detail="Driver number unavailable for this session")

    rows = openf1_client.location(
        session_key, driver_number,
        date_gt=lap_row.date_start if lap_row else None,
        date_lt=next_lap.date_start if next_lap else None,
    )
    rows = [r for r in rows if r.get("x") is not None and r.get("y") is not None]
    rows.sort(key=lambda r: r.get("date") or "")
    rows = _downsample(rows, 400)

    points = [{"x": r["x"], "y": r["y"], "date": r.get("date")} for r in rows]
    xs = [p["x"] for p in points] or [0]
    ys = [p["y"] for p in points] or [0]

    return {
        "sessionKey": session_key,
        "driverId": driver_id,
        "lap": lap,
        "points": points,
        "bounds": {"minX": min(xs), "maxX": max(xs), "minY": min(ys), "maxY": max(ys)},
    }
