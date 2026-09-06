"""Pitwall decision modules — the strategy calls a race engineer actually
makes mid-race, each framed the only honest way this app can frame them:
"at lap N of this real race, what was the right call, and what actually
happened?" There is no live feed and no weather forecast here, so every
module answers against a real, already-run race rather than inventing one.

Every module returns the same envelope (`_envelope`): a verdict, a
confidence, an expected gain, reasoning rendered from real numbers, a sample
size that is *always* shown (a 13-race red-flag sample must look like 13,
not a chart that quietly assumes a thousand), a source tag, and — since the
outcome of the moment is already known — what actually happened.

A few historical aggregates (safety-car outcomes, overtake pass rates, the
wet/dry crossover, hazard rates for the Monte Carlo) are expensive to
recompute per request but change only when the shipped database changes, so
they are lazily cached at module level the same way `ml/predictor.py`
caches its artifact.
"""

from __future__ import annotations

import random
from collections import Counter, defaultdict
from statistics import median

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session as OrmSession

from app.ml import predictor
from app.ml.dataset import WeatherTrace
from app.models.models import (
    Overtake, PitStop, Race, Session, SessionLap, SessionResult, SessionStint,
)
from app.services.analysis import dirty_air_loss, gaps_by_lap
from app.services.lap_filters import (
    clean_laps, flag_events, median_clean_lap, neutralisation_events,
)
from app.services.presentation import TEAM_FALLBACK, driver_meta_by_id
from app.services.simulation import _real_cumulative, measured_pit_loss, resolve_session

# ---------------------------------------------------------------------------
# Shared envelope
# ---------------------------------------------------------------------------

def _envelope(
    *, verdict: str, confidence: float | None, expectedGain: float | None,
    reasoning: list[str], facts: list[dict], sampleSize: int, source: str,
    actual: dict | None = None, extra: dict | None = None,
) -> dict:
    out = {
        "verdict": verdict,
        "confidence": round(confidence, 3) if confidence is not None else 0.0,
        "expectedGain": round(expectedGain, 3) if expectedGain is not None else None,
        "reasoning": reasoning,
        "facts": facts,
        "sampleSize": sampleSize,
        "source": source,
        "actual": actual or {},
    }
    if extra:
        out.update(extra)
    return out


def _race_sessions(db: OrmSession) -> list[int]:
    return [sk for (sk,) in db.query(Session.session_key).filter(Session.session_name == "Race").all()]


# ---------------------------------------------------------------------------
# Shared race snapshot (the lap-scrubber backend)
# ---------------------------------------------------------------------------

def race_state(db: OrmSession, race_id: str, lap: int | None = None) -> dict:
    """Every driver's position/compound/tyre-age/gaps as of a given lap, plus
    the event timeline and as-of weather. Powers the app's lap scrubber."""
    session = resolve_session(db, race_id)
    sk = session.session_key
    meta = driver_meta_by_id(db, sk)
    race = db.query(Race).filter(Race.race_id == race_id).first()

    max_lap = db.query(func.max(SessionLap.lap_number)).filter(SessionLap.session_key == sk).scalar() or 0
    if lap is None:
        lap = max_lap
    lap = max(1, min(int(lap), max_lap)) if max_lap else 1

    rows = (
        db.query(SessionLap)
        .filter(SessionLap.session_key == sk, SessionLap.lap_number <= lap)
        .order_by(SessionLap.lap_number)
        .all()
    )
    latest: dict[str, SessionLap] = {}
    for r in rows:
        latest[r.driver_id] = r  # rows are lap-ascending, so the last write per driver is their most recent

    pit_counts: dict[str, int] = defaultdict(int)
    for (did,) in (
        db.query(PitStop.driver_id)
        .filter(PitStop.session_key == sk, PitStop.lap_number.isnot(None), PitStop.lap_number <= lap)
        .all()
    ):
        pit_counts[did] += 1

    gaps = gaps_by_lap(db, sk)

    drivers = []
    for did, row in latest.items():
        m = meta.get(did, {})
        g = gaps.get((did, row.lap_number), {})
        drivers.append({
            "driverId": did,
            "code": m.get("code"), "name": m.get("name"), "team": m.get("team"),
            "teamColour": m.get("teamColour", TEAM_FALLBACK),
            "position": row.position, "compound": row.tyre_compound, "tyreLife": row.tyre_life,
            "stint": row.stint, "pitStops": pit_counts.get(did, 0),
            "gapAhead": g.get("ahead"), "gapBehind": g.get("behind"),
            "asOfLap": row.lap_number,
        })
    drivers.sort(key=lambda d: (d["position"] is None, d["position"] or 99))

    events = [
        {**e, "category": "neutralisation"} for e in neutralisation_events(db, sk)
    ] + [
        {**e, "category": "flag"} for e in flag_events(db, sk) if e["type"] in ("YELLOW", "DOUBLE_YELLOW", "RED")
    ]

    lap_starts = [r.date_start for r in rows if r.lap_number == lap and r.date_start]
    when = min(lap_starts) if lap_starts else None
    track_temp, air_temp, is_wet = WeatherTrace(db, sk).at(when)

    return {
        "raceId": race_id, "raceName": race.race_name if race else None,
        "sessionKey": sk, "raceLaps": max_lap, "lap": lap,
        "drivers": drivers,
        "events": sorted(events, key=lambda e: e["deployedLap"]),
        "weather": {
            "trackTemp": track_temp, "airTemp": air_temp,
            "isWet": bool(is_wet) if is_wet is not None else None,
        },
    }


def _driver_or_404(meta: dict, driver_id: str) -> None:
    if driver_id not in meta:
        raise HTTPException(status_code=404, detail=f"Driver '{driver_id}' did not race here.")


# ---------------------------------------------------------------------------
# Safety Car / VSC
# ---------------------------------------------------------------------------

_SC_OUTCOME_CACHE: dict | None = None


def _sc_outcome_stats(db: OrmSession) -> dict:
    """Across every ingested race, the net position change from the lap a
    SC/VSC was deployed to three laps after it cleared, split by whether the
    driver pitted during the window. ~1,300 real driver-decisions."""
    global _SC_OUTCOME_CACHE
    if _SC_OUTCOME_CACHE is not None:
        return _SC_OUTCOME_CACHE

    pitted_gains: list[int] = []
    stayed_gains: list[int] = []
    sc_pit_durations: list[float] = []
    green_pit_durations: list[float] = []
    event_count = 0

    for sk in _race_sessions(db):
        events = [e for e in neutralisation_events(db, sk) if e["type"] in ("SC", "VSC")]
        if not events:
            continue
        event_count += len(events)

        pos: dict[str, dict[int, int]] = defaultdict(dict)
        for did, lap_no, position in (
            db.query(SessionLap.driver_id, SessionLap.lap_number, SessionLap.position)
            .filter(SessionLap.session_key == sk, SessionLap.position.isnot(None))
            .all()
        ):
            pos[did][lap_no] = position

        pit_laps: dict[str, set[int]] = defaultdict(set)
        pit_durations: dict[tuple[str, int], float] = {}
        for did, lap_no, dur in (
            db.query(PitStop.driver_id, PitStop.lap_number, PitStop.pit_duration)
            .filter(PitStop.session_key == sk, PitStop.lap_number.isnot(None))
            .all()
        ):
            pit_laps[did].add(lap_no)
            if dur is not None:
                pit_durations[(did, lap_no)] = dur

        windows = [(e["deployedLap"], e["clearedLap"] or e["deployedLap"]) for e in events]

        for e in events:
            start, end = e["deployedLap"], e["clearedLap"] or e["deployedLap"]
            target = end + 3
            for did, laps_map in pos.items():
                if start not in laps_map:
                    continue
                before = laps_map[start]
                candidates = [l for l in laps_map if end <= l <= target]
                if not candidates:
                    continue
                after = laps_map[max(candidates)]
                gain = before - after
                pitted_in_window = any(start <= pl <= end for pl in pit_laps.get(did, ()))
                (pitted_gains if pitted_in_window else stayed_gains).append(gain)
                for pl in pit_laps.get(did, ()):
                    if start <= pl <= end:
                        d = pit_durations.get((did, pl))
                        if d is not None and 5 <= d <= 60:
                            sc_pit_durations.append(d)

        for did, lap_no, dur in (
            db.query(PitStop.driver_id, PitStop.lap_number, PitStop.pit_duration)
            .filter(PitStop.session_key == sk, PitStop.lap_number.isnot(None))
            .all()
        ):
            if dur is None or not (5 <= dur <= 60):
                continue
            if not any(a <= lap_no <= b for a, b in windows):
                green_pit_durations.append(dur)

    _SC_OUTCOME_CACHE = {
        "pittedGains": pitted_gains,
        "stayedGains": stayed_gains,
        "scPitLoss": round(median(sc_pit_durations), 2) if sc_pit_durations else None,
        "greenPitLoss": round(median(green_pit_durations), 2) if green_pit_durations else None,
        "eventCount": event_count,
    }
    return _SC_OUTCOME_CACHE


def safety_car_call(db: OrmSession, race_id: str, driver_id: str, lap: int) -> dict:
    session = resolve_session(db, race_id)
    sk = session.session_key
    meta = driver_meta_by_id(db, sk)
    _driver_or_404(meta, driver_id)

    events = neutralisation_events(db, sk)
    current = next((e for e in events if e["deployedLap"] <= lap <= (e["clearedLap"] or e["deployedLap"])), None)
    upcoming = next((e for e in events if e["deployedLap"] > lap), None)

    stats = _sc_outcome_stats(db)
    pitted, stayed = stats["pittedGains"], stats["stayedGains"]
    pit_gain_med = median(pitted) if pitted else None
    stay_gain_med = median(stayed) if stayed else None
    n = len(pitted) + len(stayed)

    pit_loss, pit_loss_source = measured_pit_loss(db, session)
    sc_pit_loss = stats["scPitLoss"] or round(pit_loss * (14.24 / 21.9), 2)
    green_pit_loss = stats["greenPitLoss"] or pit_loss

    if current:
        if pit_gain_med is not None and stay_gain_med is not None and pit_gain_med != stay_gain_med:
            verdict = "PIT NOW" if pit_gain_med > stay_gain_med else "STAY OUT"
            confidence = min(0.9, 0.4 + n / 1500)
        else:
            verdict = "PIT — LESS TO LOSE UNDER CAUTION"
            confidence = 0.3
    else:
        verdict = "NO ACTIVE NEUTRALISATION"
        confidence = 0.0

    reasoning: list[str] = []
    if current:
        label = "Safety Car" if current["type"] == "SC" else "Virtual Safety Car"
        reasoning.append(f"{label} deployed lap {current['deployedLap']}, active at lap {lap}.")
        reasoning.append(
            f"Pitting under caution costs about {sc_pit_loss:.1f}s here vs {green_pit_loss:.1f}s green-flag "
            f"(pit-loss source: {pit_loss_source})."
        )
        if pit_gain_med is not None and stay_gain_med is not None:
            reasoning.append(
                f"Across {n} historical SC/VSC driver-decisions in this dataset, pitting in the window gained a "
                f"median {pit_gain_med:+.0f} places three laps after the restart, vs {stay_gain_med:+.0f} for "
                f"staying out."
            )
    elif upcoming:
        reasoning.append(f"No SC/VSC active now; the next one in this race starts at lap {upcoming['deployedLap']}.")
    else:
        reasoning.append("No safety car or VSC period runs from this lap to the end of this race.")

    return _envelope(
        verdict=verdict, confidence=confidence,
        expectedGain=(pit_gain_med - stay_gain_med) if (pit_gain_med is not None and stay_gain_med is not None) else None,
        reasoning=reasoning,
        facts=[
            {"label": "SC/VSC pit-lane loss", "value": f"{sc_pit_loss:.1f}s"},
            {"label": "Green-flag pit-lane loss", "value": f"{green_pit_loss:.1f}s"},
            {"label": "Median gain, pitted in window", "value": f"{pit_gain_med:+.0f} pos" if pit_gain_med is not None else "n/a"},
            {"label": "Median gain, stayed out", "value": f"{stay_gain_med:+.0f} pos" if stay_gain_med is not None else "n/a"},
        ],
        sampleSize=n, source="derived",
        actual={"eventActive": current is not None, "eventType": current["type"] if current else None},
    )


# ---------------------------------------------------------------------------
# Red / Yellow flags
# ---------------------------------------------------------------------------

_RED_FLAG_CACHE: int | None = None


def _red_flag_count(db: OrmSession) -> int:
    global _RED_FLAG_CACHE
    if _RED_FLAG_CACHE is None:
        _RED_FLAG_CACHE = sum(
            1 for sk in _race_sessions(db) for e in flag_events(db, sk) if e["type"] == "RED"
        )
    return _RED_FLAG_CACHE


def flags_call(db: OrmSession, race_id: str, driver_id: str, lap: int) -> dict:
    session = resolve_session(db, race_id)
    sk = session.session_key
    meta = driver_meta_by_id(db, sk)
    _driver_or_404(meta, driver_id)

    events = flag_events(db, sk)
    current = next(
        (e for e in events if e["type"] in ("RED", "YELLOW", "DOUBLE_YELLOW")
         and e["deployedLap"] <= lap <= (e["clearedLap"] or e["deployedLap"])),
        None,
    )
    stopped_before = (
        db.query(PitStop)
        .filter(PitStop.session_key == sk, PitStop.driver_id == driver_id,
                PitStop.lap_number.isnot(None), PitStop.lap_number < lap)
        .count() > 0
    )
    red_flag_total = _red_flag_count(db)

    own_clean_median = median_clean_lap([
        l.lap_time_seconds for l in clean_laps(db, sk) if l.driver_id == driver_id
    ]) or None
    this_lap = (
        db.query(SessionLap)
        .filter(SessionLap.session_key == sk, SessionLap.driver_id == driver_id, SessionLap.lap_number == lap)
        .first()
    )
    yellow_cost = None
    if (
        current and current["type"] != "RED" and this_lap and this_lap.lap_time_seconds and own_clean_median
        # A red-flag stoppage counts against whatever lap it falls in, so that
        # lap's raw time can read in the thousands of seconds — a session-clock
        # artefact, not a yellow-flag pace cost. Cap at 3x this driver's own
        # median so a stopped-on-track lap doesn't masquerade as a slow lap.
        and this_lap.lap_time_seconds <= own_clean_median * 3
    ):
        yellow_cost = round(this_lap.lap_time_seconds - own_clean_median, 2)

    if current and current["type"] == "RED":
        verdict = "FREE TYRE CHANGE — TAKE IT" if not stopped_before else "NO STOP NEEDED (already pitted)"
        confidence = 0.7 if red_flag_total >= 10 else 0.4
    elif current:
        verdict = "CAUTION — HOLD PACE, NO OVERTAKING"
        confidence = 0.6
    else:
        verdict = "NO ACTIVE FLAG"
        confidence = 0.0

    reasoning: list[str] = []
    if current and current["type"] == "RED":
        reasoning.append(
            f"Red flag at lap {lap}. Under current rules a tyre change during a red flag is free and counts as "
            "the mandatory stop."
        )
        reasoning.append(
            "Whoever has not yet made their mandatory stop gains the most from this — the gap to cars that "
            "already pitted is deleted."
        )
        reasoning.append(
            f"Sample size: only {red_flag_total} red flags across this dataset's races — treat this as a "
            "small-sample signal, not a forecast."
        )
    elif current:
        scope = f" in {current['scope']}" if current.get("scope") else ""
        reasoning.append(f"{current['type'].replace('_', ' ').title()} flag active{scope} since lap {current['deployedLap']}.")
        if yellow_cost is not None:
            reasoning.append(f"This driver's lap here ran {yellow_cost:+.2f}s against their own clean-lap median.")
    else:
        reasoning.append("No yellow, double-yellow or red flag active at this lap.")

    return _envelope(
        verdict=verdict, confidence=confidence, expectedGain=None,
        reasoning=reasoning,
        facts=[
            {"label": "Already made mandatory stop", "value": "Yes" if stopped_before else "No"},
            {"label": "Red flags in this dataset", "value": str(red_flag_total)},
            {"label": "This lap vs own median", "value": f"{yellow_cost:+.2f}s" if yellow_cost is not None else "n/a"},
        ],
        sampleSize=red_flag_total if (current and current["type"] == "RED") else (1 if current else 0),
        source="derived",
        actual={"flagActive": current is not None, "flagType": current["type"] if current else None},
    )


# ---------------------------------------------------------------------------
# Weather crossover
# ---------------------------------------------------------------------------

_CROSSOVER_CACHE: dict | None = None


def _crossover_base_rates(db: OrmSession) -> dict:
    """Median lap time, as a % of each session's own dry reference pace, for
    slicks / intermediates / wets — across every session with real
    inter-or-wet running. This is the empirical crossover this dataset
    supports; literature puts the slick->inter point near 112% and
    inter->wet near 116-118%."""
    global _CROSSOVER_CACHE
    if _CROSSOVER_CACHE is not None:
        return _CROSSOVER_CACHE

    groups = {"SOFT": "SLICK", "MEDIUM": "SLICK", "HARD": "SLICK", "INTERMEDIATE": "INTERMEDIATE", "WET": "WET"}
    ratios: dict[str, list[float]] = defaultdict(list)
    sessions_used = 0

    for sk in _race_sessions(db):
        rows = (
            db.query(SessionLap.lap_time_seconds, SessionLap.tyre_compound)
            .filter(SessionLap.session_key == sk, SessionLap.lap_time_seconds.isnot(None),
                    SessionLap.tyre_compound.isnot(None))
            .all()
        )
        if not rows:
            continue
        has_wet_running = any((c or "").upper() in ("INTERMEDIATE", "WET") for _, c in rows)
        if not has_wet_running:
            continue
        dry_times = [t for t, c in rows if (c or "").upper() in ("SOFT", "MEDIUM", "HARD")]
        if len(dry_times) < 5:
            continue
        dry_reference = median_clean_lap(dry_times)
        if not dry_reference:
            continue
        sessions_used += 1
        for t, c in rows:
            group = groups.get((c or "").upper())
            if group:
                ratios[group].append(t / dry_reference)

    _CROSSOVER_CACHE = {
        group: {"medianPct": round(median(values) * 100, 1) if values else None, "sampleSize": len(values)}
        for group, values in ratios.items()
    }
    _CROSSOVER_CACHE["sessionsUsed"] = sessions_used
    return _CROSSOVER_CACHE


def weather_call(db: OrmSession, race_id: str, driver_id: str, lap: int) -> dict:
    session = resolve_session(db, race_id)
    sk = session.session_key
    meta = driver_meta_by_id(db, sk)
    _driver_or_404(meta, driver_id)

    row = (
        db.query(SessionLap)
        .filter(SessionLap.session_key == sk, SessionLap.driver_id == driver_id, SessionLap.lap_number == lap)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail=f"No lap {lap} recorded for this driver in this race.")

    track_temp, air_temp, is_wet = WeatherTrace(db, sk).at(row.date_start)
    compound = (row.tyre_compound or "").upper()
    is_currently_wet = bool(is_wet) if is_wet is not None else None

    rates = _crossover_base_rates(db)
    slick, inter, wet = rates.get("SLICK", {}), rates.get("INTERMEDIATE", {}), rates.get("WET", {})

    dry_times = [
        l.lap_time_seconds for l in
        db.query(SessionLap).filter(
            SessionLap.session_key == sk, SessionLap.lap_time_seconds.isnot(None),
            SessionLap.tyre_compound.in_(["SOFT", "MEDIUM", "HARD"]),
        ).all()
    ]
    dry_ref = median_clean_lap(dry_times) if dry_times else None
    current_pct = round(row.lap_time_seconds / dry_ref * 100, 1) if (dry_ref and row.lap_time_seconds) else None

    if compound in ("SOFT", "MEDIUM", "HARD") and is_currently_wet:
        verdict, confidence = "SWITCH TO INTERMEDIATE", 0.7
    elif compound == "INTERMEDIATE" and is_currently_wet is False:
        verdict, confidence = "TRACK DRYING — CONSIDER SLICKS", 0.5
    elif compound == "INTERMEDIATE" and current_pct and wet.get("medianPct") and current_pct >= wet["medianPct"] * 0.95:
        verdict, confidence = "CONSIDER FULL WET", 0.4
    else:
        verdict, confidence = "STAY ON CURRENT COMPOUND", 0.5

    condition = "wet" if is_currently_wet else "dry" if is_currently_wet is False else "unknown"
    reasoning = [
        f"On {compound or 'an unknown compound'}, track reads {condition} at this lap"
        + (f" ({track_temp:.0f}°C track temp)" if track_temp is not None else "") + ".",
    ]
    if slick.get("medianPct") is not None:
        reasoning.append(
            f"Empirical crossover from {rates.get('sessionsUsed', 0)} wet-affected sessions in this dataset: "
            f"slicks run {slick.get('medianPct', 0):.0f}% of dry pace, intermediates "
            f"{inter.get('medianPct', 0):.0f}%, full wets {wet.get('medianPct', 0):.0f}% "
            "(published figures put the slick→inter crossover near 112%, inter→wet near 116-118%)."
        )
    if current_pct is not None:
        reasoning.append(f"This driver's current lap runs at {current_pct:.0f}% of this race's own dry reference pace.")
    reasoning.append(
        "Rainfall in this dataset is a binary flag (raining / not), not an intensity or forecast — this reads "
        "where the crossover sits right now, it cannot predict when rain will start or stop."
    )

    return _envelope(
        verdict=verdict, confidence=confidence, expectedGain=None,
        reasoning=reasoning,
        facts=[
            {"label": "Current compound", "value": compound or "unknown"},
            {"label": "Track condition", "value": condition},
            {"label": "Current lap vs dry reference", "value": f"{current_pct:.0f}%" if current_pct is not None else "n/a"},
            {"label": "Empirical slick / inter / wet %", "value": (
                f"{slick.get('medianPct', 'n/a')} / {inter.get('medianPct', 'n/a')} / {wet.get('medianPct', 'n/a')}"
            )},
        ],
        sampleSize=rates.get("sessionsUsed", 0), source="derived",
        actual={"isWet": is_currently_wet, "compound": compound},
    )


# ---------------------------------------------------------------------------
# Overtake / Defensive
# ---------------------------------------------------------------------------

_BUCKETS = [("<0.5", 0.0, 0.5), ("0.5-1.0", 0.5, 1.0), ("1.0-1.5", 1.0, 1.5),
            ("1.5-2.5", 1.5, 2.5), (">2.5", 2.5, float("inf"))]


def _bucket_for(gap: float) -> str | None:
    for label, lo, hi in _BUCKETS:
        if lo <= gap < hi:
            return label
    return None


def _swap_attempts(db: OrmSession, session_key: int) -> list[dict]:
    """For every lap with a known gap-ahead, did the following car actually
    pass the car ahead by the next lap? Read from `session_laps.position`
    directly (a genuine track-position swap between the two specific cars),
    which is more precise than joining `overtakes` by timestamp."""
    pos_by_lap: dict[int, dict[str, int]] = defaultdict(dict)
    for did, lap_no, position in (
        db.query(SessionLap.driver_id, SessionLap.lap_number, SessionLap.position)
        .filter(SessionLap.session_key == session_key, SessionLap.position.isnot(None))
        .all()
    ):
        pos_by_lap[lap_no][did] = position

    gaps = gaps_by_lap(db, session_key)
    attempts: list[dict] = []
    for lap_no in sorted(pos_by_lap):
        if lap_no + 1 not in pos_by_lap:
            continue
        order = sorted(pos_by_lap[lap_no].items(), key=lambda kv: kv[1])
        next_positions = pos_by_lap[lap_no + 1]
        for i in range(1, len(order)):
            behind_id, _ = order[i]
            ahead_id, _ = order[i - 1]
            gap = gaps.get((behind_id, lap_no), {}).get("ahead")
            if gap is None or behind_id not in next_positions or ahead_id not in next_positions:
                continue
            attempts.append({
                "lap": lap_no, "behind": behind_id, "ahead": ahead_id, "gap": gap,
                "success": next_positions[behind_id] < next_positions[ahead_id],
            })
    return attempts


_OVERTAKE_CACHE: dict | None = None


def _overtake_base_rates(db: OrmSession) -> dict:
    """Historical pass rate per gap bucket, from every ingested race
    (22,383 recorded overtakes' worth of track-position swaps)."""
    global _OVERTAKE_CACHE
    if _OVERTAKE_CACHE is not None:
        return _OVERTAKE_CACHE

    counts = {label: {"attempts": 0, "passes": 0} for label, _, _ in _BUCKETS}
    for sk in _race_sessions(db):
        for a in _swap_attempts(db, sk):
            label = _bucket_for(a["gap"])
            if not label:
                continue
            counts[label]["attempts"] += 1
            if a["success"]:
                counts[label]["passes"] += 1

    _OVERTAKE_CACHE = {
        label: {
            "attempts": c["attempts"], "passes": c["passes"],
            "rate": round(c["passes"] / c["attempts"], 4) if c["attempts"] else None,
        }
        for label, c in counts.items()
    }
    return _OVERTAKE_CACHE


def overtake_call(db: OrmSession, race_id: str, driver_id: str, lap: int) -> dict:
    session = resolve_session(db, race_id)
    sk = session.session_key
    meta = driver_meta_by_id(db, sk)
    _driver_or_404(meta, driver_id)

    gap = gaps_by_lap(db, sk).get((driver_id, lap), {}).get("ahead")
    this_attempt = next(
        (a for a in _swap_attempts(db, sk) if a["lap"] == lap and a["behind"] == driver_id), None,
    )
    base_rates = _overtake_base_rates(db)
    bucket = _bucket_for(gap) if gap is not None else None
    rate_info = base_rates.get(bucket) if bucket else None
    drs_likely = gap is not None and gap < 1.0
    recorded_overtakes = db.query(Overtake).filter(Overtake.session_key == sk).count()

    if gap is None:
        verdict, confidence = "NO CAR AHEAD", 0.0
    elif rate_info and rate_info["rate"] is not None:
        verdict = "ATTACK" if rate_info["rate"] >= 0.35 else "HOLD POSITION"
        confidence = min(0.9, rate_info["attempts"] / 200)
    else:
        verdict, confidence = "INSUFFICIENT DATA", 0.0

    reasoning: list[str] = []
    if gap is not None:
        reasoning.append(f"Gap to the car ahead is {gap:.2f}s ({bucket} bucket).")
        if drs_likely:
            reasoning.append(
                "Under 1.0s at this point — DRS would likely be available (inferred from the 1-second rule; "
                "exact detection-zone geometry isn't in this dataset)."
            )
        if rate_info and rate_info["rate"] is not None:
            reasoning.append(
                f"In this gap bucket, {rate_info['passes']} of {rate_info['attempts']} following-lap situations "
                f"across every ingested race ({rate_info['rate'] * 100:.0f}%) ended in a position swap the next lap."
            )
    else:
        reasoning.append("No measurable gap to a car ahead at this lap (leading, lapped, or missing data).")

    return _envelope(
        verdict=verdict, confidence=confidence,
        expectedGain=rate_info["rate"] if rate_info else None,
        reasoning=reasoning,
        facts=[
            {"label": "Gap ahead", "value": f"{gap:.2f}s" if gap is not None else "n/a"},
            {"label": "DRS likely available", "value": "Yes" if drs_likely else "No"},
            {"label": "Historical pass rate, this bucket", "value": f"{rate_info['rate'] * 100:.0f}%" if rate_info and rate_info["rate"] is not None else "n/a"},
            {"label": "Recorded overtakes this race", "value": str(recorded_overtakes)},
        ],
        sampleSize=rate_info["attempts"] if rate_info else 0,
        source="derived",
        actual={"attempted": this_attempt is not None, "succeeded": this_attempt["success"] if this_attempt else None},
    )


def defence_call(db: OrmSession, race_id: str, driver_id: str, lap: int) -> dict:
    session = resolve_session(db, race_id)
    sk = session.session_key
    meta = driver_meta_by_id(db, sk)
    _driver_or_404(meta, driver_id)

    gap = gaps_by_lap(db, sk).get((driver_id, lap), {}).get("behind")
    this_attempt = next(
        (a for a in _swap_attempts(db, sk) if a["lap"] == lap and a["ahead"] == driver_id), None,
    )
    base_rates = _overtake_base_rates(db)
    bucket = _bucket_for(gap) if gap is not None else None
    rate_info = base_rates.get(bucket) if bucket else None
    dirty_air = dirty_air_loss(db, sk)

    if gap is None:
        verdict, confidence = "NO THREAT", 0.0
    elif rate_info and rate_info["rate"] is not None:
        verdict = "UNDER THREAT — DEFEND" if rate_info["rate"] >= 0.35 else "SECURE"
        confidence = min(0.9, rate_info["attempts"] / 200)
    else:
        verdict, confidence = "INSUFFICIENT DATA", 0.0

    reasoning: list[str] = []
    if gap is not None:
        reasoning.append(f"Car behind is {gap:.2f}s back ({bucket} bucket).")
        if rate_info and rate_info["rate"] is not None:
            reasoning.append(
                f"Historically, chasers in this gap bucket completed the pass {rate_info['rate'] * 100:.0f}% "
                f"of the time ({rate_info['passes']}/{rate_info['attempts']})."
            )
        if dirty_air.get("lossSeconds"):
            reasoning.append(
                f"Running this close typically costs the chaser {dirty_air['lossSeconds']:.2f}s a lap in dirty "
                f"air here (n={dirty_air['followingSampleSize']}) — the tax working in your favour."
            )
    else:
        reasoning.append("No car close enough behind to measure a threat at this lap.")

    return _envelope(
        verdict=verdict, confidence=confidence,
        expectedGain=-rate_info["rate"] if rate_info and rate_info["rate"] is not None else None,
        reasoning=reasoning,
        facts=[
            {"label": "Gap behind", "value": f"{gap:.2f}s" if gap is not None else "n/a"},
            {"label": "Historical pass rate against this gap", "value": f"{rate_info['rate'] * 100:.0f}%" if rate_info and rate_info["rate"] is not None else "n/a"},
            {"label": "Dirty-air cost to a close follower", "value": f"{dirty_air['lossSeconds']:.2f}s" if dirty_air.get("lossSeconds") else "n/a"},
        ],
        sampleSize=rate_info["attempts"] if rate_info else 0,
        source="derived",
        actual={"passed": this_attempt["success"] if this_attempt else None},
    )


# ---------------------------------------------------------------------------
# Position prediction + Risk (one Monte Carlo, two views)
# ---------------------------------------------------------------------------

_HAZARD_CACHE: dict | None = None


def _hazard_rates(db: OrmSession) -> dict:
    """Base rates the Monte Carlo draws from: how often a fresh SC/VSC shows
    up per lap, and how often a car retires per lap, across every ingested
    race. Real historical frequencies, not invented ones."""
    global _HAZARD_CACHE
    if _HAZARD_CACHE is not None:
        return _HAZARD_CACHE

    race_sks = _race_sessions(db)
    total_sc_events = 0
    total_laps_run = 0
    for sk in race_sks:
        total_sc_events += sum(1 for e in neutralisation_events(db, sk) if e["type"] in ("SC", "VSC"))
        max_lap = db.query(func.max(SessionLap.lap_number)).filter(SessionLap.session_key == sk).scalar()
        if max_lap:
            total_laps_run += max_lap

    total_dnf = (
        db.query(SessionResult)
        .filter(SessionResult.session_key.in_(race_sks), SessionResult.dnf.is_(True))
        .count()
    )
    total_driver_laps = db.query(SessionLap).filter(SessionLap.session_key.in_(race_sks)).count()

    _HAZARD_CACHE = {
        "scPerLap": round(total_sc_events / total_laps_run, 5) if total_laps_run else 0.0,
        "dnfPerLap": round(total_dnf / total_driver_laps, 6) if total_driver_laps else 0.0,
        "totalRaces": len(race_sks), "totalScEvents": total_sc_events, "totalDnf": total_dnf,
    }
    return _HAZARD_CACHE


def _monte_carlo(db: OrmSession, race_id: str, driver_id: str, lap: int, n_runs: int = 1500) -> dict:
    """~1,500 simulated finishes from lap N to the flag: this driver's own
    demonstrated pace for the rest of the race, perturbed by the model's own
    published lap-time error and this dataset's real safety-car and
    retirement hazard rates. Every rival is frozen at their actual result —
    this measures the variance in *this driver's* run, not a full
    what-if-everyone-raced-differently simulation."""
    session = resolve_session(db, race_id)
    sk = session.session_key
    meta = driver_meta_by_id(db, sk)
    _driver_or_404(meta, driver_id)

    cumulative, last_lap, race_laps = _real_cumulative(db, sk)
    if driver_id not in cumulative:
        raise HTTPException(status_code=404, detail="No lap data for this driver in this race.")

    available_laps = cumulative[driver_id]
    if lap not in available_laps:
        lap = min(available_laps, key=lambda l: abs(l - lap))

    prefix = available_laps[lap]
    own_last_lap = last_lap[driver_id]
    retired_before_end = own_last_lap < race_laps

    # Racing pace and pit-stop cost are kept separate on purpose. Bootstrapping
    # every remaining lap (pit-affected ones included) risks drawing the same
    # pit-inflated lap two or three times in one run and zero times in
    # another, which manufactures a bogus bimodal "disaster run" cluster that
    # has nothing to do with real strategy variance. Racing laps supply the
    # natural lap-to-lap spread (degradation, traffic, one scrappy lap); the
    # driver's own remaining stop(s) are charged exactly once per run, at
    # their real measured cost, matching how many times it actually happened.
    own_rows = (
        db.query(SessionLap)
        .filter(SessionLap.session_key == sk, SessionLap.driver_id == driver_id, SessionLap.lap_number > lap)
        .all()
    )
    driver_stints = (
        db.query(SessionStint)
        .filter(SessionStint.session_key == sk, SessionStint.driver_id == driver_id)
        .order_by(SessionStint.stint_number)
        .all()
    )
    # `pit_stops` is not reliably populated per session (this dataset has
    # whole 2023 races with zero rows there despite the driver clearly
    # changing tyres, per their own stint boundaries) so the in-lap and the
    # remaining stop count both come from `session_stints` instead, which
    # covers every ingested race. A stint's last lap is the pit-in lap: its
    # final sector includes the pit-lane entry and reads slower than a racing
    # lap, so it is excluded from the pace pool the same way the out-lap is.
    stint_in_laps = {s.lap_end for s in driver_stints if s.lap_end and s.lap_end > lap}
    racing_laps = [
        r.lap_time_seconds for r in own_rows
        if r.lap_time_seconds is not None and not r.is_pit_out_lap and r.lap_number not in stint_in_laps
    ]
    all_remaining = [r.lap_time_seconds for r in own_rows if r.lap_time_seconds is not None]
    own_pace = median(racing_laps) if racing_laps else (
        median(all_remaining) if all_remaining
        else median_clean_lap([l.lap_time_seconds for l in clean_laps(db, sk)]) or 90.0
    )
    remaining_stops = sum(1 for lap_end in stint_in_laps if lap_end < own_last_lap)
    per_stop_loss, _ = measured_pit_loss(db, session)
    remaining_pit_cost = remaining_stops * per_stop_loss

    mae = predictor.holdout_mae() or 1.0
    hazards = _hazard_rates(db)
    sc_hazard, dnf_hazard = hazards["scPerLap"], hazards["dnfPerLap"]

    # A retired rival's total elapsed time is not comparable to a finisher's:
    # fewer laps means less elapsed time, which would rank an early DNF ahead
    # of a car that actually finished. F1 classifies every finisher above
    # every retiree regardless of time, so only finishers enter the time
    # comparison; a simulated run that itself finishes always outranks them.
    results = {
        r.driver_id: r for r in db.query(SessionResult).filter(SessionResult.session_key == sk).all()
        if r.driver_id
    }
    rival_totals = {
        did: series[last_lap[did]]
        for did, series in cumulative.items()
        if did != driver_id and not (results.get(did) and results[did].dnf)
    }
    n_retired_rivals = sum(1 for did in cumulative if did != driver_id and results.get(did) and results[did].dnf)

    n_remaining = max(0, race_laps - lap)
    positions: list[int] = []
    dnf_runs = 0
    for _ in range(n_runs):
        if retired_before_end and random.random() < 0.7:
            # The real car retired near here; most runs of "what if we kept
            # going from this exact point" keep that outcome rather than
            # pretending the mechanical failure or contact never happened.
            dnf_runs += 1
            continue
        total = prefix + remaining_pit_cost
        survived = True
        for _lap_index in range(n_remaining):
            if random.random() < dnf_hazard:
                survived = False
                break
            if random.random() < sc_hazard:
                total += own_pace * random.uniform(1.3, 1.9)
            else:
                # Bootstrap from the driver's own remaining *racing* laps
                # rather than repeating a single median every lap: a constant
                # median pace lets noise alone put a driver on flat-out pace
                # for 40 laps straight, which their real stint (degradation,
                # traffic, one scrappy lap) never allowed. Resampling their
                # own real racing laps keeps that natural spread without
                # touching the pit stop, which is charged once above instead.
                base = random.choice(racing_laps) if racing_laps else own_pace
                total += base + random.gauss(0, mae * 0.5)
        if not survived:
            dnf_runs += 1
            continue
        better = sum(1 for t in rival_totals.values() if t < total)
        positions.append(better + 1)

    actual_result = (
        db.query(SessionResult).filter(SessionResult.session_key == sk, SessionResult.driver_id == driver_id).first()
    )

    return {
        "raceLaps": race_laps, "lap": lap, "nRuns": n_runs, "finishedRuns": len(positions),
        "dnfProbability": round(dnf_runs / n_runs, 3) if n_runs else 0.0,
        "positions": positions, "positionCounts": dict(sorted(Counter(positions).items())),
        "expectedPosition": round(sum(positions) / len(positions), 2) if positions else None,
        "actualPosition": actual_result.position if actual_result else None,
        "maxPosition": len(rival_totals) + n_retired_rivals + 1,
        "hazards": hazards,
    }


def outcome_call(db: OrmSession, race_id: str, driver_id: str, lap: int) -> dict:
    mc = _monte_carlo(db, race_id, driver_id, lap)
    histogram = [
        {"position": p, "probability": round(count / mc["finishedRuns"], 4) if mc["finishedRuns"] else 0.0}
        for p, count in mc["positionCounts"].items()
    ]
    mae = predictor.holdout_mae()

    verdict = f"LIKELY P{round(mc['expectedPosition'])}" if mc["expectedPosition"] else "INSUFFICIENT DATA"
    reasoning = [
        f"{mc['nRuns']} simulated finishes from lap {mc['lap']} of {mc['raceLaps']}, using this driver's own "
        f"remaining pace plus the model's published lap-time error ({mae:.2f}s MAE)" if mae else
        f"{mc['nRuns']} simulated finishes from lap {mc['lap']} of {mc['raceLaps']}, using this driver's own remaining pace",
        f"and this dataset's historical safety-car rate ({mc['hazards']['totalScEvents']} events across "
        f"{mc['hazards']['totalRaces']} races) and retirement rate ({mc['hazards']['totalDnf']} DNFs).",
    ]
    if mc["actualPosition"]:
        reasoning.append(f"They actually finished P{mc['actualPosition']}.")

    return _envelope(
        verdict=verdict,
        confidence=min(0.9, mc["finishedRuns"] / mc["nRuns"]) if mc["nRuns"] else 0.0,
        expectedGain=(mc["actualPosition"] - mc["expectedPosition"]) if (mc["actualPosition"] and mc["expectedPosition"]) else None,
        reasoning=reasoning,
        facts=[
            {"label": "Expected finishing position", "value": f"P{mc['expectedPosition']:.1f}" if mc["expectedPosition"] else "n/a"},
            {"label": "DNF probability, rest of race", "value": f"{mc['dnfProbability'] * 100:.1f}%"},
            {"label": "Actual finishing position", "value": f"P{mc['actualPosition']}" if mc["actualPosition"] else "unclassified"},
        ],
        sampleSize=mc["nRuns"], source="modelled",
        actual={"position": mc["actualPosition"]},
        extra={"histogram": histogram, "raceLaps": mc["raceLaps"], "lap": mc["lap"], "maxPosition": mc["maxPosition"]},
    )


def risk_call(db: OrmSession, race_id: str, driver_id: str, lap: int) -> dict:
    mc = _monte_carlo(db, race_id, driver_id, lap)
    finished = mc["positions"]
    actual = mc["actualPosition"]
    n = len(finished)

    p_gain = round(sum(1 for p in finished if p < actual) / n, 3) if n and actual else None
    p_loss = round(sum(1 for p in finished if p > actual) / n, 3) if n and actual else None
    sorted_pos = sorted(finished)
    p5 = sorted_pos[int(0.05 * n)] if n else None
    p95 = sorted_pos[min(n - 1, int(0.95 * n))] if n else None

    if mc["dnfProbability"] > 0.15 or (p_loss or 0) > 0.5:
        verdict = "HIGH RISK"
    elif mc["dnfProbability"] < 0.05 and (p_loss or 0) < 0.3:
        verdict = "LOW RISK"
    else:
        verdict = "MODERATE RISK"

    reasoning = [
        (f"Of {n} simulated finishes, {round((p_loss or 0) * 100)}% finish worse than the actual P{actual}, "
         f"{round((p_gain or 0) * 100)}% finish better.") if actual else f"{n} simulated finishes to the flag.",
        f"Worst case (5th percentile): P{p5}. Best case (95th percentile): P{p95}." if (p5 and p95) else "Not enough finished runs for a percentile range.",
        f"DNF probability for the remaining {mc['raceLaps'] - mc['lap']} laps: {mc['dnfProbability'] * 100:.1f}%, "
        f"from this dataset's historical retirement rate.",
    ]

    return _envelope(
        verdict=verdict,
        confidence=min(0.9, n / mc["nRuns"]) if mc["nRuns"] else 0.0,
        expectedGain=None, reasoning=reasoning,
        facts=[
            {"label": "P(finish better than actual)", "value": f"{(p_gain or 0) * 100:.0f}%"},
            {"label": "P(finish worse than actual)", "value": f"{(p_loss or 0) * 100:.0f}%"},
            {"label": "Worst case (P5)", "value": f"P{p5}" if p5 else "n/a"},
            {"label": "Best case (P95)", "value": f"P{p95}" if p95 else "n/a"},
            {"label": "DNF probability", "value": f"{mc['dnfProbability'] * 100:.1f}%"},
        ],
        sampleSize=mc["nRuns"], source="modelled",
        actual={"position": actual},
    )
