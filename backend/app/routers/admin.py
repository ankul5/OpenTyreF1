import threading

from fastapi import APIRouter, Header, HTTPException

from app.config import ADMIN_SYNC_TOKEN
from app.services import session_sync

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/sync")
def sync_status():
    """Last background-sync outcome, for checking it's actually running."""
    return {
        "lastRunAt": session_sync.last_run_at.isoformat() if session_sync.last_run_at else None,
        "lastRunError": session_sync.last_run_error,
    }


@router.post("/sync")
def trigger_sync(x_admin_token: str | None = Header(default=None)):
    """Force an immediate sync pass without waiting for the background loop
    or a redeploy. Runs in a thread so the request returns right away rather
    than blocking on however long ingestion takes.
    """
    if not ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=503, detail="ADMIN_SYNC_TOKEN is not configured on the server")
    if x_admin_token != ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=403, detail="Missing or invalid X-Admin-Token header")
    threading.Thread(target=session_sync.run_once, daemon=True).start()
    return {"status": "sync started"}
