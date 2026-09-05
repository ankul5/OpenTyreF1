"""Export every table in backend/opentyref1.db to browsable CSV under data/csv/.

The point is that the dataset is inspectable straight from the GitHub web UI
without cloning or running anything. GitHub renders a CSV as a table only up to
roughly 512 KB, so any export past that also gets a `<table>_sample.csv` holding
the first 2,000 rows, which does render.

Run from the repo root:  python scripts/export_datasets.py
"""

from __future__ import annotations

import csv
import json
import os
import sqlite3
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(REPO_ROOT, "backend", "opentyref1.db")
OUT_DIR = os.path.join(REPO_ROOT, "data", "csv")
MANIFEST_PATH = os.path.join(REPO_ROOT, "data", "manifest.json")

# GitHub stops rendering a CSV as a table somewhere above this; sample instead.
INLINE_RENDER_LIMIT_BYTES = 400_000
SAMPLE_ROWS = 2_000

# csv.field_size_limit defaults low enough to trip on schedule_json blobs.
csv.field_size_limit(10_000_000)


def export() -> list[dict]:
    if not os.path.exists(DB_PATH):
        sys.exit(f"database not found: {DB_PATH}\nRun the ingestion scripts first.")

    os.makedirs(OUT_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    tables = [
        r[0]
        for r in conn.execute(
            "select name from sqlite_master where type='table' "
            "and name not like 'sqlite_%' order by name"
        )
    ]

    manifest: list[dict] = []
    for table in tables:
        cursor = conn.execute(f'select * from "{table}"')
        columns = [d[0] for d in cursor.description]
        rows = cursor.fetchall()

        path = os.path.join(OUT_DIR, f"{table}.csv")
        with open(path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow(columns)
            writer.writerows(rows)

        size = os.path.getsize(path)
        entry = {
            "table": table,
            "rows": len(rows),
            "columns": columns,
            "csv": f"data/csv/{table}.csv",
            "bytes": size,
        }

        if size > INLINE_RENDER_LIMIT_BYTES:
            sample_path = os.path.join(OUT_DIR, f"{table}_sample.csv")
            with open(path, encoding="utf-8") as src, \
                 open(sample_path, "w", newline="", encoding="utf-8") as dst:
                for i, line in enumerate(src):
                    if i > SAMPLE_ROWS:
                        break
                    dst.write(line)
            entry["sample_csv"] = f"data/csv/{table}_sample.csv"

        manifest.append(entry)
        print(f"{table:26s} {len(rows):>8,} rows  {size / 1024 / 1024:>7.2f} MB")

    conn.close()

    with open(MANIFEST_PATH, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    total = sum(e["rows"] for e in manifest)
    print(f"\n{len(manifest)} tables, {total:,} rows -> {OUT_DIR}")
    return manifest


if __name__ == "__main__":
    export()
