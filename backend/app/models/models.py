from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base

class Season(Base):
    __tablename__ = "seasons"

    year = Column(Integer, primary_key=True, index=True)
    url = Column(String, nullable=True)

    races = relationship("Race", back_populates="season")

class Driver(Base):
    __tablename__ = "drivers"

    driver_id = Column(String, primary_key=True, index=True)
    permanent_number = Column(String, nullable=True)
    code = Column(String, nullable=True)
    given_name = Column(String, nullable=False)
    family_name = Column(String, nullable=False)
    date_of_birth = Column(String, nullable=True)
    nationality = Column(String, nullable=True)

    results = relationship("Result", back_populates="driver")
    laps = relationship("SessionLap", back_populates="driver")
    standings = relationship("Standing", back_populates="driver")

class Constructor(Base):
    __tablename__ = "constructors"

    constructor_id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    nationality = Column(String, nullable=True)

    results = relationship("Result", back_populates="constructor")

class Race(Base):
    __tablename__ = "races"

    race_id = Column(String, primary_key=True, index=True)
    season_year = Column(Integer, ForeignKey("seasons.year"), nullable=False)
    round = Column(Integer, nullable=False)
    race_name = Column(String, nullable=False)
    circuit_name = Column(String, nullable=True)
    date = Column(String, nullable=True)

    # Populated by ingest_schedule() from /{year}.json, which (unlike
    # /{year}/results.json) also returns races that haven't happened yet.
    # Added via ensure_columns, not create_all — see database.py.
    country = Column(String, nullable=True)
    locality = Column(String, nullable=True)
    race_time = Column(String, nullable=True)
    lat = Column(Float, nullable=True)
    lng = Column(Float, nullable=True)
    schedule_json = Column(String, nullable=True)

    season = relationship("Season", back_populates="races")
    results = relationship("Result", back_populates="race")
    laps = relationship("SessionLap", back_populates="race")

class Result(Base):
    __tablename__ = "results"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    race_id = Column(String, ForeignKey("races.race_id"), nullable=False)
    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=False)
    constructor_id = Column(String, ForeignKey("constructors.constructor_id"), nullable=False)
    number = Column(Integer, nullable=True)
    position = Column(Integer, nullable=True)
    points = Column(Float, nullable=True)
    grid = Column(Integer, nullable=True)
    laps = Column(Integer, nullable=True)
    status = Column(String, nullable=True)
    qualifying_position = Column(Integer, nullable=True)

    race = relationship("Race", back_populates="results")
    driver = relationship("Driver", back_populates="results")
    constructor = relationship("Constructor", back_populates="results")

class Standing(Base):
    """End-of-season driver championship standing, one row per driver per season."""
    __tablename__ = "standings"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    season_year = Column(Integer, ForeignKey("seasons.year"), nullable=False, index=True)
    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=False, index=True)
    constructor_id = Column(String, ForeignKey("constructors.constructor_id"), nullable=True)
    position = Column(Integer, nullable=True)
    points = Column(Float, nullable=True)
    wins = Column(Integer, nullable=True)

    driver = relationship("Driver", back_populates="standings")
    constructor = relationship("Constructor")
    season = relationship("Season")

class SessionLap(Base):
    __tablename__ = "session_laps"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    race_id = Column(String, ForeignKey("races.race_id"), nullable=False, index=True)
    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=False, index=True)
    session_key = Column(Integer, ForeignKey("sessions.session_key"), nullable=True, index=True)
    lap_number = Column(Integer, nullable=False)
    lap_time_seconds = Column(Float, nullable=True)
    tyre_compound = Column(String, nullable=True)
    stint = Column(Integer, nullable=True)

    # Added for the replay engine: without `position` a leaderboard frame
    # cannot be represented at all. Gap/tyre_life come from joining OpenF1's
    # timestamp-based intervals/stints onto each lap's start time.
    position = Column(Integer, nullable=True)
    gap_to_leader_seconds = Column(Float, nullable=True)
    tyre_life = Column(Integer, nullable=True)
    is_pit_out_lap = Column(Boolean, nullable=True)
    # Wall-clock start of the lap. Needed to slice OpenF1's timestamp-indexed
    # car_data/location feeds down to a single lap for the telemetry views.
    date_start = Column(String, nullable=True)
    sector_1_seconds = Column(Float, nullable=True)
    sector_2_seconds = Column(Float, nullable=True)
    sector_3_seconds = Column(Float, nullable=True)
    speed_trap_kph = Column(Float, nullable=True)

    race = relationship("Race", back_populates="laps")
    driver = relationship("Driver", back_populates="laps")
    session = relationship("Session", back_populates="laps")


class Session(Base):
    """One OpenF1 session (Race, Qualifying, Sprint...) linked to a Jolpica race."""
    __tablename__ = "sessions"

    session_key = Column(Integer, primary_key=True, index=True)
    race_id = Column(String, ForeignKey("races.race_id"), nullable=True, index=True)
    meeting_key = Column(Integer, nullable=True)
    year = Column(Integer, nullable=False, index=True)
    session_name = Column(String, nullable=True)
    session_type = Column(String, nullable=True)
    circuit_short_name = Column(String, nullable=True)
    location = Column(String, nullable=True)
    country_name = Column(String, nullable=True)
    date_start = Column(String, nullable=True)
    date_end = Column(String, nullable=True)

    race = relationship("Race")
    laps = relationship("SessionLap", back_populates="session")
    entries = relationship("SessionDriver", back_populates="session")


class SessionDriver(Base):
    """Driver number -> driver mapping for one session.

    Numbers get reassigned between seasons, so this cannot be a global map.
    Also carries the real team colour and headshot OpenF1 publishes.
    """
    __tablename__ = "session_drivers"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    session_key = Column(Integer, ForeignKey("sessions.session_key"), nullable=False, index=True)
    driver_number = Column(Integer, nullable=False, index=True)
    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)
    full_name = Column(String, nullable=True)
    name_acronym = Column(String, nullable=True)
    team_name = Column(String, nullable=True)
    team_colour = Column(String, nullable=True)
    headshot_url = Column(String, nullable=True)

    session = relationship("Session", back_populates="entries")
    driver = relationship("Driver")


class SessionStint(Base):
    __tablename__ = "session_stints"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    session_key = Column(Integer, ForeignKey("sessions.session_key"), nullable=False, index=True)
    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)
    driver_number = Column(Integer, nullable=True)
    stint_number = Column(Integer, nullable=True)
    compound = Column(String, nullable=True)
    lap_start = Column(Integer, nullable=True)
    lap_end = Column(Integer, nullable=True)
    tyre_age_at_start = Column(Integer, nullable=True)


class PitStop(Base):
    __tablename__ = "pit_stops"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    session_key = Column(Integer, ForeignKey("sessions.session_key"), nullable=False, index=True)
    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)
    driver_number = Column(Integer, nullable=True)
    lap_number = Column(Integer, nullable=True)
    pit_duration = Column(Float, nullable=True)
    lane_duration = Column(Float, nullable=True)
    date = Column(String, nullable=True)


class RaceControlMessage(Base):
    __tablename__ = "race_control_messages"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    session_key = Column(Integer, ForeignKey("sessions.session_key"), nullable=False, index=True)
    date = Column(String, nullable=True)
    lap_number = Column(Integer, nullable=True)
    category = Column(String, nullable=True)
    flag = Column(String, nullable=True)
    scope = Column(String, nullable=True)
    message = Column(String, nullable=True)
    driver_number = Column(Integer, nullable=True)


class SessionWeather(Base):
    __tablename__ = "session_weather"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    session_key = Column(Integer, ForeignKey("sessions.session_key"), nullable=False, index=True)
    date = Column(String, nullable=True)
    air_temperature = Column(Float, nullable=True)
    track_temperature = Column(Float, nullable=True)
    humidity = Column(Float, nullable=True)
    pressure = Column(Float, nullable=True)
    rainfall = Column(Integer, nullable=True)
    wind_speed = Column(Float, nullable=True)
    wind_direction = Column(Integer, nullable=True)


class SessionResult(Base):
    """Final classification for a session, straight from OpenF1."""
    __tablename__ = "session_results"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    session_key = Column(Integer, ForeignKey("sessions.session_key"), nullable=False, index=True)
    driver_id = Column(String, ForeignKey("drivers.driver_id"), nullable=True, index=True)
    driver_number = Column(Integer, nullable=True)
    position = Column(Integer, nullable=True)
    number_of_laps = Column(Integer, nullable=True)
    points = Column(Float, nullable=True)
    gap_to_leader = Column(String, nullable=True)
    duration_seconds = Column(Float, nullable=True)
    dnf = Column(Boolean, nullable=True)
    dns = Column(Boolean, nullable=True)
    dsq = Column(Boolean, nullable=True)


class Overtake(Base):
    __tablename__ = "overtakes"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    session_key = Column(Integer, ForeignKey("sessions.session_key"), nullable=False, index=True)
    date = Column(String, nullable=True)
    position = Column(Integer, nullable=True)
    overtaking_driver_number = Column(Integer, nullable=True)
    overtaken_driver_number = Column(Integer, nullable=True)
