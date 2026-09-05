"""Runs a hypothetical tyre strategy through the lap-time model and plays the
result back against what actually happened in that race.

Shape of the answer, and why:

- **`frames` is a full-field leaderboard, not just the simulated driver.** The
  chosen driver's laps come from the model; every other car keeps its real lap
  times. Ranking the resulting cumulative times each lap is what turns
  "predicted total 1:32:04" into "you would have finished P4 instead of P7",
  and it means `<RaceReplayPlayer>` renders a simulation exactly the way it
  renders a real race, with no second player.
- **The comparison is at equal lap counts.** If the plan does not cover the
  full race distance, the real driver's cumulative time is taken at the same
  lap number rather than at the flag, so the delta stays like-for-like. A
  warning says so.
- **Pit loss is measured, not assumed.** OpenF1's `pit_duration` has real
  outliers (a red-flagged car sitting in the pits reads as 2,485s), so the
  sample is clamped to a plausible pit-lane window before taking its median.
- **No model is not an error.** On a fresh clone, before anyone has run
  training, the simulator falls back to an empirical model fitted to that
  race's own clean laps and says so in `modelSource`.
"""

from __future__ import annotations

from collections import defaultdict
from statistics import median

from fastapi import HTTPException
from sqlalchemy.orm import Session as OrmSession

from app.ml import predictor
from app.ml.dataset import WeatherTrace, circuit_key, team_lookup
from app.models.models import (
    Race, Session, SessionLap, SessionResult, SessionStint, PitStop,
)
from app.services.analysis import _linreg_slope
from app.services.lap_filters import clean_laps, median_clean_lap, race_session_key
from app.services.presentation import driver_meta_by_id, TEAM_FALLBACK

# A pit-lane transit that is not a pit-lane transit: below this it is a timing
# artifact, above it the car was stopped for a red flag or a repair.
PIT_LOSS_MIN, PIT_LOSS_MAX = 15.0, 45.0
DEFAULT_PIT_LOSS = 22.0
MIN_PIT_SAMPLES = 5

MAX_STINTS = 6
KNOWN_COMPOUNDS = ("SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET")

# A lap on which the whole field is this much slower than the race's reference
# pace was not a racing lap: it was a safety car, a VSC, a red flag or a
# downpour. Tyre strategy does not set your lap time on those, so the
# simulated car is held to what the field actually did. 10% is comfortably
# outside normal green-flag scatter (the clean-lap filter itself uses 107%)
# while catching every real neutralisation.
NEUTRALISED_THRESHOLD = 1.10

# Used only by the empirical fallback, when no trained artifact exists.
FALLBACK_DEG_PER_LAP = {"SOFT": 0.085, "MEDIUM": 0.050, "HARD": 0.030,
                        "INTERMEDIATE": 0.060, "WET": 0.060}


# ---------------------------------------------------------------------------
# Race context
# ---------------------------------------------------------------------------

def resolve_session(db: OrmSession, race_id: str) -> Session:
    sk = race_session_key(db, race_id)
    session = db.query(Session).filter(Session.session_key == sk).first() if sk else None
    if not session:
        raise HTTPException(status_code=404, detail=f"No ingested race session for '{race_id}'")
    return session


def _lap_conditions(db: OrmSession, session_key: int) -> dict[int, tuple]:
    """lap_number -> (track temp, air temp, wet flag), as of the first car to
    start that lap.

    `session_laps` carries no weather columns, so this is the same as-of join
    onto the timestamped weather trace that `ml/dataset.py` trains against.
    Sharing `WeatherTrace` is what keeps training features and prediction
    features literally the same computation.
    """
    trace = WeatherTrace(db, session_key)

    starts: dict[int, str] = {}
    for lap_number, date_start in (
        db.query(SessionLap.lap_number, SessionLap.date_start)
        .filter(SessionLap.session_key == session_key, SessionLap.date_start.isnot(None))
        .all()
    ):
        if lap_number not in starts or date_start < starts[lap_number]:
            starts[lap_number] = date_start

    return {lap: trace.at(when) for lap, when in starts.items()}


def measured_pit_loss(db: OrmSession, session: Session) -> tuple[float, str]:
    """Median pit-lane time loss, preferring this race, then this circuit."""
    def _sample(query) -> list[float]:
        return [
            float(d) for (d,) in query.all()
            if d is not None and PIT_LOSS_MIN <= d <= PIT_LOSS_MAX
        ]

    this_race = _sample(
        db.query(PitStop.pit_duration).filter(PitStop.session_key == session.session_key)
    )
    if len(this_race) >= MIN_PIT_SAMPLES:
        return round(median(this_race), 2), "this race"

    if session.circuit_short_name:
        circuit = _sample(
            db.query(PitStop.pit_duration)
            .join(Session, Session.session_key == PitStop.session_key)
            .filter(
                Session.circuit_short_name == session.circuit_short_name,
                Session.session_name == "Race",
            )
        )
        if len(circuit) >= MIN_PIT_SAMPLES:
            return round(median(circuit), 2), f"{session.circuit_short_name}, all seasons"

    everywhere = _sample(db.query(PitStop.pit_duration))
    if len(everywhere) >= MIN_PIT_SAMPLES:
        return round(median(everywhere), 2), "all circuits"

    # OpenF1's pit endpoint 404s for 2023, so a 2023 race can legitimately
    # reach here with nothing to measure.
    return DEFAULT_PIT_LOSS, "default estimate (no pit data ingested)"


# ---------------------------------------------------------------------------
# Lap-time prediction
# ---------------------------------------------------------------------------

def _plan_laps(stints: list[dict], race_laps: int) -> tuple[list[dict], list[str]]:
    """Expand stints into one row per lap, and flag anything odd about the plan."""
    warnings: list[str] = []
    if not stints:
        raise HTTPException(status_code=400, detail="A strategy needs at least one stint.")
    if len(stints) > MAX_STINTS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_STINTS} stints.")

    plan: list[dict] = []
    lap = 1
    for index, stint in enumerate(stints):
        compound = (stint.get("compound") or "").upper()
        if compound not in KNOWN_COMPOUNDS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown compound '{stint.get('compound')}'. Expected one of {', '.join(KNOWN_COMPOUNDS)}.",
            )
        length = int(stint.get("laps") or 0)
        if length < 1:
            raise HTTPException(status_code=400, detail="Every stint needs at least one lap.")
        age_at_start = max(0, int(stint.get("tyreAgeAtStart") or 0))
        for lap_in_stint in range(1, length + 1):
            plan.append({
                "lap": lap,
                "stint": index + 1,
                "compound": compound,
                "tyre_life": float(age_at_start + lap_in_stint),
                "lap_in_stint": lap_in_stint,
                "stint_laps": length,
            })
            lap += 1

    planned = len(plan)
    if planned != race_laps:
        direction = "short of" if planned < race_laps else "beyond"
        warnings.append(
            f"The plan covers {planned} laps, {abs(planned - race_laps)} {direction} the "
            f"{race_laps}-lap race distance. Times are compared over {min(planned, race_laps)} laps."
        )
    if len(stints) == 1:
        warnings.append("A no-stop plan assumes one set of tyres lasts the distance, which the model extrapolates well beyond any real stint length it was trained on.")

    return plan, warnings


def _empirical_model(db: OrmSession, session_key: int, driver_id: str, laps: list[SessionLap]):
    """A lap-time function fitted to this race's own clean laps.

    Used when no trained artifact exists. It is deliberately simple and
    labelled as such in the response: base pace for this driver, plus a
    per-compound offset and degradation slope measured in this race, plus the
    session's own fuel-burn slope.
    """
    times_by_driver: dict[str, list[float]] = defaultdict(list)
    by_compound: dict[str, list[SessionLap]] = defaultdict(list)
    for lap in laps:
        times_by_driver[lap.driver_id].append(lap.lap_time_seconds)
        if lap.tyre_compound:
            by_compound[lap.tyre_compound.upper()].append(lap)

    field_times = sorted(t for ts in times_by_driver.values() for t in ts)
    field_median = median_clean_lap(field_times) if field_times else 90.0
    own = sorted(times_by_driver.get(driver_id, []))
    base = median_clean_lap(own) if own else field_median

    fuel_slope = _linreg_slope(
        [float(l.lap_number) for l in laps], [l.lap_time_seconds for l in laps]
    ) if len(laps) > 1 else 0.0
    mean_lap = sum(l.lap_number for l in laps) / len(laps) if laps else 1.0

    offsets: dict[str, float] = {}
    slopes: dict[str, float] = {}
    for compound, rows in by_compound.items():
        offsets[compound] = median_clean_lap(sorted(r.lap_time_seconds for r in rows)) - field_median
        aged = [r for r in rows if r.tyre_life is not None]
        if len(aged) >= 5:
            slope = _linreg_slope(
                [float(r.tyre_life) for r in aged], [r.lap_time_seconds for r in aged]
            ) - fuel_slope
            slopes[compound] = max(0.0, slope)

    def predict(row: dict) -> float:
        compound = row["compound"]
        slope = slopes.get(compound, FALLBACK_DEG_PER_LAP.get(compound, 0.05))
        return (
            base
            + offsets.get(compound, 0.0)
            + slope * row["tyre_life"]
            + fuel_slope * (row["lap"] - mean_lap)
        )

    return predict


def _feature_rows(
    rows: list[dict], circuit: str, driver_id: str, team: str | None,
    season: int, conditions: dict[int, tuple], default: tuple, session_median: float,
) -> list[dict]:
    """Build model input rows. One place, so the plan and the calibration set
    are described to the model in exactly the same terms."""
    out = []
    for row in rows:
        track_temp, air_temp, is_wet = conditions.get(row["lap"], default)
        out.append({
            "compound": row["compound"],
            "circuit": circuit,
            "driver_id": driver_id,
            "team": team,
            "tyre_life": row["tyre_life"],
            "lap_number": float(row["lap"]),
            "stint": float(row["stint"]),
            "season": float(season),
            "track_temp": track_temp,
            "air_temp": air_temp,
            "is_wet": is_wet,
            "session_median": session_median,
        })
    return out


def _driver_calibration(
    driver_laps: list[SessionLap], predicted: list[float]
) -> float | None:
    """How far the model is off this driver, in this race, on average.

    A regressor shrinks toward the mean, so it systematically under-rates the
    quickest cars and over-rates the slowest: replaying a race winner's real
    strategy came out over two minutes slow purely from that. Because the
    simulator only ever runs against a race that actually happened, the
    driver's own clean laps are available to correct it. The model still
    supplies the *shape* of the curve, which is what changing a strategy
    moves; their own race supplies the absolute level.

    Uses the median residual rather than the mean so one anomalous lap that
    survived the clean-lap filter cannot drag the whole simulation with it.
    """
    residuals = [
        lap.lap_time_seconds - prediction
        for lap, prediction in zip(driver_laps, predicted)
    ]
    if len(residuals) < 5:
        return None
    return median(residuals)


def _predict_plan(
    db: OrmSession,
    session: Session,
    race: Race | None,
    driver_id: str,
    plan: list[dict],
    reference_laps: list[SessionLap],
) -> tuple[list[float], dict]:
    """Lap times for every lap of the plan, plus provenance for the client."""
    circuit = circuit_key(session, race)
    conditions = _lap_conditions(db, session.session_key)

    # A lap the plan reaches but the real race never ran (a longer hypothetical
    # distance) has no weather reading of its own, so it inherits the session's
    # median rather than becoming a hole in the feature row.
    def _median_of(index: int) -> float | None:
        values = [c[index] for c in conditions.values() if c[index] is not None]
        return median(values) if values else None

    default = (_median_of(0), _median_of(1), _median_of(2))
    team = team_lookup(db, session.session_key).get(driver_id)

    # The race's own reference pace. Only used by a relative-target model, but
    # computed the same way `ml/dataset.py` does at training time, so the two
    # cannot drift.
    session_median = median_clean_lap([l.lap_time_seconds for l in reference_laps])

    def build(rows: list[dict]) -> list[dict]:
        return _feature_rows(
            rows, circuit, driver_id, team, session.year, conditions, default, session_median,
        )

    if predictor.available():
        times = predictor.predict(build(plan))

        # Correct the model's shrinkage against this driver's own laps in this
        # race. See `_driver_calibration`.
        own_laps = [
            lap for lap in reference_laps
            if lap.driver_id == driver_id and lap.tyre_life is not None and lap.tyre_compound
        ]
        calibration = None
        if own_laps:
            calibration = _driver_calibration(own_laps, predictor.predict(build([
                {
                    "lap": lap.lap_number,
                    "stint": lap.stint or 1,
                    "compound": lap.tyre_compound.upper(),
                    "tyre_life": float(lap.tyre_life),
                }
                for lap in own_laps
            ])))
        if calibration is not None:
            times = [t + calibration for t in times]

        relative = predictor.needs_reference_pace()
        source = {
            "modelSource": "trained",
            "modelDetail": (
                "XGBoost model trained on clean race laps, predicting each lap's offset from "
                "this race's median clean lap."
                if relative else
                "XGBoost lap-time model, trained on clean race laps."
            ) + (
                f" Calibrated {calibration:+.3f}s against this driver's own clean laps here."
                if calibration is not None else
                " Not calibrated: too few clean laps for this driver in this race."
            ),
            "circuitInTraining": predictor.knows_circuit(circuit),
            "driverInTraining": predictor.knows_driver(driver_id),
            "perLapMaeSeconds": predictor.holdout_mae(),
            "driverCalibrationSeconds": round(calibration, 3) if calibration is not None else None,
        }
        return times, source

    predict = _empirical_model(db, session.session_key, driver_id, reference_laps)
    return [predict(row) for row in plan], {
        "modelSource": "empirical",
        "modelDetail": (
            "No trained model artifact found, so pace and degradation were fitted to this "
            "race's own clean laps. Run `python -m app.ml.train_tyre_model` for the model path."
        ),
        "circuitInTraining": False,
        "driverInTraining": False,
        "perLapMaeSeconds": None,
        # The empirical model is already anchored to this driver's own median
        # lap in this race, so it has nothing to calibrate away.
        "driverCalibrationSeconds": None,
    }


# ---------------------------------------------------------------------------
# The real race, for comparison and for the other 19 cars
# ---------------------------------------------------------------------------

def _real_cumulative(db: OrmSession, session_key: int) -> tuple[dict[str, dict[int, float]], dict[str, int], int]:
    """Per-driver cumulative race time by lap, their last completed lap, and the
    race distance.

    Two kinds of hole get filled with the driver's own median lap:

    - a row that exists but carries no time, and
    - **a lap number with no row at all.**

    The second one is the dangerous one and it is not hypothetical: the 2026
    Dutch Grand Prix is missing lap 44 for the race winner. Walking only the
    lap numbers that happen to be present silently shortens that driver's race
    by a full lap, which made a correct simulation look 76 seconds slow and
    would let a rival "gain" a lap's worth of time in the replay frames.
    """
    rows = (
        db.query(SessionLap.driver_id, SessionLap.lap_number, SessionLap.lap_time_seconds)
        .filter(SessionLap.session_key == session_key)
        .order_by(SessionLap.lap_number)
        .all()
    )
    if not rows:
        raise HTTPException(status_code=404, detail="No lap data ingested for this race.")

    times: dict[str, dict[int, float | None]] = defaultdict(dict)
    for driver_id, lap_number, lap_time in rows:
        times[driver_id][lap_number] = lap_time

    race_laps = max(lap for laps in times.values() for lap in laps)

    cumulative: dict[str, dict[int, float]] = {}
    last_lap: dict[str, int] = {}
    for driver_id, laps in times.items():
        recorded = [t for t in laps.values() if t is not None]
        if not recorded:
            continue
        stand_in = median(recorded)
        final_lap = max(laps)
        running = 0.0
        series: dict[int, float] = {}
        for lap_number in range(1, final_lap + 1):
            running += laps.get(lap_number) or stand_in
            series[lap_number] = running
        cumulative[driver_id] = series
        last_lap[driver_id] = final_lap

    return cumulative, last_lap, race_laps


def _real_stints(db: OrmSession, session_key: int, driver_id: str) -> list[dict]:
    return [
        {
            "stint": s.stint_number,
            "compound": s.compound,
            "lapStart": s.lap_start,
            "lapEnd": s.lap_end,
            "laps": (s.lap_end - s.lap_start + 1) if s.lap_start and s.lap_end else None,
        }
        for s in db.query(SessionStint)
        .filter(SessionStint.session_key == session_key, SessionStint.driver_id == driver_id)
        .order_by(SessionStint.stint_number)
        .all()
    ]


def field_pace_by_lap(db: OrmSession, session_key: int) -> dict[int, float]:
    """The field's median actual lap time, per lap of the real race.

    This is how a hypothetical race learns about the real one's interruptions.
    The model is trained on clean laps, so it predicts a green-flag lap and
    nothing else: left alone, a simulated car simply skips every safety car,
    every VSC and every red flag, and finishes minutes ahead of a field that
    could not. Taking the *median* across the field isolates track-wide
    conditions from one driver's own bad lap, because a neutralisation slows
    everybody at once while a spin or a pit stop slows one car.
    """
    times: dict[int, list[float]] = defaultdict(list)
    for lap_number, lap_time in (
        db.query(SessionLap.lap_number, SessionLap.lap_time_seconds)
        .filter(SessionLap.session_key == session_key, SessionLap.lap_time_seconds.isnot(None))
        .all()
    ):
        times[lap_number].append(lap_time)
    return {lap: median(values) for lap, values in times.items() if values}


def _lap_detail(db: OrmSession, session_key: int) -> dict[tuple[str, int], dict]:
    """(driver_id, lap) -> compound / tyre life / lap time for the real race.

    Read once per simulation: the frame loop touches this roughly
    `drivers x laps` times, and a query per cell would be ~1,200 round-trips
    for a single request.
    """
    return {
        (driver_id, lap_number): {
            "compound": compound, "tyre_life": tyre_life, "lap_time": lap_time,
        }
        for driver_id, lap_number, compound, tyre_life, lap_time in db.query(
            SessionLap.driver_id, SessionLap.lap_number,
            SessionLap.tyre_compound, SessionLap.tyre_life, SessionLap.lap_time_seconds,
        ).filter(SessionLap.session_key == session_key).all()
    }


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def strategy_options(db: OrmSession, race_id: str) -> dict:
    """Everything the strategy screen needs to populate its pickers.

    Includes each driver's real stint plan, so "load the actual strategy" is a
    one-tap starting point rather than something the user has to retype.
    """
    session = resolve_session(db, race_id)
    race = db.query(Race).filter(Race.race_id == race_id).first()
    sk = session.session_key
    meta = driver_meta_by_id(db, sk)

    _, _, race_laps = _real_cumulative(db, sk)
    finish = {
        r.driver_id: r
        for r in db.query(SessionResult).filter(SessionResult.session_key == sk).all()
        if r.driver_id
    }

    compounds_used = {
        (c or "").upper()
        for (c,) in db.query(SessionStint.compound)
        .filter(SessionStint.session_key == sk, SessionStint.compound.isnot(None))
        .distinct()
        .all()
    }

    drivers = []
    for driver_id, m in meta.items():
        result = finish.get(driver_id)
        stints = _real_stints(db, sk, driver_id)
        drivers.append({
            "driverId": driver_id,
            "code": m.get("code"),
            "name": m.get("name"),
            "team": m.get("team"),
            "teamColour": m.get("teamColour", TEAM_FALLBACK),
            "headshotUrl": m.get("headshotUrl"),
            "finishPosition": result.position if result else None,
            "dnf": bool(result.dnf) if result else False,
            "actualStints": [
                {"compound": s["compound"], "laps": s["laps"]}
                for s in stints if s["laps"]
            ],
        })
    drivers.sort(key=lambda d: (d["finishPosition"] is None, d["finishPosition"] or 99))

    pit_loss, pit_loss_source = measured_pit_loss(db, session)

    return {
        "raceId": race_id,
        "raceName": race.race_name if race else None,
        "circuitName": race.circuit_name if race else session.circuit_short_name,
        "season": race.season_year if race else session.year,
        "date": race.date if race else None,
        "sessionKey": sk,
        "raceLaps": race_laps,
        "compounds": [c for c in KNOWN_COMPOUNDS if c in compounds_used] or list(KNOWN_COMPOUNDS[:3]),
        "pitLossSeconds": pit_loss,
        "pitLossSource": pit_loss_source,
        "drivers": drivers,
        "defaultDriverId": drivers[0]["driverId"] if drivers else None,
        "model": predictor.status(),
    }


def simulate(
    db: OrmSession,
    race_id: str,
    driver_id: str,
    stints: list[dict],
    pit_loss_override: float | None = None,
) -> dict:
    session = resolve_session(db, race_id)
    race = db.query(Race).filter(Race.race_id == race_id).first()
    sk = session.session_key

    meta = driver_meta_by_id(db, sk)
    if driver_id not in meta:
        raise HTTPException(status_code=404, detail=f"Driver '{driver_id}' did not race here.")

    cumulative, last_lap, race_laps = _real_cumulative(db, sk)
    plan, warnings = _plan_laps(stints, race_laps)
    horizon = min(len(plan), race_laps)

    reference_laps = clean_laps(db, sk)
    lap_times, provenance = _predict_plan(db, session, race, driver_id, plan, reference_laps)

    # Hold the simulated car to the field's pace on neutralised laps. Without
    # this the prediction is a green-flag race against a field that ran two
    # safety cars, and the delta is meaningless.
    reference_pace = median_clean_lap([l.lap_time_seconds for l in reference_laps])
    field_pace = field_pace_by_lap(db, sk)
    neutralised: set[int] = set()
    if reference_pace:
        for index, row in enumerate(plan):
            actual = field_pace.get(row["lap"])
            if actual and actual > reference_pace * NEUTRALISED_THRESHOLD:
                lap_times[index] = actual
                neutralised.add(row["lap"])

    pit_loss, pit_loss_source = measured_pit_loss(db, session)
    if pit_loss_override is not None:
        pit_loss = round(float(pit_loss_override), 2)
        pit_loss_source = "supplied by the request"

    # --- Per-lap curve, with the pit stop charged to the last lap of the stint
    curve = []
    running = 0.0
    for row, predicted in zip(plan, lap_times):
        is_stop = row["lap_in_stint"] == row["stint_laps"] and row["stint"] < plan[-1]["stint"]
        running += predicted + (pit_loss if is_stop else 0.0)
        curve.append({
            "lap": row["lap"],
            "stint": row["stint"],
            "compound": row["compound"],
            "tyreLife": int(row["tyre_life"]),
            "predictedTime": round(predicted, 3),
            "cumulativeTime": round(running, 3),
            "pitStop": is_stop,
            "neutralised": row["lap"] in neutralised,
        })

    stops = max(0, len({row["stint"] for row in plan}) - 1)
    simulated_total = curve[horizon - 1]["cumulativeTime"] if curve else 0.0

    # --- Per-stint breakdown, the "why" behind the total
    breakdown = []
    for stint_number in sorted({row["stint"] for row in plan}):
        rows = [c for c in curve if c["stint"] == stint_number]
        predicted = [c["predictedTime"] for c in rows]
        # Degradation is measured on racing laps only. A safety-car lap in the
        # middle of a stint is a 100-second outlier that would swamp a slope
        # fitted through 20 laps of real tyre wear.
        racing = [c for c in rows if not c["neutralised"]]
        breakdown.append({
            "stint": stint_number,
            "compound": rows[0]["compound"],
            "laps": len(rows),
            "lapStart": rows[0]["lap"],
            "lapEnd": rows[-1]["lap"],
            "neutralisedLaps": len(rows) - len(racing),
            "averageLap": round(
                sum(c["predictedTime"] for c in racing) / len(racing), 3
            ) if racing else round(sum(predicted) / len(predicted), 3),
            "openingLap": round(racing[0]["predictedTime"] if racing else predicted[0], 3),
            "closingLap": round(racing[-1]["predictedTime"] if racing else predicted[-1], 3),
            "degradationPerLap": round(
                _linreg_slope(
                    [float(c["tyreLife"]) for c in racing],
                    [c["predictedTime"] for c in racing],
                ), 4
            ) if len(racing) >= 2 else 0.0,
        })

    # --- The real race, at the same lap count
    actual_series = cumulative.get(driver_id, {})
    actual_at_horizon = actual_series.get(min(horizon, last_lap.get(driver_id, 0)))
    actual_result = (
        db.query(SessionResult)
        .filter(SessionResult.session_key == sk, SessionResult.driver_id == driver_id)
        .first()
    )
    real_stints = _real_stints(db, sk, driver_id)
    retired = bool(actual_result and (actual_result.dnf or actual_result.dns))
    if retired:
        warnings.append(
            f"{meta[driver_id].get('code') or driver_id} did not finish this race, so the "
            "comparison runs only to the lap they retired on."
        )

    # --- Full-field frames: the simulated car against the real other 19
    lap_detail = _lap_detail(db, sk)
    frames = []
    for lap in range(1, horizon + 1):
        entries = []
        for other_id, series in cumulative.items():
            if lap not in series:
                continue
            if other_id == driver_id:
                continue
            entries.append({"driverId": other_id, "cumulative": series[lap], "simulated": False})
        if lap <= len(curve):
            entries.append({
                "driverId": driver_id,
                "cumulative": curve[lap - 1]["cumulativeTime"],
                "simulated": True,
            })
        if not entries:
            continue

        entries.sort(key=lambda e: e["cumulative"])
        leader = entries[0]["cumulative"]
        leaderboard = []
        for position, entry in enumerate(entries, start=1):
            m = meta.get(entry["driverId"], {})
            if entry["simulated"]:
                row = curve[lap - 1]
                compound, tyre_life, lap_time = row["compound"], row["tyreLife"], row["predictedTime"]
            else:
                real = lap_detail.get(
                    (entry["driverId"], lap),
                    {"compound": None, "tyre_life": None, "lap_time": None},
                )
                compound, tyre_life, lap_time = real["compound"], real["tyre_life"], real["lap_time"]
            leaderboard.append({
                "position": position,
                "driverId": entry["driverId"],
                "code": m.get("code"),
                "name": m.get("name"),
                "team": m.get("team"),
                "teamColour": m.get("teamColour", TEAM_FALLBACK),
                "gap": round(entry["cumulative"] - leader, 3),
                "tyreCompound": compound,
                "tyreLife": tyre_life,
                "lapTime": lap_time,
                "isPitOutLap": False,
                "simulated": entry["simulated"],
            })
        frames.append({"lap": lap, "leaderboard": leaderboard})

    projected_position = None
    if frames:
        for entry in frames[-1]["leaderboard"]:
            if entry["driverId"] == driver_id:
                projected_position = entry["position"]
                break

    # --- Honest uncertainty, rather than an invented confidence percentage
    per_lap_mae = provenance.get("perLapMaeSeconds")
    margin = round(per_lap_mae * (horizon ** 0.5), 1) if per_lap_mae else None
    notes = []
    if provenance["modelSource"] == "trained":
        if not provenance["circuitInTraining"]:
            notes.append("This circuit was not in the training data, so pace is extrapolated.")
        if not provenance["driverInTraining"]:
            notes.append("This driver was not in the training data, so their pace is generalised from the field.")
    longest = max((b["laps"] for b in breakdown), default=0)
    if longest > 40:
        notes.append(f"The longest stint is {longest} laps, past where real stint data supports the degradation curve.")
    if neutralised:
        notes.append(
            f"{len(neutralised)} of {horizon} laps ran behind a safety car or under a red flag in "
            "the real race. Strategy cannot change those, so they are held at the field's actual "
            "pace rather than predicted."
        )

    return {
        "raceId": race_id,
        "raceName": race.race_name if race else None,
        "circuitName": race.circuit_name if race else session.circuit_short_name,
        "season": race.season_year if race else session.year,
        "sessionKey": sk,
        "driver": {
            "driverId": driver_id,
            "code": meta[driver_id].get("code"),
            "name": meta[driver_id].get("name"),
            "team": meta[driver_id].get("team"),
            "teamColour": meta[driver_id].get("teamColour", TEAM_FALLBACK),
            "headshotUrl": meta[driver_id].get("headshotUrl"),
        },
        "raceLaps": race_laps,
        "plannedLaps": len(plan),
        "comparedOverLaps": horizon,
        "totalTime": round(simulated_total, 3),
        "pitStops": stops,
        "pitLossSeconds": pit_loss,
        "pitLossSource": pit_loss_source,
        "timeLostInPits": round(pit_loss * stops, 3),
        "neutralisedLaps": len(neutralised),
        "referencePace": round(reference_pace, 3) if reference_pace else None,
        "projectedFinishDelta": (
            round(simulated_total - actual_at_horizon, 3) if actual_at_horizon else None
        ),
        "projectedPosition": projected_position,
        "actual": {
            "position": actual_result.position if actual_result else None,
            "dnf": retired,
            "totalTime": round(actual_at_horizon, 3) if actual_at_horizon else None,
            # OpenF1's own classified race time. Reconstructing the total by
            # summing laps should agree with it; where it does not, the lap
            # data has a gap, and showing both is more useful than picking one
            # and hoping.
            "officialTime": (
                round(actual_result.duration_seconds, 3)
                if actual_result and actual_result.duration_seconds else None
            ),
            "lapsCompleted": last_lap.get(driver_id),
            "stints": [{"compound": s["compound"], "laps": s["laps"]} for s in real_stints if s["laps"]],
            "stops": max(0, len(real_stints) - 1),
        },
        "stintBreakdown": breakdown,
        "degradationCurve": curve,
        "frames": frames,
        "uncertainty": {
            "perLapMaeSeconds": per_lap_mae,
            "totalTimeMarginSeconds": margin,
            "notes": notes,
        },
        "warnings": warnings,
        **{k: v for k, v in provenance.items() if k != "perLapMaeSeconds"},
    }
