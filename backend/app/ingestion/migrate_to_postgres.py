"""One-time migration: copy the local SQLite dataset into Postgres.

Reads through a second engine pointed at the committed `opentyref1.db`, writes
through the same SQLAlchemy models the app already uses (`app/models/models.py`)
so column mapping can never drift between the two sides.

Safe to re-run: each table is only copied if the destination is empty, so a
partial run (interrupted, or retried after fixing a connection string) picks
up where it left off rather than duplicating rows.

Usage (from backend/, with DATABASE_URL pointed at Postgres in the environment
or backend/.env — see database.py / config.py):

    python -m app.ingestion.migrate_to_postgres
    python -m app.ingestion.migrate_to_postgres --sqlite-path other.db
    python -m app.ingestion.migrate_to_postgres --batch-size 2000

Verified before writing this: all ten FK relationships in the shipped dataset
(results/session_laps/sessions -> races/drivers/constructors/seasons, plus
standings and session_drivers) have zero orphan rows, and Postgres enforces FKs
that SQLite does not — so insert order matters and is fixed below.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from app.database import Base, engine as target_engine
from app.models.models import (
    Season, Driver, Constructor, Race, Result, Standing,
    Session, SessionDriver, SessionLap, SessionStint, PitStop,
    RaceControlMessage, SessionWeather, SessionResult, Overtake,
)

# Insert order matters: every table here must come after every table it has a
# ForeignKey into. Postgres enforces that; SQLite (the source) never did.
MODELS_IN_DEPENDENCY_ORDER = [
    Season, Driver, Constructor, Race, Result, Standing,
    Session, SessionDriver, SessionLap, SessionStint, PitStop,
    RaceControlMessage, SessionWeather, SessionResult, Overtake,
]

# SQLite stores booleans as 0/1 integers; Postgres columns declared Boolean
# need real True/False or asyncpg-style drivers can choke on the raw int.
# (confirmed via PRAGMA table_info: only these two tables declare Boolean cols)
BOOLEAN_COLUMNS = {
    "session_results": ("dnf", "dns", "dsq"),
    "session_laps": ("is_pit_out_lap",),
}

# Every table with an autoincrement `id` PK needs its Postgres sequence bumped
# past the highest id we just inserted, or the next app-level insert collides.
SEQUENCE_TABLES = [
    "results", "standings", "session_laps", "session_drivers",
    "session_stints", "pit_stops", "race_control_messages",
    "session_weather", "session_results", "overtakes",
]


def _row_to_dict(row, columns: list[str], bool_cols: tuple[str, ...]) -> dict:
    d = {col: getattr(row, col) for col in columns}
    for col in bool_cols:
        if d.get(col) is not None:
            d[col] = bool(d[col])
    return d


def migrate(sqlite_path: str, batch_size: int, dry_run: bool) -> None:
    if not Path(sqlite_path).exists():
        sys.exit(f"SQLite source not found: {sqlite_path}")

    source_engine = create_engine(f"sqlite:///{sqlite_path}")
    SourceSession = sessionmaker(bind=source_engine)
    TargetSession = sessionmaker(bind=target_engine)

    print(f"Source : sqlite:///{sqlite_path}")
    print(f"Target : {target_engine.url.render_as_string(hide_password=True)}")
    if dry_run:
        print("(dry run — no writes)")

    # Postgres side needs the schema before anything can be inserted into it.
    Base.metadata.create_all(bind=target_engine)

    src = SourceSession()
    dst = TargetSession()
    try:
        for model in MODELS_IN_DEPENDENCY_ORDER:
            table = model.__tablename__
            existing = dst.query(model).count()
            if existing:
                print(f"  = {table:24} already has {existing} rows, skipping")
                continue

            total = src.query(model).count()
            if total == 0:
                print(f"  - {table:24} 0 rows in source, nothing to do")
                continue

            columns = [c.name for c in inspect(model).columns]
            bool_cols = BOOLEAN_COLUMNS.get(table, ())

            print(f"  > {table:24} {total} rows", end="", flush=True)
            if dry_run:
                print("  (dry run, skipped)")
                continue

            copied = 0
            q = src.query(model).yield_per(batch_size)
            for row in q:
                dst.add(model(**_row_to_dict(row, columns, bool_cols)))
                copied += 1
                if copied % batch_size == 0:
                    dst.commit()
                    print(".", end="", flush=True)
            dst.commit()
            print(f"  done ({copied})")

        if not dry_run:
            print("\nResetting Postgres sequences...")
            for table in SEQUENCE_TABLES:
                dst.execute(text(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                    f"COALESCE((SELECT MAX(id) FROM {table}), 1))"
                ))
            dst.commit()
            print("Sequences reset.")

        print("\nRow-count check:")
        for model in MODELS_IN_DEPENDENCY_ORDER:
            table = model.__tablename__
            s = src.query(model).count()
            t = dst.query(model).count() if not dry_run else "-"
            flag = "" if dry_run or s == t else "  <-- MISMATCH"
            print(f"  {table:24} sqlite={s:<8} postgres={t}{flag}")
    finally:
        src.close()
        dst.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite-path", default="opentyref1.db",
                         help="Path to the source SQLite file (default: opentyref1.db, run from backend/)")
    parser.add_argument("--batch-size", type=int, default=2000)
    parser.add_argument("--dry-run", action="store_true",
                         help="Print what would be copied without writing anything")
    args = parser.parse_args()
    migrate(args.sqlite_path, args.batch_size, args.dry_run)
