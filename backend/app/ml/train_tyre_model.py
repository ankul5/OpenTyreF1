"""Trains (and retrains) the lap-time model behind the strategy simulator.

    python -m app.ml.train_tyre_model                    # default feature set
    python -m app.ml.train_tyre_model --compare          # score every feature set
    python -m app.ml.train_tyre_model --features conditions
    python -m app.ml.train_tyre_model --min-year 2024

The fit itself takes seconds: this is tens of thousands of rows of tabular
data, not deep learning. The work that matters is upstream, in what counts as
a clean lap (see `services/lap_filters.py`), and in the two evaluation
decisions below, which are the difference between a real number and a
flattering one.

**The split is by whole race, three ways.** Two laps from the same race share
a car, a track surface, a fuel load and a weather trace, so splitting laps
randomly leaks almost everything. Races are therefore assigned whole to train,
validation or holdout. Early stopping watches *validation*; the holdout is
scored once, at the end, and never influences a single training decision. An
earlier version early-stopped on the holdout itself, which is training on the
test set by another name.

**The bar is a naive baseline.** "Every lap is this driver's median lap at
this circuit" is a genuinely strong predictor, because most lap-time variance
is between circuits rather than within a race. If the model cannot beat it,
the model is not adding anything, and saying so is more useful than reporting
an impressive-looking R squared. (A season-aware baseline is deliberately not
used: with a whole-race holdout, a held-out race's circuit+driver+season
combination can never appear in training, so that baseline silently collapses
back to this one and measures nothing.)
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from xgboost import XGBRegressor

from app.database import SessionLocal
from app.ml.dataset import (
    ALL_CATEGORICAL, DEFAULT_FEATURE_SET, FEATURE_SETS, TARGET,
    build_training_frame, design_matrix, learn_categories,
)

ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"
ARTIFACT_PATH = ARTIFACT_DIR / "tyre_model.joblib"
ARTIFACT_VERSION = 2


def split_by_race(
    frame: pd.DataFrame, validation: float = 0.15, holdout: float = 0.15, seed: int = 7
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Assign whole races to train / validation / holdout.

    Randomised rather than "most recent races last", so the holdout is not
    all one season: a single-season holdout measures how well the model
    extrapolates to a new car generation, which is a different and much
    harder question than the one the simulator actually asks.
    """
    sessions = np.array(sorted(frame["session_key"].unique()))
    rng = np.random.default_rng(seed)
    rng.shuffle(sessions)

    n_holdout = max(1, int(round(len(sessions) * holdout)))
    n_validation = max(1, int(round(len(sessions) * validation)))
    holdout_keys = set(sessions[:n_holdout])
    validation_keys = set(sessions[n_holdout:n_holdout + n_validation])

    is_holdout = frame["session_key"].isin(holdout_keys)
    is_validation = frame["session_key"].isin(validation_keys)
    return frame[~is_holdout & ~is_validation], frame[is_validation], frame[is_holdout]


def baseline_predictions(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """"Every lap is this driver's median lap at this circuit."

    Falls back to the circuit median, then the global median, for pairs the
    training set never saw.
    """
    by_pair = train.groupby(["circuit", "driver_id"], observed=True)[TARGET].median()
    by_circuit = train.groupby("circuit", observed=True)[TARGET].median()
    global_median = float(train[TARGET].median())

    out = []
    for circuit, driver_id in zip(test["circuit"], test["driver_id"]):
        value = by_pair.get((circuit, driver_id))
        if value is None or pd.isna(value):
            value = by_circuit.get(circuit)
        if value is None or pd.isna(value):
            value = global_median
        out.append(float(value))
    return np.asarray(out)


def _scores(y_true, y_pred) -> dict[str, float]:
    return {
        "mae": round(float(mean_absolute_error(y_true, y_pred)), 4),
        "rmse": round(float(np.sqrt(mean_squared_error(y_true, y_pred))), 4),
        "r2": round(float(r2_score(y_true, y_pred)), 4),
    }


def fit_one(
    frame: pd.DataFrame,
    feature_set: str,
    splits: tuple[pd.DataFrame, ...],
    target_mode: str = "absolute",
) -> tuple[XGBRegressor, dict, dict]:
    """Fit one configuration and score it on the untouched holdout.

    `target_mode="relative"` trains on `lap_time - the race's own median clean
    lap` and adds that median back at scoring time. This is legitimate rather
    than leakage: the simulator only ever runs against a real historical race,
    so that race's median clean lap is a known quantity at prediction time,
    exactly as it is here. It removes the part of the problem the model is
    worst at (absolute circuit pace, which varies by tens of seconds) and
    leaves the part it exists to learn (what the tyre, the fuel load and the
    conditions do to a lap). Scores are always reported in absolute seconds so
    the two modes and the baseline stay directly comparable.
    """
    train_df, validation_df, holdout_df = splits
    features = list(FEATURE_SETS[feature_set])
    categories = learn_categories(train_df, features)

    x_train = design_matrix(train_df, features, categories)
    x_validation = design_matrix(validation_df, features, categories)
    x_holdout = design_matrix(holdout_df, features, categories)

    if target_mode == "relative":
        y_train = train_df[TARGET] - train_df["session_median"]
        y_validation = validation_df[TARGET] - validation_df["session_median"]
    else:
        y_train, y_validation = train_df[TARGET], validation_df[TARGET]

    model = XGBRegressor(
        n_estimators=1200,
        learning_rate=0.05,
        max_depth=6,
        min_child_weight=4,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_lambda=1.5,
        objective="reg:squarederror",
        tree_method="hist",
        enable_categorical=True,
        early_stopping_rounds=50,
        n_jobs=0,
        random_state=7,
    )
    model.fit(x_train, y_train, eval_set=[(x_validation, y_validation)], verbose=False)

    predicted = model.predict(x_holdout)
    if target_mode == "relative":
        predicted = predicted + holdout_df["session_median"].to_numpy()

    model_scores = _scores(holdout_df[TARGET], predicted)
    base_scores = _scores(holdout_df[TARGET], baseline_predictions(train_df, holdout_df))

    # The matched baseline for a relative model. A relative model is handed the
    # race's median clean lap, so beating a baseline that is *not* handed it
    # proves nothing. This one is: it predicts exactly that median for every
    # lap, i.e. an offset of zero. Beating it is the only evidence that the
    # model has learned what the tyre, the fuel load and the conditions do.
    reference_scores = _scores(holdout_df[TARGET], holdout_df["session_median"].to_numpy())
    headline_baseline = reference_scores if target_mode == "relative" else base_scores

    metrics = {
        "model": model_scores,
        "baseline_driver_circuit_median": base_scores,
        "baseline_race_median_lap": reference_scores,
        "headline_baseline": (
            "baseline_race_median_lap" if target_mode == "relative"
            else "baseline_driver_circuit_median"
        ),
        "mae_improvement_seconds": round(headline_baseline["mae"] - model_scores["mae"], 4),
        "beats_baseline": model_scores["mae"] < headline_baseline["mae"],
        "best_iteration": int(getattr(model, "best_iteration", 0) or 0),
        "feature_set": feature_set,
        "target_mode": target_mode,
    }
    return model, metrics, categories


# Two configurations whose holdout MAE differs by less than this are, for our
# sample size, the same model. When that happens the simpler one wins: fewer
# features means fewer things to go wrong at prediction time and a shorter
# story to defend.
PARSIMONY_TOLERANCE_SECONDS = 0.05


def train(
    min_year: int | None = None,
    feature_set: str = DEFAULT_FEATURE_SET,
    target_mode: str = "absolute",
    compare: bool = False,
    out_path: Path = ARTIFACT_PATH,
) -> dict:
    db = SessionLocal()
    try:
        print("Building training frame from ingested laps...")
        frame = build_training_frame(db, min_year=min_year)
    finally:
        db.close()

    if frame.empty:
        raise SystemExit(
            "No clean race laps found. Run `python -m app.ingestion.fetch_openf1 --all` first."
        )

    for column in ALL_CATEGORICAL:
        frame[column] = frame[column].astype("object")

    print(f"  {len(frame):,} clean laps across {frame['session_key'].nunique()} races "
          f"({frame['year'].min()}-{frame['year'].max()})")

    splits = split_by_race(frame)
    train_df, validation_df, holdout_df = splits
    print(f"  train {len(train_df):,} laps / {train_df['session_key'].nunique()} races"
          f"   validation {validation_df['session_key'].nunique()} races"
          f"   holdout {holdout_df['session_key'].nunique()} races")

    candidates = (
        [(f, t) for t in ("absolute", "relative") for f in FEATURE_SETS]
        if compare else [(feature_set, target_mode)]
    )
    results = []
    for name, mode in candidates:
        print(f"Fitting '{name}' ({len(FEATURE_SETS[name])} features, {mode} target)...")
        model, metrics, categories = fit_one(frame, name, splits, target_mode=mode)
        results.append((name, mode, model, metrics, categories))
        print(f"  holdout MAE {metrics['model']['mae']:.3f}s   "
              f"vs its baseline {metrics[metrics['headline_baseline']]['mae']:.3f}s   "
              f"improvement {metrics['mae_improvement_seconds']:+.3f}s")

    # Best score, then simplest configuration within noise of it.
    best_mae = min(r[3]["model"]["mae"] for r in results)
    within_noise = [r for r in results if r[3]["model"]["mae"] <= best_mae + PARSIMONY_TOLERANCE_SECONDS]
    name, mode, model, metrics, categories = min(
        within_noise, key=lambda r: (len(FEATURE_SETS[r[0]]), r[3]["model"]["mae"])
    )
    features = list(FEATURE_SETS[name])

    if compare:
        chosen_mae = metrics["model"]["mae"]
        print(f"\nBest holdout MAE {best_mae:.3f}s. Keeping '{name}' / {mode} target "
              f"at {chosen_mae:.3f}s"
              + (f", simpler and within {PARSIMONY_TOLERANCE_SECONDS}s of the best."
                 if chosen_mae > best_mae else "."))

    artifact = {
        "artifact_version": ARTIFACT_VERSION,
        "model": model,
        "features": features,
        "categorical": [c for c in features if c in ALL_CATEGORICAL],
        "categories": categories,
        "target": TARGET,
        "targetMode": mode,
        "featureSet": name,
        "metrics": metrics,
        "comparison": (
            {f"{n} / {m}": met["model"] for n, m, _, met, _ in results} if compare else None
        ),
        "feature_importance": {
            k: round(float(v), 4) for k, v in zip(features, model.feature_importances_)
        },
        "training_rows": int(len(train_df)),
        "training_races": int(train_df["session_key"].nunique()),
        "validation_races": int(validation_df["session_key"].nunique()),
        "holdout_races": int(holdout_df["session_key"].nunique()),
        "years": [int(frame["year"].min()), int(frame["year"].max())],
        "circuits": categories.get("circuit", []),
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifact, out_path)

    # The booster on its own, in XGBoost's own version-portable format. joblib
    # is a pickle underneath, so it needs matching library versions to reload;
    # this copy does not, and is the one to hand to anything that is not this
    # Python environment.
    model.get_booster().save_model(str(out_path.with_suffix(".ubj")))

    scores = metrics["model"]
    print(f"\nHoldout MAE   {scores['mae']:.3f}s   RMSE {scores['rmse']:.3f}s   R2 {scores['r2']:.3f}")
    print(f"Baselines on the same holdout:")
    print(f"  this driver's median lap at this circuit  "
          f"{metrics['baseline_driver_circuit_median']['mae']:.3f}s")
    print(f"  this race's median clean lap              "
          f"{metrics['baseline_race_median_lap']['mae']:.3f}s")
    print(f"The one this model has to beat is '{metrics['headline_baseline']}': "
          f"model is {metrics['mae_improvement_seconds']:+.3f}s better")
    if not metrics["beats_baseline"]:
        print("WARNING: the model does not beat the naive baseline. Report that honestly.")
    print(f"Saved -> {out_path}")
    print(f"        {out_path.with_suffix('.ubj')}")
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the OpenTyreF1 lap-time model.")
    parser.add_argument("--min-year", type=int, default=None,
                        help="Only train on races from this season onward.")
    parser.add_argument("--features", choices=sorted(FEATURE_SETS), default=DEFAULT_FEATURE_SET,
                        help="Which feature set to fit.")
    parser.add_argument("--target", choices=("absolute", "relative"), default="absolute",
                        help="Predict the lap time, or its offset from the race's median clean lap.")
    parser.add_argument("--compare", action="store_true",
                        help="Fit every feature set and target mode, keep the best on holdout MAE.")
    parser.add_argument("--out", type=Path, default=ARTIFACT_PATH,
                        help="Where to write the model artifact.")
    parser.add_argument("--metrics-json", type=Path, default=None,
                        help="Also write the scores to this path, for the report.")
    args = parser.parse_args()

    artifact = train(
        min_year=args.min_year, feature_set=args.features, target_mode=args.target,
        compare=args.compare, out_path=args.out,
    )

    if args.metrics_json:
        args.metrics_json.parent.mkdir(parents=True, exist_ok=True)
        args.metrics_json.write_text(json.dumps({
            k: artifact[k] for k in (
                "featureSet", "targetMode", "features", "metrics", "comparison",
                "feature_importance", "training_rows", "training_races",
                "validation_races", "holdout_races", "years", "trained_at",
            )
        }, indent=2), encoding="utf-8")
        print(f"Metrics -> {args.metrics_json}")


if __name__ == "__main__":
    main()
