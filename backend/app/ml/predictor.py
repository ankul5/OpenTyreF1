"""Read-only load path for the trained lap-time model.

Kept separate from `train_tyre_model.py` so importing the API never pulls in
the training code, and so a missing artifact degrades to "model unavailable"
rather than a 500. The simulator has an empirical fallback for exactly that
case, so the app still works on a fresh clone before anyone has run training.
"""

from __future__ import annotations

import threading
from pathlib import Path

import pandas as pd

from app.ml.dataset import design_matrix

ARTIFACT_PATH = Path(__file__).resolve().parent / "artifacts" / "tyre_model.joblib"

_lock = threading.Lock()
_artifact: dict | None = None
_load_error: str | None = None
_loaded = False


def _load() -> None:
    """Load the artifact once, remembering failure so we don't retry per request."""
    global _artifact, _load_error, _loaded
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        _loaded = True
        if not ARTIFACT_PATH.exists():
            _load_error = (
                "No trained model. Run `python -m app.ml.train_tyre_model` in backend/."
            )
            return
        try:
            import joblib
            _artifact = joblib.load(ARTIFACT_PATH)
        except Exception as exc:  # noqa: BLE001 - surfaced to the client as status text
            _load_error = f"Model artifact could not be loaded: {exc}"


def reload() -> None:
    """Drop the cached artifact so the next call picks up a fresh retrain."""
    global _artifact, _load_error, _loaded
    with _lock:
        _artifact, _load_error, _loaded = None, None, False


def available() -> bool:
    _load()
    return _artifact is not None


def status() -> dict:
    """Everything the client needs to say honestly where a number came from."""
    _load()
    if _artifact is None:
        return {"available": False, "error": _load_error}
    return {
        "available": True,
        "trainedAt": _artifact.get("trained_at"),
        "trainingRows": _artifact.get("training_rows"),
        "trainingRaces": _artifact.get("training_races"),
        "validationRaces": _artifact.get("validation_races"),
        "holdoutRaces": _artifact.get("holdout_races"),
        "years": _artifact.get("years"),
        "featureSet": _artifact.get("featureSet"),
        "targetMode": _artifact.get("targetMode"),
        "features": _artifact.get("features"),
        "metrics": _artifact.get("metrics"),
        "featureImportance": _artifact.get("feature_importance"),
        "circuitsCovered": len(_artifact.get("circuits") or []),
    }


def holdout_mae() -> float | None:
    """Holdout mean absolute error in seconds, for confidence reporting."""
    _load()
    if _artifact is None:
        return None
    return (_artifact.get("metrics") or {}).get("model", {}).get("mae")


def knows_circuit(circuit: str) -> bool:
    _load()
    if _artifact is None:
        return False
    return circuit in (_artifact.get("categories") or {}).get("circuit", [])


def knows_driver(driver_id: str) -> bool:
    _load()
    if _artifact is None:
        return False
    return driver_id in (_artifact.get("categories") or {}).get("driver_id", [])


def needs_reference_pace() -> bool:
    """True when the model predicts an offset and the caller must supply the
    race's median clean lap as `session_median`."""
    _load()
    return bool(_artifact and _artifact.get("targetMode") == "relative")


def predict(rows: list[dict]) -> list[float]:
    """Predict lap times for feature dicts.

    Callers may pass a superset of keys: the artifact's own feature list
    decides which columns the model sees, so changing the trained feature set
    needs no matching change at the call site.

    A model trained with `targetMode == "relative"` predicts the offset from
    the race's own median clean lap, so each row must also carry
    `session_median` and it is added back here. Keeping that inside the
    predictor means callers never have to know which kind of model is loaded.

    Raises RuntimeError when no model is loaded; callers that want a graceful
    degrade should check `available()` first.
    """
    _load()
    if _artifact is None:
        raise RuntimeError(_load_error or "Model unavailable")
    if not rows:
        return []

    frame = pd.DataFrame(rows)
    design = design_matrix(frame, _artifact["features"], _artifact["categories"])
    predicted = _artifact["model"].predict(design)

    if _artifact.get("targetMode") == "relative":
        if "session_median" not in frame.columns:
            raise RuntimeError(
                "This model predicts an offset from the race's median clean lap, "
                "so every row needs a `session_median`."
            )
        predicted = predicted + pd.to_numeric(frame["session_median"], errors="coerce").to_numpy()

    return [float(v) for v in predicted]
