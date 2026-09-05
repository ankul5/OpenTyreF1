"""Shared driver-presentation helpers used by sessions/races/strategy routers.

Originally lived only in sessions.py; races.py already reached across to
import it, so this factors it out before a third and fourth consumer
(analysis.py, strategy.py) need it too.
"""

from sqlalchemy.orm import Session as OrmSession

from app.models.models import SessionDriver, Driver

TEAM_FALLBACK = "#8A8A8E"


def driver_lookup(db: OrmSession, session_key: int) -> dict[int, dict]:
    """driver_number -> {name, code, team, colour, headshotUrl} for one session."""
    rows = (
        db.query(SessionDriver, Driver)
        .outerjoin(Driver, Driver.driver_id == SessionDriver.driver_id)
        .filter(SessionDriver.session_key == session_key)
        .all()
    )
    out = {}
    for entry, driver in rows:
        out[entry.driver_number] = {
            "driverId": entry.driver_id,
            "driverNumber": entry.driver_number,
            "name": entry.full_name or (f"{driver.given_name} {driver.family_name}" if driver else None),
            "code": entry.name_acronym or (driver.code if driver else None),
            "team": entry.team_name,
            "teamColour": entry.team_colour or TEAM_FALLBACK,
            "headshotUrl": entry.headshot_url,
        }
    return out


def driver_meta_by_id(db: OrmSession, session_key: int) -> dict[str, dict]:
    """driver_id -> display metadata (name/code/colour/headshot), for chart series."""
    out = {}
    for meta in driver_lookup(db, session_key).values():
        if meta.get("driverId"):
            out[meta["driverId"]] = meta
    return out
