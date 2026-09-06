import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./opentyref1.db")
# Fix postgres:// URI scheme if passed from Heroku/Supabase for SQLAlchemy compatibility
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", 8000))

# Guards POST /api/admin/sync so it can't be triggered by anyone who finds
# the URL. Unset by default — the endpoint 503s until this is configured.
ADMIN_SYNC_TOKEN = os.getenv("ADMIN_SYNC_TOKEN")
