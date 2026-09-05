import json
import sys
import time
from datetime import date

import requests
from sqlalchemy.orm import Session
from app.database import engine, Base, SessionLocal, ensure_columns
from app.models.models import Season, Driver, Constructor, Race, Result, Standing

JOLPICA_BASE_URL = "https://api.jolpi.ca/ergast/f1"
ERGAST_FALLBACK_URL = "https://jolpi.ca/ergast/f1"

# Jolpica allows 4 requests/sec and 500/hour for anonymous callers. Backfilling
# ~24 seasons means hundreds of requests, so pace them to stay under the burst limit.
REQUEST_DELAY_SECONDS = 0.3

# Jolpica silently caps `limit` at 100 regardless of what's requested, so any
# endpoint whose row count can exceed 100 (results, qualifying) must be paged.
PAGE_SIZE = 100


def fetch_json(endpoint: str):
    urls = [f"{JOLPICA_BASE_URL}/{endpoint}", f"{ERGAST_FALLBACK_URL}/{endpoint}"]
    for url in urls:
        try:
            resp = requests.get(url, timeout=20)
            if resp.status_code == 429:
                # Rate limited — back off once and retry the same URL before falling through.
                print("  Rate limited by Jolpica, backing off 60s...")
                time.sleep(60)
                resp = requests.get(url, timeout=20)
            if resp.status_code == 200:
                return resp.json()
        except Exception as e:
            print(f"Warning: Failed to fetch from {url}: {e}")
        finally:
            time.sleep(REQUEST_DELAY_SECONDS)
    raise RuntimeError(f"Failed to fetch data for endpoint {endpoint} from both primary and fallback APIs.")


def fetch_paginated_races(endpoint: str, result_list_key: str):
    """Fetch every page of a Race-shaped endpoint (results.json, qualifying.json)
    and merge into one list of Race dicts.

    Jolpica pages by row count (one result/qualifying row = one unit), not by
    race, so a race sitting on a page boundary comes back split across two
    pages with partial `result_list_key` lists. Merge by round instead of
    concatenating so that race isn't left with only half its rows.
    """
    sep = "&" if "?" in endpoint else "?"
    offset = 0
    total = None
    races_by_round: dict[str, dict] = {}
    order: list[str] = []

    while total is None or offset < total:
        data = fetch_json(f"{endpoint}{sep}limit={PAGE_SIZE}&offset={offset}")
        mrdata = data.get("MRData", {})
        total = int(mrdata.get("total", 0))
        page_races = mrdata.get("RaceTable", {}).get("Races", [])
        if not page_races:
            break

        for r in page_races:
            rnd = r.get("round")
            if rnd in races_by_round:
                races_by_round[rnd].setdefault(result_list_key, []).extend(
                    r.get(result_list_key, [])
                )
            else:
                races_by_round[rnd] = r
                order.append(rnd)

        offset += PAGE_SIZE

    return [races_by_round[rnd] for rnd in order]


def ingest_jolpica_season(year: int = 2023):
    Base.metadata.create_all(bind=engine)
    db: Session = SessionLocal()

    try:
        print(f"--- Ingesting Jolpica-F1 Data for Season {year} ---")

        # 1. Season
        season_obj = db.query(Season).filter(Season.year == year).first()
        if not season_obj:
            season_obj = Season(year=year, url=f"https://en.wikipedia.org/wiki/{year}_Formula_One_World_Championship")
            db.add(season_obj)
            db.commit()
            print(f"Added Season {year}")

        # 2. Drivers
        drivers_data = fetch_json(f"{year}/drivers.json")
        driver_list = drivers_data.get("MRData", {}).get("DriverTable", {}).get("Drivers", [])
        print(f"Fetched {len(driver_list)} drivers")

        for d in driver_list:
            driver_id = d.get("driverId")
            existing = db.query(Driver).filter(Driver.driver_id == driver_id).first()
            if not existing:
                driver_obj = Driver(
                    driver_id=driver_id,
                    permanent_number=d.get("permanentNumber"),
                    code=d.get("code"),
                    given_name=d.get("givenName", ""),
                    family_name=d.get("familyName", ""),
                    date_of_birth=d.get("dateOfBirth"),
                    nationality=d.get("nationality")
                )
                db.add(driver_obj)
        db.commit()

        # 3. Race Results (includes constructors, races, and results) — paginated,
        # since a season can have 400+ result rows and Jolpica caps pages at 100.
        races_list = fetch_paginated_races(f"{year}/results.json", "Results")
        print(f"Fetched {len(races_list)} races with results")

        for r in races_list:
            race_id = f"{year}_{r.get('round')}"
            circuit_name = r.get("Circuit", {}).get("circuitName", "")

            # Race record
            existing_race = db.query(Race).filter(Race.race_id == race_id).first()
            if not existing_race:
                race_obj = Race(
                    race_id=race_id,
                    season_year=year,
                    round=int(r.get("round")),
                    race_name=r.get("raceName", ""),
                    circuit_name=circuit_name,
                    date=r.get("date")
                )
                db.add(race_obj)
                db.commit()

            # Results records
            for res in r.get("Results", []):
                c_data = res.get("Constructor", {})
                c_id = c_data.get("constructorId")
                if c_id:
                    existing_c = db.query(Constructor).filter(Constructor.constructor_id == c_id).first()
                    if not existing_c:
                        c_obj = Constructor(
                            constructor_id=c_id,
                            name=c_data.get("name", ""),
                            nationality=c_data.get("nationality")
                        )
                        db.add(c_obj)
                        db.commit()

                d_id = res.get("Driver", {}).get("driverId")

                # Check existing result
                existing_res = db.query(Result).filter(
                    Result.race_id == race_id,
                    Result.driver_id == d_id
                ).first()

                if not existing_res and d_id and c_id:
                    res_obj = Result(
                        race_id=race_id,
                        driver_id=d_id,
                        constructor_id=c_id,
                        number=int(res.get("number")) if res.get("number") else None,
                        position=int(res.get("position")) if res.get("position") else None,
                        points=float(res.get("points")) if res.get("points") else 0.0,
                        grid=int(res.get("grid")) if res.get("grid") else None,
                        laps=int(res.get("laps")) if res.get("laps") else None,
                        status=res.get("status")
                    )
                    db.add(res_obj)
        db.commit()

        # 3b. Qualifying positions — used for accurate pole counts (grid position
        # after a penalty isn't the same as who actually qualified on pole).
        # Coverage is spotty before ~2003; missing years just leave the column
        # null and callers fall back to grid position, per the PRD's degrade-
        # gracefully-not-fake-data rule.
        qualifying_races = fetch_paginated_races(f"{year}/qualifying.json", "QualifyingResults")
        qual_rows_updated = 0
        for r in qualifying_races:
            race_id = f"{year}_{r.get('round')}"
            for qres in r.get("QualifyingResults", []):
                d_id = qres.get("Driver", {}).get("driverId")
                qpos = qres.get("position")
                if not d_id or not qpos:
                    continue
                result_row = db.query(Result).filter(
                    Result.race_id == race_id,
                    Result.driver_id == d_id,
                ).first()
                if result_row is not None:
                    result_row.qualifying_position = int(qpos)
                    qual_rows_updated += 1
        db.commit()
        print(f"Updated {qual_rows_updated} qualifying positions")

        # 4. Driver championship standings (end of season)
        standings_data = fetch_json(f"{year}/driverStandings.json?limit=100")
        standings_lists = (
            standings_data.get("MRData", {})
            .get("StandingsTable", {})
            .get("StandingsLists", [])
        )
        standing_rows = standings_lists[0].get("DriverStandings", []) if standings_lists else []
        print(f"Fetched {len(standing_rows)} driver standings")

        for s in standing_rows:
            d_id = s.get("Driver", {}).get("driverId")
            if not d_id:
                continue
            # Guard the FK: a standings row can name a driver the season roster missed.
            if not db.query(Driver).filter(Driver.driver_id == d_id).first():
                dd = s.get("Driver", {})
                db.add(Driver(
                    driver_id=d_id,
                    permanent_number=dd.get("permanentNumber"),
                    code=dd.get("code"),
                    given_name=dd.get("givenName", ""),
                    family_name=dd.get("familyName", ""),
                    date_of_birth=dd.get("dateOfBirth"),
                    nationality=dd.get("nationality"),
                ))
                db.commit()

            # Constructors is a list because a driver can switch teams mid-season.
            constructors = s.get("Constructors", [])
            c_id = constructors[-1].get("constructorId") if constructors else None
            if c_id and not db.query(Constructor).filter(Constructor.constructor_id == c_id).first():
                c_obj = Constructor(
                    constructor_id=c_id,
                    name=constructors[-1].get("name", ""),
                    nationality=constructors[-1].get("nationality"),
                )
                db.add(c_obj)
                db.commit()

            existing_standing = db.query(Standing).filter(
                Standing.season_year == year,
                Standing.driver_id == d_id,
            ).first()
            if existing_standing:
                continue

            db.add(Standing(
                season_year=year,
                driver_id=d_id,
                constructor_id=c_id,
                position=int(s["position"]) if s.get("position") else None,
                points=float(s["points"]) if s.get("points") else 0.0,
                wins=int(s["wins"]) if s.get("wins") else 0,
            ))
        db.commit()

        print(f"--- Jolpica Ingestion Complete for Season {year} ---")

    except Exception as e:
        db.rollback()
        print(f"Error during Jolpica ingestion: {e}")
        raise
    finally:
        db.close()

SCHEDULE_SESSION_KEYS = [
    "FirstPractice", "SecondPractice", "ThirdPractice",
    "SprintQualifying", "SprintShootout", "Sprint", "Qualifying",
]


def ingest_schedule(year: int):
    """Full-season calendar via /{year}.json — unlike /{year}/results.json,
    this also returns races that haven't happened yet, which is the only way
    to populate 'upcoming races'. Verified live: 23 races for 2026, 11 of
    them with a future date as of this writing.

    Unlike ingest_jolpica_season's check-then-insert (which never touches an
    existing row), this UPDATES existing races too — otherwise a past race
    already ingested via results.json would never gain a country/lat/lng.
    """
    Base.metadata.create_all(bind=engine)
    ensure_columns("races", {
        "country": "TEXT", "locality": "TEXT", "race_time": "TEXT",
        "lat": "REAL", "lng": "REAL", "schedule_json": "TEXT",
    })
    db: Session = SessionLocal()
    try:
        print(f"--- Ingesting Jolpica schedule for {year} ---")

        if not db.query(Season).filter(Season.year == year).first():
            db.add(Season(year=year, url=f"https://en.wikipedia.org/wiki/{year}_Formula_One_World_Championship"))
            db.commit()

        data = fetch_json(f"{year}.json")
        races = data.get("MRData", {}).get("RaceTable", {}).get("Races", [])
        print(f"Fetched {len(races)} races on the {year} calendar")

        updated, inserted = 0, 0
        for r in races:
            race_id = f"{year}_{r.get('round')}"
            circuit = r.get("Circuit", {})
            location = circuit.get("Location", {})
            schedule = {
                key: r[key] for key in SCHEDULE_SESSION_KEYS if key in r
            }

            existing = db.query(Race).filter(Race.race_id == race_id).first()
            fields = dict(
                season_year=year,
                round=int(r.get("round")),
                race_name=r.get("raceName", ""),
                circuit_name=circuit.get("circuitName", ""),
                date=r.get("date"),
                country=location.get("country"),
                locality=location.get("locality"),
                race_time=r.get("time"),
                lat=float(location["lat"]) if location.get("lat") else None,
                lng=float(location["long"]) if location.get("long") else None,
                schedule_json=json.dumps(schedule) if schedule else None,
            )

            if existing:
                for k, v in fields.items():
                    setattr(existing, k, v)
                updated += 1
            else:
                db.add(Race(race_id=race_id, **fields))
                inserted += 1

        db.commit()
        print(f"--- Schedule ingestion complete for {year}: {inserted} inserted, {updated} updated ---")

    except Exception as e:
        db.rollback()
        print(f"Error during schedule ingestion: {e}")
        raise
    finally:
        db.close()


def ingest_all_schedules(start: int = 2002, end: int | None = None):
    if end is None:
        end = date.today().year
    for year in range(start, end + 1):
        try:
            ingest_schedule(year)
        except Exception as e:
            print(f"!!! Schedule {year} failed, continuing: {e}")


def ingest_all_seasons(start: int = 2002, end: int | None = None):
    """Backfill every season from `start` to `end` inclusive.

    ingest_jolpica_season is idempotent, so re-running this is safe and will only
    fill gaps. A season that fails (network blip, API outage) is logged and skipped
    rather than aborting the whole backfill.
    """
    if end is None:
        end = date.today().year

    failed = []
    for year in range(start, end + 1):
        try:
            ingest_jolpica_season(year)
        except Exception as e:
            print(f"!!! Season {year} failed, continuing: {e}")
            failed.append(year)

    print(f"\n=== Backfill {start}-{end} complete ===")
    if failed:
        print(f"Failed seasons (re-run to retry): {failed}")
    else:
        print("All seasons ingested successfully.")


if __name__ == "__main__":
    if "--schedule" in sys.argv:
        digits = [a for a in sys.argv[1:] if a.isdigit()]
        if digits:
            ingest_schedule(int(digits[0]))
        else:
            ingest_all_schedules()
    elif "--all" in sys.argv:
        ingest_all_seasons()
    elif len(sys.argv) > 1 and sys.argv[1].isdigit():
        ingest_jolpica_season(int(sys.argv[1]))
    else:
        ingest_jolpica_season(2023)
