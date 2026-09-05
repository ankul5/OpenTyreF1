from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, and_, distinct
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.models import Driver, Constructor, Race, Result, Standing, SessionDriver, Session as OpenF1Session

router = APIRouter(prefix="/api/drivers", tags=["drivers"])


def _headshots_for(db: Session, driver_ids: list[str]) -> dict[str, str]:
    """Most recent non-null headshot per driver, from any session they've run.

    DriverDetail has no image field of its own — headshots only exist on
    session_drivers, keyed by session rather than driver. One grouped query
    for the whole page/lookup, ordered so the first row per driver_id (after
    a Python-side sort) is the newest, rather than N extra round-trips.
    """
    if not driver_ids:
        return {}
    rows = (
        db.query(SessionDriver.driver_id, SessionDriver.headshot_url)
        .join(OpenF1Session, OpenF1Session.session_key == SessionDriver.session_key)
        .filter(SessionDriver.driver_id.in_(driver_ids), SessionDriver.headshot_url.isnot(None))
        .order_by(SessionDriver.driver_id, OpenF1Session.date_start.desc())
        .all()
    )
    out: dict[str, str] = {}
    for driver_id, url in rows:
        if driver_id not in out:
            out[driver_id] = url
    return out


@router.get("")
def list_drivers(
    search: str | None = Query(None, description="Match driver name or team name"),
    season: int | None = Query(None, description="Only drivers who raced this season"),
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Paginated driver directory. Reads only from the local DB."""
    query = db.query(Driver)

    if season is not None:
        query = query.filter(
            Driver.driver_id.in_(
                db.query(Result.driver_id)
                .join(Race, Race.race_id == Result.race_id)
                .filter(Race.season_year == season)
            )
        )

    if search:
        term = f"%{search.strip().lower()}%"
        # Team match goes through results -> constructors so "ferrari" finds its drivers.
        team_driver_ids = (
            db.query(Result.driver_id)
            .join(Constructor, Constructor.constructor_id == Result.constructor_id)
            .filter(func.lower(Constructor.name).like(term))
        )
        query = query.filter(
            or_(
                func.lower(Driver.given_name).like(term),
                func.lower(Driver.family_name).like(term),
                func.lower(Driver.given_name + " " + Driver.family_name).like(term),
                func.lower(Driver.code).like(term),
                Driver.driver_id.in_(team_driver_ids),
            )
        )

    total = query.count()
    rows = (
        query.order_by(Driver.family_name, Driver.given_name)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # Batched in two grouped queries for the whole page, rather than two
    # extra round-trips per row (a 30-row page was costing 61 queries).
    page_ids = [d.driver_id for d in rows]

    wins_by_driver = dict(
        db.query(Result.driver_id, func.count(Result.id))
        .filter(Result.driver_id.in_(page_ids), Result.position == 1)
        .group_by(Result.driver_id)
        .all()
    ) if page_ids else {}

    # Most recent (season, round) entry per driver decides their "current" team.
    team_rows = (
        db.query(Result.driver_id, Race.season_year, Race.round, Constructor.name)
        .join(Race, Race.race_id == Result.race_id)
        .join(Constructor, Constructor.constructor_id == Result.constructor_id)
        .filter(Result.driver_id.in_(page_ids))
        .order_by(Result.driver_id, Race.season_year.desc(), Race.round.desc())
        .all()
    ) if page_ids else []

    latest_team_by_driver: dict[str, tuple[int, str]] = {}
    for driver_id, season_year, _round, constructor_name in team_rows:
        if driver_id not in latest_team_by_driver:
            latest_team_by_driver[driver_id] = (season_year, constructor_name)

    headshots = _headshots_for(db, page_ids)

    items = []
    for d in rows:
        latest_team = latest_team_by_driver.get(d.driver_id)
        items.append({
            "driverId": d.driver_id,
            "givenName": d.given_name,
            "familyName": d.family_name,
            "code": d.code,
            "permanentNumber": d.permanent_number,
            "nationality": d.nationality,
            "team": latest_team[1] if latest_team else None,
            "lastSeason": latest_team[0] if latest_team else None,
            "wins": wins_by_driver.get(d.driver_id, 0),
            "headshotUrl": headshots.get(d.driver_id),
        })

    return {
        "items": items,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "hasMore": page * page_size < total,
    }


@router.get("/{driver_id}")
def get_driver(driver_id: str, db: Session = Depends(get_db)):
    """Career totals and team history for one driver."""
    driver = db.query(Driver).filter(Driver.driver_id == driver_id).first()
    if not driver:
        raise HTTPException(status_code=404, detail=f"Driver '{driver_id}' not found")

    totals = (
        db.query(
            func.count(Result.id).label("starts"),
            func.sum(func.coalesce(Result.points, 0.0)).label("points"),
        )
        .filter(Result.driver_id == driver_id)
        .first()
    )
    wins = db.query(func.count(Result.id)).filter(
        Result.driver_id == driver_id, Result.position == 1
    ).scalar() or 0
    podiums = db.query(func.count(Result.id)).filter(
        Result.driver_id == driver_id, Result.position <= 3
    ).scalar() or 0
    # Pole = qualifying position 1, not grid position 1 (a penalty can promote
    # someone else to P1 on the grid without them having actually qualified on
    # pole). Falls back to grid for seasons Jolpica has no qualifying data for.
    poles = db.query(func.count(Result.id)).filter(
        Result.driver_id == driver_id,
        or_(
            Result.qualifying_position == 1,
            and_(Result.qualifying_position.is_(None), Result.grid == 1),
        ),
    ).scalar() or 0
    championships = db.query(func.count(Standing.id)).filter(
        Standing.driver_id == driver_id, Standing.position == 1
    ).scalar() or 0

    team_history = (
        db.query(
            Constructor.constructor_id,
            Constructor.name,
            func.min(Race.season_year).label("from_year"),
            func.max(Race.season_year).label("to_year"),
            func.count(Result.id).label("races"),
        )
        .join(Result, Result.constructor_id == Constructor.constructor_id)
        .join(Race, Race.race_id == Result.race_id)
        .filter(Result.driver_id == driver_id)
        .group_by(Constructor.constructor_id, Constructor.name)
        .order_by(func.min(Race.season_year))
        .all()
    )

    seasons = [
        r[0]
        for r in db.query(distinct(Race.season_year))
        .join(Result, Result.race_id == Race.race_id)
        .filter(Result.driver_id == driver_id)
        .order_by(Race.season_year.desc())
        .all()
    ]

    headshot_url = _headshots_for(db, [driver_id]).get(driver_id)

    return {
        "driverId": driver.driver_id,
        "givenName": driver.given_name,
        "familyName": driver.family_name,
        "code": driver.code,
        "permanentNumber": driver.permanent_number,
        "dateOfBirth": driver.date_of_birth,
        "nationality": driver.nationality,
        "headshotUrl": headshot_url,
        "career": {
            "starts": totals.starts or 0,
            "wins": wins,
            "podiums": podiums,
            "poles": poles,
            "points": round(float(totals.points or 0.0), 2),
            "championships": championships,
        },
        "teamHistory": [
            {
                "constructorId": t.constructor_id,
                "name": t.name,
                "fromYear": t.from_year,
                "toYear": t.to_year,
                "races": t.races,
            }
            for t in team_history
        ],
        "seasons": seasons,
    }


@router.get("/{driver_id}/seasons/{year}")
def get_driver_season(driver_id: str, year: int, db: Session = Depends(get_db)):
    """One driver's race-by-race results for a single season."""
    if not db.query(Driver).filter(Driver.driver_id == driver_id).first():
        raise HTTPException(status_code=404, detail=f"Driver '{driver_id}' not found")

    rows = (
        db.query(Race, Result, Constructor)
        .join(Result, Result.race_id == Race.race_id)
        .join(Constructor, Constructor.constructor_id == Result.constructor_id)
        .filter(Result.driver_id == driver_id, Race.season_year == year)
        .order_by(Race.round)
        .all()
    )

    standing = (
        db.query(Standing)
        .filter(Standing.driver_id == driver_id, Standing.season_year == year)
        .first()
    )

    return {
        "driverId": driver_id,
        "season": year,
        "standing": {
            "position": standing.position,
            "points": standing.points,
            "wins": standing.wins,
        } if standing else None,
        "races": [
            {
                "round": race.round,
                "raceName": race.race_name,
                "circuitName": race.circuit_name,
                "date": race.date,
                "team": constructor.name,
                "grid": result.grid,
                "position": result.position,
                "points": result.points,
                "status": result.status,
            }
            for race, result, constructor in rows
        ],
    }
