from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base
from app.config import DATABASE_URL

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_columns(table: str, columns: dict[str, str]) -> None:
    """Add any of `columns` ({name: SQL type}) missing from `table`.

    `Base.metadata.create_all` only creates tables that don't exist yet — it
    never ALTERs an existing one. This is the escape hatch for adding a column
    to a table that already has data (e.g. new fields on `races`), without
    Alembic and without losing the existing rows. Safe to call every startup:
    it only issues ALTER TABLE for columns that are actually missing.
    """
    with engine.connect() as conn:
        existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
        for name, sql_type in columns.items():
            if name not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))
        conn.commit()
