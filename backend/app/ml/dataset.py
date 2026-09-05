"""Builds the tyre-model training frame from the ingested OpenF1 lap data.

Four things here are deliberate rather than incidental:

- **Clean laps come from `services/lap_filters.clean_laps`, not a second
  implementation.** The recap's published pace numbers, the 5e analysis
  metrics, and this training set therefore agree on what "a representative
  lap" means. A model trained on raw laps learns pit stops and safety cars,
  which is the usual reason a tyre model comes out garbage.
- **Only `session_name == 'Race'` sessions are used.** A Sprint shares its
  parent race's `race_id`, and it runs on a much lighter fuel load, so mixing
  the two teaches the model a fuel effect that does not exist.
- **Weather is an as-of join, not a column.** `session_laps` has no
  temperature field; `session_weather` is a timestamped trace. Each lap takes
  the most recent reading at or before its `date_start`.
- **`season` and `team` are features, not metadata.** The obvious baseline for
  this problem is "this driver's median lap at this circuit", and it is a
  strong one. The model only earns its place by knowing the things that
  baseline cannot see: which season's car this is (regulations and
  development move lap times by seconds year to year), which team built it,
  and what the track was doing at that moment.
"""

from __future__ import annotations

from bisect import bisect_right

import pandas as pd
from sqlalchemy.orm import Session as OrmSession

from app.models.models import Race, Session, SessionDriver, SessionWeather
from app.services.lap_filters import clean_laps, median_clean_lap

ALL_CATEGORICAL: tuple[str, ...] = ("compound", "circuit", "driver_id", "team")
ALL_NUMERIC: tuple[str, ...] = (
    "tyre_life", "lap_number", "stint", "season", "track_temp", "air_temp", "is_wet",
)
ALL_FEATURES: tuple[str, ...] = ALL_CATEGORICAL + ALL_NUMERIC
TARGET = "lap_time_seconds"

# More features is not automatically a better model, and here it measurably
# was not: the wider set overfits and loses to the naive baseline on a
# whole-race holdout. Both are kept so `--features` can pick between them on
# evidence rather than on intuition, and so the comparison is reproducible.
FEATURE_SETS: dict[str, tuple[str, ...]] = {
    "minimal": ("compound", "circuit", "driver_id", "tyre_life", "lap_number", "track_temp"),
    "conditions": (
        "compound", "circuit", "driver_id",
        "tyre_life", "lap_number", "stint", "track_temp", "air_temp", "is_wet",
    ),
    "full": ALL_FEATURES,
}
DEFAULT_FEATURE_SET = "minimal"

# Carried through the frame but never shown to the model: `session_key` and
# `year` so the trainer can hold out whole races, `session_median` so it can
# optionally learn an offset from the race's own pace instead of an absolute
# lap time.
PASSTHROUGH: tuple[str, ...] = ("session_key", "race_id", "year", "session_median")


class WeatherTrace:
    """Timestamped weather for one session, queried as of a lap's start time.

    Both sides are ISO-8601 strings produced by the same OpenF1 ingest, so
    lexicographic comparison is chronological comparison here.
    """

    __slots__ = ("dates", "track", "air", "rain")

    def __init__(self, db: OrmSession, session_key: int):
        rows = (
            db.query(
                SessionWeather.date,
                SessionWeather.track_temperature,
                SessionWeather.air_temperature,
                SessionWeather.rainfall,
            )
            .filter(SessionWeather.session_key == session_key, SessionWeather.date.isnot(None))
            .order_by(SessionWeather.date)
            .all()
        )
        self.dates = [r[0] for r in rows]
        self.track = [r[1] for r in rows]
        self.air = [r[2] for r in rows]
        self.rain = [r[3] for r in rows]

    def at(self, when: str | None) -> tuple[float | None, float | None, float | None]:
        """(track temp, air temp, wet flag) as of `when`."""
        if not self.dates or not when:
            return None, None, None
        i = max(bisect_right(self.dates, when) - 1, 0)
        rain = self.rain[i]
        return (
            float(self.track[i]) if self.track[i] is not None else None,
            float(self.air[i]) if self.air[i] is not None else None,
            float(bool(rain)) if rain is not None else None,
        )


def as_of_temperature(dates: list[str], temps: list[float], when: str | None) -> float | None:
    """Standalone as-of lookup, kept for callers that only need track temp."""
    if not dates or not when:
        return None
    return temps[max(bisect_right(dates, when) - 1, 0)]


def race_sessions(db: OrmSession, min_year: int | None = None) -> list[tuple[Session, Race | None]]:
    """Every ingested Race session, oldest first, with its Jolpica race row."""
    q = (
        db.query(Session, Race)
        .outerjoin(Race, Race.race_id == Session.race_id)
        .filter(Session.session_name == "Race")
    )
    if min_year is not None:
        q = q.filter(Session.year >= min_year)
    return q.order_by(Session.date_start).all()


def circuit_key(session: Session, race: Race | None) -> str:
    """A stable circuit label. `circuit_short_name` is OpenF1's own key and is
    the most consistent of the three candidates; the Jolpica name is a fallback
    for the handful of sessions that ingested without it."""
    return (
        session.circuit_short_name
        or (race.circuit_name if race else None)
        or session.location
        or "unknown"
    )


def team_lookup(db: OrmSession, session_key: int) -> dict[str, str]:
    """driver_id -> team name for one session. Drivers change teams, so this
    cannot be a global map."""
    return {
        driver_id: team
        for driver_id, team in db.query(SessionDriver.driver_id, SessionDriver.team_name)
        .filter(SessionDriver.session_key == session_key)
        .all()
        if driver_id and team
    }


def build_training_frame(db: OrmSession, min_year: int | None = None) -> pd.DataFrame:
    """One row per clean race lap, with the features the simulator can supply.

    Returns an empty frame (with the right columns) when nothing qualifies,
    so callers can check `.empty` instead of guarding against None.
    """
    records: list[dict] = []

    for session, race in race_sessions(db, min_year=min_year):
        laps = clean_laps(db, session.session_key)
        if not laps:
            continue

        weather = WeatherTrace(db, session.session_key)
        teams = team_lookup(db, session.session_key)
        circuit = circuit_key(session, race)

        # The reference pace of this race, across the whole field. Carried so
        # the trainer can optionally learn the *offset* from it rather than an
        # absolute lap time. See `--target relative` in train_tyre_model.py.
        session_median = median_clean_lap([l.lap_time_seconds for l in laps])

        for lap in laps:
            if lap.tyre_life is None or lap.tyre_compound is None:
                continue
            track_temp, air_temp, is_wet = weather.at(lap.date_start)
            records.append({
                "compound": lap.tyre_compound.upper(),
                "circuit": circuit,
                "driver_id": lap.driver_id,
                "team": teams.get(lap.driver_id),
                "tyre_life": float(lap.tyre_life),
                "lap_number": float(lap.lap_number),
                "stint": float(lap.stint) if lap.stint is not None else None,
                "season": float(session.year),
                "track_temp": track_temp,
                "air_temp": air_temp,
                "is_wet": is_wet,
                TARGET: float(lap.lap_time_seconds),
                "session_median": session_median,
                "session_key": session.session_key,
                "race_id": session.race_id,
                "year": session.year,
            })

    if not records:
        return pd.DataFrame(columns=[*ALL_FEATURES, TARGET, *PASSTHROUGH])

    return pd.DataFrame.from_records(records)


def design_matrix(
    rows: pd.DataFrame | list[dict],
    features: list[str],
    categories: dict[str, list[str]],
) -> pd.DataFrame:
    """The exact frame the model expects: right columns, right dtypes.

    XGBoost's native categorical support keys on the pandas dtype, so training
    and prediction must share the same category ordering. Freezing that list
    into the artifact and rebuilding from it here is what stops training and
    serving from drifting apart. A value the model never saw (a rookie, a new
    circuit) becomes NaN, which XGBoost routes down its default branch rather
    than crashing.
    """
    frame = pd.DataFrame(rows) if not isinstance(rows, pd.DataFrame) else rows.copy()
    for column in features:
        if column not in frame.columns:
            frame[column] = None
    out = frame[features].copy()
    for column in features:
        if column in categories:
            out[column] = pd.Categorical(out[column], categories=categories[column])
        else:
            out[column] = pd.to_numeric(out[column], errors="coerce")
    return out


def learn_categories(frame: pd.DataFrame, features: list[str]) -> dict[str, list[str]]:
    """The category vocabulary to freeze into the model artifact."""
    return {
        c: sorted(frame[c].dropna().unique().tolist())
        for c in features if c in ALL_CATEGORICAL
    }
