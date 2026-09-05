"""Ingest lap-level F1 data from the OpenF1 API (https://openf1.org).

OpenF1 covers 2023 onward and needs no API key for historical data. It is
roughly 20x faster than parsing the same sessions through FastF1 (~2s vs ~50s
per race), because it publishes the timing streams already parsed.

Deliberately NOT ingested here: `car_data` (telemetry) and `location` (track
coordinates). A single race holds millions of those rows, so they are fetched
on demand and cached instead — see app/services/openf1_client.py.
"""

import sys
import time
from datetime import datetime, date

import requests
from sqlalchemy.orm import Session as OrmSession

from app.database import engine, Base, SessionLocal
from app.models.models import (
    Driver, Race, Session, SessionDriver, SessionLap, SessionStint,
    PitStop, RaceControlMessage, SessionWeather, SessionResult, Overtake,
)

OPENF1_BASE = "https://api.openf1.org/v1"

# Free tier allows 3 req/s. Stay under it.
REQUEST_DELAY_SECONDS = 0.4

FIRST_SEASON = 2023  # OpenF1 coverage starts here


def fetch(endpoint: str, **params):
    """GET one OpenF1 endpoint, retrying once on rate-limit."""
    query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
    url = f"{OPENF1_BASE}/{endpoint}" + (f"?{query}" if query else "")
    for attempt in (1, 2):
        try:
            resp = requests.get(url, timeout=60)
            if resp.status_code == 429:
                print("    rate limited, backing off 30s...")
                time.sleep(30)
                continue
            if resp.status_code == 200:
                return resp.json()
            # 422/404 mean "no data for these filters", not a failure worth retrying.
            if resp.status_code in (404, 422):
                return []
            print(f"    HTTP {resp.status_code} for {endpoint}")
        except Exception as e:
            if attempt == 2:
                print(f"    failed {endpoint}: {e}")
        finally:
            time.sleep(REQUEST_DELAY_SECONDS)
    return []


def parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def build_timeline(rows, value_key):
    """Sort (timestamp, value) pairs so we can ask 'what was the value at time T'."""
    out = []
    for r in rows:
        t = parse_dt(r.get("date"))
        v = r.get(value_key)
        if t is not None and v is not None:
            out.append((t, v))
    out.sort(key=lambda p: p[0])
    return out


def value_at(timeline, when):
    """Last value at or before `when` (binary search over a sorted timeline)."""
    if not timeline or when is None:
        return None
    lo, hi, found = 0, len(timeline) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if timeline[mid][0] <= when:
            found = timeline[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1
    return found


def match_race(db: OrmSession, session_meta: dict):
    """Link an OpenF1 session to an existing Jolpica race by year + calendar date.

    Returns None rather than inventing a Race row — fabricating races and
    drivers is exactly the bug that made the old FastF1 path unusable.
    """
    start = parse_dt(session_meta.get("date_start"))
    if not start:
        return None
    year = session_meta.get("year") or start.year
    day = start.date().isoformat()
    race = db.query(Race).filter(Race.season_year == year, Race.date == day).first()
    if race:
        return race
    # Races occasionally straddle a date boundary by timezone; try +/- 1 day.
    for delta in (-1, 1):
        alt = date.fromisoformat(day).toordinal() + delta
        alt_day = date.fromordinal(alt).isoformat()
        race = db.query(Race).filter(Race.season_year == year, Race.date == alt_day).first()
        if race:
            return race
    return None


def resolve_drivers(db: OrmSession, session_key: int, driver_rows: list):
    """Map OpenF1 driver_number -> our driver_id for this session.

    Matches on the 3-letter acronym first, then surname. Unmatched drivers are
    logged and stored with a null driver_id; no placeholder Driver rows are
    ever created.
    """
    by_code = {}
    by_surname = {}
    for d in db.query(Driver).all():
        if d.code:
            by_code.setdefault(d.code.upper(), d.driver_id)
        if d.family_name:
            by_surname.setdefault(d.family_name.strip().lower(), d.driver_id)

    number_to_id = {}
    unmatched = []
    for row in driver_rows:
        num = row.get("driver_number")
        if num is None:
            continue
        acronym = (row.get("name_acronym") or "").upper()
        last = (row.get("last_name") or "").strip().lower()
        driver_id = by_code.get(acronym) or by_surname.get(last)
        if not driver_id:
            unmatched.append(row.get("full_name") or acronym or str(num))
        number_to_id[num] = driver_id

        existing = (
            db.query(SessionDriver)
            .filter(SessionDriver.session_key == session_key, SessionDriver.driver_number == num)
            .first()
        )
        if existing:
            continue
        db.add(SessionDriver(
            session_key=session_key,
            driver_number=num,
            driver_id=driver_id,
            full_name=row.get("full_name"),
            name_acronym=row.get("name_acronym"),
            team_name=row.get("team_name"),
            team_colour=f"#{row['team_colour']}" if row.get("team_colour") else None,
            headshot_url=row.get("headshot_url"),
        ))
    db.commit()
    if unmatched:
        print(f"    note: {len(unmatched)} driver(s) unmatched: {', '.join(unmatched[:5])}")
    return number_to_id


def ingest_session(db: OrmSession, meta: dict, race: Race):
    """Ingest one OpenF1 session: laps, stints, pits, weather, control, results."""
    session_key = meta["session_key"]

    if not db.query(Session).filter(Session.session_key == session_key).first():
        db.add(Session(
            session_key=session_key,
            race_id=race.race_id if race else None,
            meeting_key=meta.get("meeting_key"),
            year=meta.get("year"),
            session_name=meta.get("session_name"),
            session_type=meta.get("session_type"),
            circuit_short_name=meta.get("circuit_short_name"),
            location=meta.get("location"),
            country_name=meta.get("country_name"),
            date_start=meta.get("date_start"),
            date_end=meta.get("date_end"),
        ))
        db.commit()

    number_to_id = resolve_drivers(db, session_key, fetch("drivers", session_key=session_key))

    # --- Stints (also gives us per-lap compound + tyre age) ---
    stint_rows = fetch("stints", session_key=session_key)
    have_stints = db.query(SessionStint).filter(SessionStint.session_key == session_key).count()
    if not have_stints:
        for s in stint_rows:
            db.add(SessionStint(
                session_key=session_key,
                driver_number=s.get("driver_number"),
                driver_id=number_to_id.get(s.get("driver_number")),
                stint_number=s.get("stint_number"),
                compound=s.get("compound"),
                lap_start=s.get("lap_start"),
                lap_end=s.get("lap_end"),
                tyre_age_at_start=s.get("tyre_age_at_start"),
            ))
        db.commit()

    # Build a lap -> (compound, tyre_life, stint_no) lookup per driver.
    stint_lookup = {}
    for s in stint_rows:
        num = s.get("driver_number")
        lo, hi = s.get("lap_start"), s.get("lap_end")
        if num is None or lo is None or hi is None:
            continue
        age0 = s.get("tyre_age_at_start") or 0
        for lap in range(lo, hi + 1):
            stint_lookup[(num, lap)] = (s.get("compound"), age0 + (lap - lo), s.get("stint_number"))

    # --- Laps, enriched with position + gap by timestamp join ---
    if not db.query(SessionLap).filter(SessionLap.session_key == session_key).count():
        laps = fetch("laps", session_key=session_key)
        positions = fetch("position", session_key=session_key)
        intervals = fetch("intervals", session_key=session_key)

        pos_by_driver, gap_by_driver = {}, {}
        for num in {r.get("driver_number") for r in positions}:
            pos_by_driver[num] = build_timeline(
                [r for r in positions if r.get("driver_number") == num], "position")
        for num in {r.get("driver_number") for r in intervals}:
            gap_by_driver[num] = build_timeline(
                [r for r in intervals if r.get("driver_number") == num], "gap_to_leader")

        inserted = 0
        for lap in laps:
            num = lap.get("driver_number")
            lap_no = lap.get("lap_number")
            if num is None or lap_no is None:
                continue
            driver_id = number_to_id.get(num)
            if not driver_id:
                continue  # unmatched driver: skip rather than fabricate one

            started = parse_dt(lap.get("date_start"))
            gap = value_at(gap_by_driver.get(num, []), started)
            # gap_to_leader is "+1 LAP" (a string) for lapped cars; keep only numerics.
            gap_seconds = float(gap) if isinstance(gap, (int, float)) else None
            compound, tyre_life, stint_no = stint_lookup.get((num, lap_no), (None, None, None))

            db.add(SessionLap(
                race_id=race.race_id if race else None,
                driver_id=driver_id,
                session_key=session_key,
                lap_number=lap_no,
                lap_time_seconds=lap.get("lap_duration"),
                tyre_compound=compound,
                stint=stint_no,
                position=value_at(pos_by_driver.get(num, []), started),
                gap_to_leader_seconds=gap_seconds,
                tyre_life=tyre_life,
                is_pit_out_lap=lap.get("is_pit_out_lap"),
                date_start=lap.get("date_start"),
                sector_1_seconds=lap.get("duration_sector_1"),
                sector_2_seconds=lap.get("duration_sector_2"),
                sector_3_seconds=lap.get("duration_sector_3"),
                speed_trap_kph=lap.get("st_speed"),
            ))
            inserted += 1
        db.commit()
        print(f"    {inserted} laps")

    # --- Pit stops ---
    if not db.query(PitStop).filter(PitStop.session_key == session_key).count():
        for p in fetch("pit", session_key=session_key):
            db.add(PitStop(
                session_key=session_key,
                driver_number=p.get("driver_number"),
                driver_id=number_to_id.get(p.get("driver_number")),
                lap_number=p.get("lap_number"),
                pit_duration=p.get("pit_duration"),
                lane_duration=p.get("lane_duration"),
                date=p.get("date"),
            ))
        db.commit()

    # --- Race control ---
    if not db.query(RaceControlMessage).filter(RaceControlMessage.session_key == session_key).count():
        for m in fetch("race_control", session_key=session_key):
            db.add(RaceControlMessage(
                session_key=session_key,
                date=m.get("date"),
                lap_number=m.get("lap_number"),
                category=m.get("category"),
                flag=m.get("flag"),
                scope=m.get("scope"),
                message=m.get("message"),
                driver_number=m.get("driver_number"),
            ))
        db.commit()

    # --- Weather (downsampled: one sample per minute is plenty for a chart) ---
    if not db.query(SessionWeather).filter(SessionWeather.session_key == session_key).count():
        for i, w in enumerate(fetch("weather", session_key=session_key)):
            if i % 2:
                continue
            db.add(SessionWeather(
                session_key=session_key,
                date=w.get("date"),
                air_temperature=w.get("air_temperature"),
                track_temperature=w.get("track_temperature"),
                humidity=w.get("humidity"),
                pressure=w.get("pressure"),
                rainfall=w.get("rainfall"),
                wind_speed=w.get("wind_speed"),
                wind_direction=w.get("wind_direction"),
            ))
        db.commit()

    # --- Final classification ---
    if not db.query(SessionResult).filter(SessionResult.session_key == session_key).count():
        for r in fetch("session_result", session_key=session_key):
            duration = r.get("duration")
            if isinstance(duration, list):  # qualifying returns per-segment times
                duration = next((d for d in reversed(duration) if isinstance(d, (int, float))), None)
            db.add(SessionResult(
                session_key=session_key,
                driver_number=r.get("driver_number"),
                driver_id=number_to_id.get(r.get("driver_number")),
                position=r.get("position"),
                number_of_laps=r.get("number_of_laps"),
                points=r.get("points"),
                gap_to_leader=str(r.get("gap_to_leader")) if r.get("gap_to_leader") is not None else None,
                duration_seconds=duration if isinstance(duration, (int, float)) else None,
                dnf=r.get("dnf"),
                dns=r.get("dns"),
                dsq=r.get("dsq"),
            ))
        db.commit()

    # --- Overtakes ---
    if not db.query(Overtake).filter(Overtake.session_key == session_key).count():
        for o in fetch("overtakes", session_key=session_key):
            db.add(Overtake(
                session_key=session_key,
                date=o.get("date"),
                position=o.get("position"),
                overtaking_driver_number=o.get("overtaking_driver_number"),
                overtaken_driver_number=o.get("overtaken_driver_number"),
            ))
        db.commit()


def ingest_year(year: int, session_types=("Race",)):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        print(f"--- OpenF1 {year} ---")
        sessions = []
        for st in session_types:
            sessions.extend(fetch("sessions", year=year, session_type=st))
        sessions.sort(key=lambda s: s.get("date_start") or "")
        print(f"  {len(sessions)} sessions")

        for meta in sessions:
            key = meta.get("session_key")
            name = f"{meta.get('location')} {meta.get('session_name')}"
            if db.query(SessionLap).filter(SessionLap.session_key == key).count():
                print(f"  = {name} (already ingested)")
                continue
            race = match_race(db, meta)
            if not race:
                print(f"  ! {name}: no matching race row, skipping")
                continue
            print(f"  > {name}")
            try:
                ingest_session(db, meta, race)
            except Exception as e:
                db.rollback()
                print(f"    ERROR {name}: {e}")
    finally:
        db.close()


def ingest_all(start: int = FIRST_SEASON, end: int | None = None):
    if end is None:
        end = date.today().year
    for year in range(start, end + 1):
        try:
            ingest_year(year)
        except Exception as e:
            print(f"!!! {year} failed, continuing: {e}")
    print("\n=== OpenF1 ingestion complete ===")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--all" in sys.argv:
        ingest_all()
    elif args and args[0].isdigit():
        ingest_year(int(args[0]))
    else:
        ingest_year(2024)
