# OpenTyreF1 — Dataset Reference

Everything this project runs on: where each dataset comes from, what it contains,
how it is ingested, and where to look at it inside this repository.

There is **no manual or proprietary data** in this project. Every row is derived
from three public F1 data sources and re-materialised locally by the ingestion
scripts in `backend/app/ingestion/`.

---

## 1. Where the data physically lives

| Location | What it is | In git? |
|---|---|---|
| `data/csv/*.csv` | **Human-readable export of every table.** Open any file directly on GitHub. | yes |
| `data/csv/*_sample.csv` | First 2,000 rows of the larger tables — GitHub renders these as a table in the browser. | yes |
| `data/manifest.json` | Machine-readable index: table to row count, columns, file, size. | yes |
| `backend/opentyref1.db` | The live SQLite database the API reads (~20 MB). | yes |
| `backend/app/ml/artifacts/tyre_model.joblib` | Trained XGBoost tyre-degradation model. | yes |
| `backend/app/ml/artifacts/metrics.json` | Model evaluation metrics and feature importance. | yes |
| `backend/cache/` | FastF1 pickle cache — regenerable, not committed. | ignored |

> **To view the data without cloning:** browse [`data/csv/`](data/csv/) on GitHub.
> Small tables render as a spreadsheet inline; for the large ones open the
> `*_sample.csv` version.

---

## 2. Upstream data sources

### 2.1 Jolpica-F1 (Ergast successor) — historical results

- **Endpoint:** `https://api.jolpi.ca/ergast/f1` (fallback `https://jolpi.ca/ergast/f1`)
- **Access:** free, public, no API key. Rate-limited to 4 req/s, 500/hour.
- **Ingested by:** `backend/app/ingestion/fetch_jolpica.py`
- **Coverage in this repo:** **2002–2026, 25 seasons, 492 races**
- **Populates tables:** `seasons`, `drivers`, `constructors`, `races`, `results`, `standings`
- **Note:** the API silently caps `limit` at 100, so results and qualifying endpoints
  are paged and merged by round — a race straddling a page boundary would otherwise
  arrive with only half its rows.

### 2.2 OpenF1 — lap-level timing, stints, pit stops, weather

- **Endpoint:** `https://api.openf1.org/v1`
- **Access:** free, public, no key for historical data. 3 req/s free tier.
  An optional `OPENF1_API_KEY` in `backend/.env` unlocks the paid live tier.
- **Ingested by:** `backend/app/ingestion/fetch_openf1.py`
- **Coverage in this repo:** **2023–2026, 105 sessions (82 Races + 23 Sprints), 24 circuits**
- **Populates tables:** `sessions`, `session_drivers`, `session_laps`, `session_stints`,
  `pit_stops`, `race_control_messages`, `session_weather`, `session_results`, `overtakes`
- **Why OpenF1 and not FastF1 for bulk ingest:** OpenF1 publishes the timing streams
  already parsed — roughly 2 s per race versus ~50 s through FastF1.

### 2.3 OpenF1 `car_data` + `location` — telemetry and track map (on demand)

- **Deliberately NOT bulk-ingested.** A single race holds millions of rows.
- **Served by:** `backend/app/services/openf1_client.py` — a process-local TTL cache
  (1 hour, 256 entries) sitting in front of OpenF1, exposed through
  `backend/app/routers/telemetry.py`.
- **Fields:** speed, throttle, brake, DRS, n_gear, RPM (`car_data`); x/y/z track
  coordinates (`location`).
- **Downsampling:** one lap is ~2–3k samples; the API returns 220 points per lap so a
  phone chart stays smooth.
- **The mobile app never calls OpenF1 directly** — that would blow the 3 req/s limit.

### 2.4 FastF1 — legacy and verification path

- **Package:** `fastf1>=3.1.0` (reads the official F1 live-timing archive)
- **Ingested by:** `backend/app/ingestion/fetch_fastf1.py`
- **Role:** kept as a cross-check and as a fallback for seasons OpenF1 does not cover.
  Its HTTP cache lands in `backend/cache/` (gitignored, regenerates on run).

---

## 3. What is actually in the database

Row counts are from the committed `backend/opentyref1.db` and match `data/csv/`.

| Table | Rows | CSV | Source | Description |
|---|---:|---|---|---|
| `seasons` | 25 | [seasons.csv](data/csv/seasons.csv) | Jolpica | One row per season, 2002–2026 |
| `drivers` | 136 | [drivers.csv](data/csv/drivers.csv) | Jolpica | Driver identity, code, number, nationality, DOB |
| `constructors` | 38 | [constructors.csv](data/csv/constructors.csv) | Jolpica | Team identity and nationality |
| `races` | 492 | [races.csv](data/csv/races.csv) | Jolpica | Round, circuit, date, country, lat/lng, session schedule |
| `results` | 10,068 | [results.csv](data/csv/results.csv) · [sample](data/csv/results_sample.csv) | Jolpica | Finishing position, grid, points, status, qualifying position |
| `standings` | 593 | [standings.csv](data/csv/standings.csv) | Jolpica | End-of-season driver championship standings |
| `sessions` | 105 | [sessions.csv](data/csv/sessions.csv) | OpenF1 | Race and Sprint sessions 2023–2026 linked to `races` |
| `session_drivers` | 2,130 | [session_drivers.csv](data/csv/session_drivers.csv) · [sample](data/csv/session_drivers_sample.csv) | OpenF1 | Per-session number-to-driver map, team colour, headshot |
| `session_laps` | **100,393** | [session_laps.csv](data/csv/session_laps.csv) · [sample](data/csv/session_laps_sample.csv) | OpenF1 | **The core dataset.** Per-lap time, compound, tyre life, stint, position, gap to leader, three sector times, speed trap, pit-out flag, wall-clock start |
| `session_stints` | 5,355 | [session_stints.csv](data/csv/session_stints.csv) | OpenF1 | Stint number, compound, lap range, tyre age at start |
| `pit_stops` | 2,975 | [pit_stops.csv](data/csv/pit_stops.csv) | OpenF1 | Lap, pit duration, pit-lane duration |
| `session_weather` | 7,526 | [session_weather.csv](data/csv/session_weather.csv) · [sample](data/csv/session_weather_sample.csv) | OpenF1 | Timestamped air/track temp, humidity, pressure, rainfall, wind |
| `race_control_messages` | 9,805 | [race_control_messages.csv](data/csv/race_control_messages.csv) · [sample](data/csv/race_control_messages_sample.csv) | OpenF1 | Flags, safety cars, investigations, penalties |
| `overtakes` | 22,383 | [overtakes.csv](data/csv/overtakes.csv) · [sample](data/csv/overtakes_sample.csv) | OpenF1 | Timestamped position changes, overtaker and overtaken |
| `session_results` | 2,110 | [session_results.csv](data/csv/session_results.csv) | OpenF1 | Final classification, gap, DNF/DNS/DSQ flags |

**Total: ~164,000 rows across 15 tables.**

### Coverage detail

**Lap data by year** (`session_laps`)

| Year | Laps |
|---|---:|
| 2023 | 26,660 |
| 2024 | 29,052 |
| 2025 | 28,428 |
| 2026 | 16,253 (season in progress) |

**Tyre compound distribution** (`session_laps.tyre_compound`)

| Compound | Laps |
|---|---:|
| HARD | 43,387 |
| MEDIUM | 39,374 |
| SOFT | 12,155 |
| INTERMEDIATE | 4,846 |
| WET | 94 |
| (unrecorded) | 537 |

**Races per season** (`races`) — 16 to 24 per season across 2002–2026, 492 total.

**24 circuits covered by lap data:** Austin, Baku, Catalunya, Hungaroring, Imola,
Interlagos, Jeddah, Las Vegas, Lusail, Melbourne, Mexico City, Miami, Monte Carlo,
Montreal, Monza, Sakhir, Shanghai, Silverstone, Singapore, Spa-Francorchamps,
Spielberg, Suzuka, Yas Marina, Zandvoort.

---

## 4. The machine-learning dataset

Built by `backend/app/ml/dataset.py`, trained by `backend/app/ml/train_tyre_model.py`.

**Training frame:** 40,012 clean race laps drawn from 82 race sessions
(58 train / 12 validation / 12 held-out races), 2023–2026.

Four deliberate choices shape it:

1. **Clean laps come from `services/lap_filters.clean_laps`**, the same filter the
   API's published pace numbers use — so the model, the race recap, and the analytics
   all agree on what a representative lap means. Training on raw laps teaches the
   model pit stops and safety cars instead of tyre behaviour.
2. **Only race sessions are used.** A Sprint shares its parent `race_id` but runs a
   much lighter fuel load; mixing the two teaches a fuel effect that does not exist.
3. **Weather is an as-of join,** not a column — each lap takes the most recent
   `session_weather` reading at or before its `date_start`.
4. **Whole races are held out,** never random rows, so the score cannot be inflated
   by leaking laps from a race the model has already seen.

**Features (`minimal` set, relative target):** `compound`, `circuit`, `driver_id`,
`tyre_life`, `lap_number`, `track_temp`.

**Held-out performance** — see [`backend/app/ml/artifacts/metrics.json`](backend/app/ml/artifacts/metrics.json):

| Model | MAE (s) | RMSE (s) | R² |
|---|---:|---:|---:|
| **XGBoost (shipped)** | **0.893** | **1.205** | **0.978** |
| Baseline: race median lap | 1.163 | 1.494 | 0.965 |
| Baseline: driver × circuit median | 4.096 | 5.420 | 0.545 |

The model beats the strongest naive baseline by 0.27 s MAE. Feature importance:
`lap_number` 0.42, `driver_id` 0.19, `circuit` 0.12, `track_temp` 0.10,
`compound` 0.09, `tyre_life` 0.08.

---

## 5. Reproducing the dataset from scratch

```bash
cd backend
python -m venv venv
venv/Scripts/activate          # Windows;  source venv/bin/activate on macOS/Linux
pip install -r requirements.txt

# 1. Historical results, 2002-2026 (~20 min, rate-limited)
python -m app.ingestion.fetch_jolpica

# 2. Lap-level data, 2023-2026 (~10 min)
python -m app.ingestion.fetch_openf1

# 3. Retrain the tyre model
python -m app.ml.train_tyre_model

# 4. Re-export the CSVs in data/csv/
python ../scripts/export_datasets.py
```

Telemetry (`car_data`) and track coordinates (`location`) need no ingestion step —
they are fetched and cached on demand when a screen requests them.

---

## 6. Attribution

- **Jolpica-F1 / Ergast** — <https://api.jolpi.ca/ergast/f1> — historical F1 results.
- **OpenF1** — <https://openf1.org> — lap timing, stints, telemetry, race control.
- **FastF1** — <https://github.com/theOehrly/Fast-F1> — official live-timing archive access.

This project is unofficial and unaffiliated with Formula 1, the FIA, or any team.
F1, FORMULA ONE and related marks are trademarks of Formula One Licensing B.V.
