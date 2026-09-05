"""Assistant endpoint (Phase 4).

Thin by design: `services/explain.py` does the retrieval and the wording, and
returns the supporting numbers alongside the prose so the app can show its
working. A hosted LLM, if one is ever added, slots in as a rephrasing step
over the same `facts` payload without touching this file.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as OrmSession

from app.database import get_db
from app.services import explain

router = APIRouter(prefix="/api/ai", tags=["assistant"])


class QueryContext(BaseModel):
    """What the app already has on screen, so the question does not have to
    repeat it. Everything is optional: a question that needs context it was
    not given gets an honest "I need a race first" rather than a guess."""

    raceId: str | None = None
    driverId: str | None = None
    stints: list[dict] | None = Field(
        None, description="The stint plan currently on the Strategy tab, so it can be explained."
    )
    pitLossSeconds: float | None = None


class QueryIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=500)
    context: QueryContext = Field(default_factory=QueryContext)


@router.get("/capabilities")
def capabilities():
    """What the assistant can actually answer, for the app's empty state.

    Kept server-side so the quick prompts and the "I can't answer that" reply
    can never drift apart from what is really implemented.
    """
    return {
        "capabilities": explain.CAPABILITIES,
        "quickPrompts": [
            {"label": "Explain my strategy", "question": "Explain why my strategy loses time",
             "needs": "stints"},
            {"label": "Best strategy here", "question": "What was the best tyre strategy here?",
             "needs": "race"},
            {"label": "Who won?", "question": "Who won this race?", "needs": "race"},
            {"label": "Tyre degradation", "question": "Which tyre degraded fastest?", "needs": "race"},
            {"label": "Fastest lap", "question": "Who set the fastest lap?", "needs": "race"},
            {"label": "Pit stops", "question": "Who had the fastest pit stop?", "needs": "race"},
            {"label": "How it works", "question": "How does the model work and how accurate is it?",
             "needs": None},
        ],
    }


@router.post("/query")
def query(body: QueryIn, db: OrmSession = Depends(get_db)):
    return explain.answer(db, body.question, body.context.model_dump(exclude_none=True))
