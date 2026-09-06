from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import engine, Base, ensure_columns
from app.routers.health import router as health_router
from app.routers.drivers import router as drivers_router
from app.routers.sessions import router as sessions_router
from app.routers.races import router as races_router
from app.routers.telemetry import router as telemetry_router
from app.routers.strategy import router as strategy_router
from app.routers.ai import router as ai_router
from app.routers.admin import router as admin_router
from app.services.session_sync import start_background_sync
from app.config import HOST, PORT

# Create database tables automatically if missing
Base.metadata.create_all(bind=engine)

# create_all only creates missing tables — it never ALTERs an existing one.
# Columns added to a model after its table already has data need this instead.
ensure_columns("races", {
    "country": "TEXT",
    "locality": "TEXT",
    "race_time": "TEXT",
    "lat": "REAL",
    "lng": "REAL",
    "schedule_json": "TEXT",
})

app = FastAPI(
    title="OpenTyreF1 Backend API",
    description="FastAPI Backend for OpenTyreF1 F1 Strategy & Telemetry Application",
    version="1.0.0"
)

# Configure CORS for Expo / Expo Go frontend accessibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health_router)
app.include_router(drivers_router)
app.include_router(sessions_router)
app.include_router(races_router)
app.include_router(telemetry_router)
app.include_router(strategy_router)
app.include_router(ai_router)
app.include_router(admin_router)

# Keeps the dataset current without a manual CLI run or redeploy — see
# app/services/session_sync.py. Runs once immediately in a daemon thread,
# then on its own schedule; never blocks the app from serving requests.
start_background_sync()

@app.get("/")
def read_root():
    return {
        "message": "OpenTyreF1 Backend Engine Online",
        "docs": "/docs",
        "health": "/api/health"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=True)
