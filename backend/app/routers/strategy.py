"""Strategy simulation endpoints (Phase 3).

The heavy lifting lives in `services/simulation.py`; this file is request
validation and routing only.
"""

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as OrmSession

from app.database import get_db
from app.ml import predictor
from app.services import simulation

router = APIRouter(prefix="/api/strategy", tags=["strategy"])


class StintIn(BaseModel):
    compound: str = Field(..., description="SOFT / MEDIUM / HARD / INTERMEDIATE / WET")
    laps: int = Field(..., ge=1, le=90)
    tyreAgeAtStart: int = Field(0, ge=0, le=40,
                                description="Laps already on the set, for a used tyre.")


class SimulationIn(BaseModel):
    raceId: str
    driverId: str
    stints: list[StintIn] = Field(..., min_length=1, max_length=simulation.MAX_STINTS)
    pitLossSeconds: float | None = Field(
        None, ge=simulation.PIT_LOSS_MIN, le=simulation.PIT_LOSS_MAX,
        description="Override the measured pit-lane loss. Omit to use the real one.",
    )


@router.get("/model")
def model_status():
    """Whether a trained artifact is loaded, and how well it scored.

    The app shows this on the strategy screen so a prediction is never
    presented without saying where it came from.
    """
    return predictor.status()


@router.get("/options/{race_id}")
def options(race_id: str, db: OrmSession = Depends(get_db)):
    """Drivers, race distance, compounds and measured pit loss for one race."""
    return simulation.strategy_options(db, race_id)


@router.post("/simulate")
def simulate(body: SimulationIn, db: OrmSession = Depends(get_db)):
    """Run a hypothetical stint plan and play it back against the real race."""
    return simulation.simulate(
        db,
        race_id=body.raceId,
        driver_id=body.driverId,
        stints=[s.model_dump() for s in body.stints],
        pit_loss_override=body.pitLossSeconds,
    )


@router.post("/model/reload")
def reload_model(confirm: bool = Query(False, description="Must be true to act.")):
    """Drop the cached artifact so a fresh retrain is picked up without a restart."""
    if not confirm:
        return {"reloaded": False, "hint": "Call with ?confirm=true"}
    predictor.reload()
    return {"reloaded": True, "status": predictor.status()}
