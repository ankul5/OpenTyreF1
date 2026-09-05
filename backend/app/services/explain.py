"""The assistant's answer engine (Phase 4).

This is deliberately **not** a chatbot. Every sentence it returns is rendered
from a number that came out of the database or the simulator, and a question
it cannot ground in real data gets an honest "I can't answer that, here is
what I can" rather than a plausible-sounding guess. That is the whole design
brief: grounded and explainable, not conversational.

How it works:

1. `detect_intent` scores the question against a small set of keyword sets.
2. `resolve_*` pulls the entities out (drivers by code/surname, a race from
   context or from the question).
3. One renderer per intent turns real rows into prose plus a `facts` list,
   which the app shows as a labelled table under the sentence, so the reader
   can check the working.

The structure matters beyond the MVP: `answer()` returns the numbers
alongside the prose, so a hosted LLM can later be handed the same `facts`
block as grounding and asked only to phrase it. Nothing about the retrieval
would change.
"""

from __future__ import annotations

import re
from collections import defaultdict

from sqlalchemy import func
from sqlalchemy.orm import Session as OrmSession

from app.models.models import (
    Driver, Race, Result, Session, SessionDriver, SessionResult, SessionStint,
    Standing, PitStop, SessionWeather,
)
from app.ml import predictor
from app.services import simulation
from app.services.analysis import degradation_curves, teammate_gaps, consistency
from app.services.lap_filters import clean_laps, median_clean_lap, race_session_key
from app.services.presentation import driver_meta_by_id

# ---------------------------------------------------------------------------
# Intent detection
# ---------------------------------------------------------------------------

INTENT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "explain_simulation": (
        "explain", "why is", "why does", "why did", "my strategy", "this strategy",
        "simulation", "simulate", "my plan", "lose time", "losing time", "slower than",
    ),
    # "which tyre" deliberately does not appear here: it reads as a strategy
    # question but "which tyre degraded fastest" is a degradation question,
    # and the longer phrase would otherwise outscore the right intent.
    "best_strategy": (
        "best strategy", "best tyre strategy", "optimal strategy", "what strategy",
        "which strategy", "how many stops", "one stop", "two stop", "should i stop",
        "winning strategy", "which tyre should", "what tyre should",
    ),
    "compare_drivers": ("compare", " vs ", " versus ", "better than", "who is faster", "head to head"),
    "degradation": (
        "degradation", "degrade", "degraded", "deg ", "wear", "tyre life", "tire life",
        "falls off", "which tyre lasted", "tyre lasted",
    ),
    "pit_stops": ("pit stop", "pitstop", "fastest stop", "pit lane", "stop time", "pit loss"),
    "fastest_lap": ("fastest lap", "quickest lap", "lap record", "best lap"),
    "conditions": ("weather", "rain", "temperature", "track temp", "hot", "wet", "conditions"),
    "consistency": ("consistent", "consistency", "most reliable", "erratic"),
    "teammate": ("teammate", "team mate", "team-mate", "against his team", "against their team"),
    "race_summary": (
        "who won", "what happened", "summary", "recap", "podium", "result of",
        "how did the race", "race result",
    ),
    "driver_stats": (
        "how many wins", "how many titles", "championships", "how many podiums",
        "how many poles", "career", "stats for", "tell me about",
    ),
    "methodology": (
        "how does the model", "how do you", "how is this calculated", "methodology",
        "what data", "where does the data", "how accurate", "trained on", "how does it work",
    ),
}

CAPABILITIES = [
    "Explain why a simulated strategy gains or loses time",
    "Rank the tyre strategies that actually worked at a circuit",
    "Compare two drivers, over a career or within one race",
    "Report degradation, pit stops, fastest laps, pace and conditions for a race",
    "Explain how the lap-time model was trained and how accurate it is",
]


def detect_intent(question: str) -> tuple[str, float]:
    """Best-matching intent and a rough match strength.

    Longer keyword phrases score higher than single words, so "best tyre
    strategy" beats a stray "strategy" elsewhere in the sentence.
    """
    text = f" {question.lower().strip()} "
    best_intent, best_score = "unknown", 0.0
    for intent, keywords in INTENT_KEYWORDS.items():
        score = sum(len(k) for k in keywords if k in text)
        if score > best_score:
            best_intent, best_score = intent, float(score)
    # Normalised against the length of a typical strong phrase.
    return best_intent, min(1.0, best_score / 14.0)


# ---------------------------------------------------------------------------
# Entity resolution
# ---------------------------------------------------------------------------

# Words that are also driver surnames or codes but almost never mean the
# driver in a question ("Russell", "Bottas" are safe; these are not).
_STOPWORDS = {"the", "and", "for", "was", "who", "how", "why", "what", "this", "that", "car", "red", "bull"}


def resolve_drivers(db: OrmSession, question: str, limit: int = 2) -> list[Driver]:
    """Drivers named in the question, by three-letter code or by surname.

    Ordered by where they appear in the sentence, so "compare Norris and
    Piastri" keeps Norris first.
    """
    text = question.lower()
    tokens = {t for t in re.findall(r"[a-zà-ÿ]{3,}", text) if t not in _STOPWORDS}
    if not tokens:
        return []

    candidates = (
        db.query(Driver)
        .filter(
            func.lower(Driver.family_name).in_(tokens)
            | func.lower(Driver.code).in_(tokens)
            | func.lower(Driver.driver_id).in_(tokens)
        )
        .all()
    )

    def position(driver: Driver) -> int:
        for key in (driver.family_name, driver.code, driver.driver_id):
            if key and (idx := text.find(key.lower())) >= 0:
                return idx
        return 10_000

    seen: set[str] = set()
    ordered = []
    for driver in sorted(candidates, key=position):
        if driver.driver_id in seen:
            continue
        seen.add(driver.driver_id)
        ordered.append(driver)
    return ordered[:limit]


def resolve_race(db: OrmSession, question: str, context: dict) -> Race | None:
    """The race in context, or one named in the question."""
    race_id = context.get("raceId")
    if race_id:
        race = db.query(Race).filter(Race.race_id == race_id).first()
        if race:
            return race

    text = question.lower()
    year = None
    if match := re.search(r"\b(19[5-9]\d|20[0-4]\d)\b", text):
        year = int(match.group(1))

    q = db.query(Race).join(Session, Session.race_id == Race.race_id).filter(Session.session_name == "Race")
    if year:
        q = q.filter(Race.season_year == year)

    for race in q.order_by(Race.season_year.desc(), Race.round.desc()).all():
        for label in (race.circuit_name, race.race_name, race.locality, race.country):
            if label and len(label) > 4 and label.lower() in text:
                return race
    return None


# ---------------------------------------------------------------------------
# Small formatting helpers
# ---------------------------------------------------------------------------

def _clock(seconds: float | None) -> str:
    if seconds is None:
        return "n/a"
    hours, rest = divmod(int(seconds), 3600)
    minutes, secs = divmod(rest, 60)
    frac = seconds - int(seconds)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}.{int(frac * 1000):03d}"
    return f"{minutes}:{secs:02d}.{int(frac * 1000):03d}"


def _lap_time(seconds: float | None) -> str:
    if seconds is None:
        return "n/a"
    minutes, secs = divmod(seconds, 60)
    return f"{int(minutes)}:{secs:06.3f}" if minutes else f"{secs:.3f}s"


def _signed(seconds: float | None, unit: str = "s") -> str:
    if seconds is None:
        return "n/a"
    return f"{'+' if seconds > 0 else ''}{seconds:.3f}{unit}"


def _ordinal(n: int | None) -> str:
    if n is None:
        return "unclassified"
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"P{n}" if n <= 20 else f"{n}{suffix}"


def _title(race: Race) -> str:
    return f"{race.season_year} {race.race_name}"


def _fact(label: str, value: str, highlight: bool = False) -> dict:
    return {"label": label, "value": value, "highlight": highlight}


def _reply(intent: str, answer: str, facts: list[dict] | None = None,
           sources: list[str] | None = None, follow_ups: list[str] | None = None,
           grounded: bool = True) -> dict:
    return {
        "intent": intent,
        "answer": answer,
        "facts": facts or [],
        "sources": sources or [],
        "followUps": follow_ups or [],
        "grounded": grounded,
    }


def _unsupported(reason: str, follow_ups: list[str] | None = None) -> dict:
    return _reply(
        "unsupported",
        f"{reason}\n\nWhat I can answer:\n" + "\n".join(f"- {c}" for c in CAPABILITIES),
        follow_ups=follow_ups or [
            "Explain my strategy", "Best tyre strategy here", "Who won this race?",
        ],
        grounded=False,
    )


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------

def explain_simulation(db: OrmSession, context: dict) -> dict:
    """Why a stint plan gains or loses time, pointing at the actual drivers of it.

    Not a restatement of the total: it separates pit-lane time from on-track
    pace, names the stint whose degradation costs the most, and compares
    against what the driver really did.
    """
    race_id, driver_id, stints = context.get("raceId"), context.get("driverId"), context.get("stints")
    if not (race_id and driver_id and stints):
        return _unsupported(
            "I need a strategy to explain. Build a stint plan on the Strategy tab and run it first."
        )

    result = simulation.simulate(db, race_id, driver_id, stints,
                                 pit_loss_override=context.get("pitLossSeconds"))

    code = result["driver"]["code"] or driver_id
    delta = result["projectedFinishDelta"]
    breakdown = result["stintBreakdown"]
    pit_time = result["timeLostInPits"]
    horizon = result["comparedOverLaps"]

    worst = max(breakdown, key=lambda b: b["degradationPerLap"] * b["laps"]) if breakdown else None
    fastest_stint = min(breakdown, key=lambda b: b["averageLap"]) if breakdown else None

    lines = []
    if delta is None:
        lines.append(
            f"Over {horizon} laps this plan comes out at {_clock(result['totalTime'])} for {code}. "
            "There is no complete real lap-time series for them in this race, so I cannot put a "
            "delta on it."
        )
    else:
        projected = result["projectedPosition"]
        actually = result["actual"]["position"]
        direction = "faster" if delta < 0 else "slower"
        # "finishing P1 instead of P1" is the obvious way to write this and it
        # is nonsense, so the unchanged case gets its own sentence.
        if projected == actually:
            outcome = f"which is not enough to move them off {_ordinal(actually)}"
        elif projected is None or actually is None:
            outcome = f"finishing {_ordinal(projected)}"
        else:
            gained = actually - projected
            outcome = (
                f"{'gaining' if gained > 0 else 'losing'} {abs(gained)} "
                f"{'place' if abs(gained) == 1 else 'places'}, "
                f"{_ordinal(actually)} to {_ordinal(projected)}"
            )
        lines.append(
            f"This plan is {abs(delta):.1f}s {direction} than what {code} actually did over the "
            f"same {horizon} laps, {outcome}."
        )

    real_stops = result["actual"]["stops"]
    if result["pitStops"] != real_stops:
        difference = (result["pitStops"] - real_stops) * result["pitLossSeconds"]
        more_or_fewer = "extra" if result["pitStops"] > real_stops else "fewer"
        lines.append(
            f"The stop count is the biggest single lever here: {result['pitStops']} stops against "
            f"their real {real_stops}. At a measured {result['pitLossSeconds']:.1f}s of pit-lane loss "
            f"({result['pitLossSource']}), that is {abs(difference):.1f}s of {more_or_fewer} pit time "
            "before a single lap is driven."
        )
    else:
        lines.append(
            f"Both plans stop {real_stops} times, so the {result['pitLossSeconds']:.1f}s pit-lane "
            "loss cancels out and the difference is all on-track pace."
        )

    if worst and worst["degradationPerLap"] > 0.01:
        cost = worst["degradationPerLap"] * worst["laps"]
        lines.append(
            f"Stint {worst['stint']} is where the tyre bites: {worst['laps']} laps on "
            f"{worst['compound'].title()} degrading {worst['degradationPerLap']:.3f}s per lap, so the "
            f"closing lap is {worst['closingLap'] - worst['openingLap']:+.1f}s off the opening one and "
            f"the stint gives away about {cost:.1f}s in total."
        )
    elif worst:
        lines.append(
            f"Degradation barely moves across any stint here, so the plan lives or dies on the "
            f"{result['pitStops']} pit stops rather than on tyre wear."
        )

    if fastest_stint and worst and fastest_stint["stint"] != worst["stint"]:
        lines.append(
            f"The quickest running is stint {fastest_stint['stint']} on "
            f"{fastest_stint['compound'].title()}, averaging {_lap_time(fastest_stint['averageLap'])}."
        )

    facts = [
        _fact("Predicted total", _clock(result["totalTime"]), highlight=True),
        _fact("Delta vs. actual", _signed(delta) if delta is not None else "n/a",
              highlight=delta is not None and delta < 0),
        _fact("Projected finish", _ordinal(result["projectedPosition"])),
        _fact("Actual finish", _ordinal(result["actual"]["position"])),
        _fact("Pit stops", f"{result['pitStops']} ({result['timeLostInPits']:.1f}s total)"),
    ]
    for stint in breakdown:
        facts.append(_fact(
            f"Stint {stint['stint']} · {stint['compound'].title()}",
            f"{stint['laps']} laps, {stint['degradationPerLap']:+.3f}s/lap",
        ))

    margin = result["uncertainty"]["totalTimeMarginSeconds"]
    if margin:
        lines.append(
            f"Treat the total as {_clock(result['totalTime'])} give or take {margin:.0f}s: that is the "
            "model's holdout error compounded over the race distance, not a precision claim."
        )
    for note in result["uncertainty"]["notes"] + result["warnings"]:
        lines.append(note)

    return _reply(
        "explain_simulation",
        " ".join(lines),
        facts,
        sources=[f"Simulation of {code} at {result['raceName']}", result["modelDetail"]],
        follow_ups=["What was the best strategy here?", "How accurate is the model?"],
    )


def best_strategy(db: OrmSession, race: Race | None) -> dict:
    """Strategies that actually worked at this circuit, ranked by finish.

    This is retrieval, not optimisation: it reports what the field really ran
    and where it got them, which is a claim the data supports.
    """
    if not race:
        return _unsupported(
            "I need to know which race you mean. Open a race first, or name it "
            "(for example \"best strategy at Silverstone 2024\")."
        )

    sk = race_session_key(db, race.race_id)
    if not sk:
        return _unsupported(f"No lap data is ingested for {_title(race)}. OpenF1 covers 2023 onward.")

    finish = {
        r.driver_id: r.position
        for r in db.query(SessionResult).filter(SessionResult.session_key == sk).all()
        if r.driver_id and r.position
    }
    meta = driver_meta_by_id(db, sk)

    plans: dict[str, list[dict]] = defaultdict(list)
    for stint in (
        db.query(SessionStint)
        .filter(SessionStint.session_key == sk, SessionStint.compound.isnot(None))
        .order_by(SessionStint.stint_number)
        .all()
    ):
        if stint.driver_id and stint.lap_start and stint.lap_end:
            plans[stint.driver_id].append(stint)

    runs = []
    for driver_id, stints in plans.items():
        position = finish.get(driver_id)
        if not position:
            continue
        runs.append({
            "driverId": driver_id,
            "code": meta.get(driver_id, {}).get("code") or driver_id,
            "position": position,
            "sequence": " to ".join(s.compound.title() for s in stints),
            "stops": len(stints) - 1,
        })
    if not runs:
        return _unsupported(f"No tyre stint data is ingested for {_title(race)}.")

    runs.sort(key=lambda r: r["position"])
    winner = runs[0]

    by_stops: dict[int, list[int]] = defaultdict(list)
    for run in runs:
        by_stops[run["stops"]].append(run["position"])

    # A stop count that only one car tried is an anecdote, not evidence: its
    # "average finish" is that single car's result. Those are still reported,
    # but they cannot be called the strongest plan.
    summary = sorted(
        ((stops, len(ps), sum(ps) / len(ps)) for stops, ps in by_stops.items()),
        key=lambda x: x[2],
    )
    ranked = [row for row in summary if row[1] >= 2] or summary

    lines = [
        f"At {_title(race)} the race was won on {winner['sequence']}, a {winner['stops']}-stop, "
        f"by {winner['code']}."
    ]

    best_stops, best_count, best_avg = ranked[0]
    lines.append(
        f"Across the classified field the {best_stops}-stop came out strongest: "
        f"{best_count} {'car' if best_count == 1 else 'cars'} ran it for an average finish of "
        f"{best_avg:.1f}."
    )

    # Name each stop count at most once. Whichever comparison is more
    # interesting gets the sentence: the winner's plan if it was not the
    # strongest, otherwise the weakest plan in the field.
    mentioned = {best_stops}
    if winner["stops"] not in mentioned:
        winner_row = next((r for r in summary if r[0] == winner["stops"]), None)
        if winner_row:
            mentioned.add(winner["stops"])
            lines.append(
                f"The winner's {winner['stops']}-stop averaged {winner_row[2]:.1f} across "
                f"{winner_row[1]} {'car' if winner_row[1] == 1 else 'cars'}, so the winning run "
                "says more about the car than the plan."
            )
    remaining = [r for r in ranked if r[0] not in mentioned]
    if remaining:
        other_stops, other_count, other_avg = remaining[-1]
        lines.append(
            f"The weakest was the {other_stops}-stop at {other_avg:.1f} across {other_count} "
            f"{'car' if other_count == 1 else 'cars'}, a gap of {other_avg - best_avg:.1f} "
            "positions."
        )

    degradation = degradation_curves(db, sk)
    if degradation:
        by_compound: dict[str, list[float]] = defaultdict(list)
        for curve in degradation:
            if curve["compound"]:
                by_compound[curve["compound"].title()].append(curve["degradationPerLap"])
        ranked = sorted(
            ((c, sum(v) / len(v)) for c, v in by_compound.items()), key=lambda x: x[1]
        )
        if ranked:
            lines.append(
                f"On degradation the {ranked[0][0]} held up best at {ranked[0][1]:+.3f}s per lap "
                f"of fuel-corrected wear" +
                (f", against {ranked[-1][0]} at {ranked[-1][1]:+.3f}s." if len(ranked) > 1 else ".")
            )

    facts = [_fact(f"{_ordinal(r['position'])} {r['code']}", f"{r['sequence']} ({r['stops']}-stop)",
                   highlight=r["position"] == 1)
             for r in runs[:6]]

    return _reply(
        "best_strategy",
        " ".join(lines),
        facts,
        sources=[f"OpenF1 stint and classification data, {_title(race)}"],
        follow_ups=["Which tyre degraded fastest?", "Who had the fastest pit stop?"],
    )


def compare_drivers(db: OrmSession, drivers: list[Driver], race: Race | None) -> dict:
    if len(drivers) < 2:
        return _unsupported(
            "I need two drivers to compare. Try \"compare Verstappen and Norris\"."
        )

    a, b = drivers[0], drivers[1]

    def career(driver: Driver) -> dict:
        rows = db.query(Result).filter(Result.driver_id == driver.driver_id).all()
        titles = (
            db.query(func.count(Standing.id))
            .filter(Standing.driver_id == driver.driver_id, Standing.position == 1)
            .scalar() or 0
        )
        return {
            "starts": len(rows),
            "wins": sum(1 for r in rows if r.position == 1),
            "podiums": sum(1 for r in rows if r.position and r.position <= 3),
            "poles": sum(1 for r in rows if r.qualifying_position == 1),
            "points": round(sum(r.points or 0 for r in rows), 1),
            "titles": int(titles),
        }

    stats_a, stats_b = career(a), career(b)
    name_a = f"{a.given_name} {a.family_name}"
    name_b = f"{b.given_name} {b.family_name}"

    lines = [
        f"{name_a} has {stats_a['wins']} wins and {stats_a['titles']} "
        f"{'title' if stats_a['titles'] == 1 else 'titles'} from {stats_a['starts']} starts. "
        f"{name_b} has {stats_b['wins']} and {stats_b['titles']} from {stats_b['starts']}."
    ]
    if stats_a["starts"] and stats_b["starts"]:
        rate_a = stats_a["wins"] / stats_a["starts"] * 100
        rate_b = stats_b["wins"] / stats_b["starts"] * 100
        ahead = name_a if rate_a >= rate_b else name_b
        lines.append(
            f"By win rate that is {rate_a:.1f}% against {rate_b:.1f}%, so {ahead} is ahead on the "
            "measure that does not reward a longer career."
        )

    facts = []
    for label, key, fmt in (
        ("Starts", "starts", "{}"), ("Wins", "wins", "{}"), ("Podiums", "podiums", "{}"),
        ("Poles", "poles", "{}"), ("Points", "points", "{}"), ("Titles", "titles", "{}"),
    ):
        facts.append(_fact(
            label,
            f"{fmt.format(stats_a[key])}  ·  {fmt.format(stats_b[key])}",
            highlight=key == "wins",
        ))

    sources = ["Jolpica/Ergast results and standings, 2002 onward"]

    if race:
        sk = race_session_key(db, race.race_id)
        if sk:
            laps = clean_laps(db, sk)
            times: dict[str, list[float]] = defaultdict(list)
            for lap in laps:
                times[lap.driver_id].append(lap.lap_time_seconds)
            med_a = median_clean_lap(sorted(times.get(a.driver_id, []))) if times.get(a.driver_id) else None
            med_b = median_clean_lap(sorted(times.get(b.driver_id, []))) if times.get(b.driver_id) else None
            if med_a and med_b:
                faster, gap = (a, med_b - med_a) if med_a <= med_b else (b, med_a - med_b)
                lines.append(
                    f"In {_title(race)} specifically, {faster.family_name} was {gap:.3f}s per lap "
                    "quicker on median clean-lap pace."
                )
                facts.append(_fact("Median clean lap here",
                                   f"{_lap_time(med_a)}  ·  {_lap_time(med_b)}"))
                sources.append(f"Clean-lap pace, {_title(race)}")

    return _reply(
        "compare_drivers",
        " ".join(lines),
        facts,
        sources=sources,
        follow_ups=[f"Tell me about {a.family_name}", f"Tell me about {b.family_name}"],
    )


def driver_stats(db: OrmSession, drivers: list[Driver]) -> dict:
    if not drivers:
        return _unsupported(
            "I did not recognise a driver in that question. Use a surname or a three-letter code, "
            "for example \"how many wins does Alonso have?\"."
        )
    driver = drivers[0]
    rows = db.query(Result).filter(Result.driver_id == driver.driver_id).all()
    if not rows:
        return _unsupported(
            f"I have no results for {driver.given_name} {driver.family_name}. "
            "Driver history covers 2002 onward."
        )

    wins = sum(1 for r in rows if r.position == 1)
    podiums = sum(1 for r in rows if r.position and r.position <= 3)
    poles = sum(1 for r in rows if r.qualifying_position == 1)
    points = round(sum(r.points or 0 for r in rows), 1)
    titles = (
        db.query(func.count(Standing.id))
        .filter(Standing.driver_id == driver.driver_id, Standing.position == 1)
        .scalar() or 0
    )
    seasons = sorted({
        y for (y,) in db.query(Race.season_year)
        .join(Result, Result.race_id == Race.race_id)
        .filter(Result.driver_id == driver.driver_id).distinct().all()
    })

    answer = (
        f"{driver.given_name} {driver.family_name} has {wins} wins, {podiums} podiums and "
        f"{poles} poles from {len(rows)} starts, scoring {points} points"
        + (f" and {titles} {'championship' if titles == 1 else 'championships'}." if titles else ".")
    )
    if seasons:
        answer += f" The record here runs from {seasons[0]} to {seasons[-1]}."
    if len(rows) and wins:
        answer += f" That is a win in {wins / len(rows) * 100:.1f}% of races entered."

    return _reply(
        "driver_stats",
        answer,
        [
            _fact("Starts", str(len(rows))),
            _fact("Wins", str(wins), highlight=True),
            _fact("Podiums", str(podiums)),
            _fact("Poles", str(poles)),
            _fact("Points", str(points)),
            _fact("Titles", str(int(titles))),
        ],
        sources=["Jolpica/Ergast results and standings, 2002 onward"],
        follow_ups=[f"Compare {driver.family_name} and Hamilton"],
    )


def race_summary(db: OrmSession, race: Race | None) -> dict:
    if not race:
        return _unsupported("Which race? Open one from the Races list, or name it and the season.")
    sk = race_session_key(db, race.race_id)
    if not sk:
        return _unsupported(f"No session data is ingested for {_title(race)}.")

    meta = driver_meta_by_id(db, sk)
    results = (
        db.query(SessionResult)
        .filter(SessionResult.session_key == sk, SessionResult.position.isnot(None))
        .order_by(SessionResult.position)
        .all()
    )
    if not results:
        return _unsupported(f"No classification is ingested for {_title(race)}.")

    podium = results[:3]
    names = [meta.get(r.driver_id, {}).get("code") or r.driver_id or "?" for r in podium]
    grid = dict(
        db.query(Result.driver_id, Result.grid)
        .filter(Result.race_id == race.race_id, Result.grid.isnot(None)).all()
    )

    lines = [f"{_title(race)} was won by {names[0]}"]
    if len(names) >= 3:
        lines[0] += f", ahead of {names[1]} and {names[2]}."
    else:
        lines[0] += "."

    gains = [
        (meta.get(r.driver_id, {}).get("code") or r.driver_id, grid[r.driver_id] - r.position)
        for r in results
        if r.driver_id in grid and grid[r.driver_id] and r.position
    ]
    if gains:
        code, gained = max(gains, key=lambda g: g[1])
        if gained > 0:
            lines.append(f"{code} made up the most ground, {gained} places from the grid.")

    laps = clean_laps(db, sk)
    if laps:
        best = min(laps, key=lambda l: l.lap_time_seconds)
        best_code = meta.get(best.driver_id, {}).get("code") or best.driver_id
        lines.append(f"The fastest clean lap was {best_code}'s {_lap_time(best.lap_time_seconds)} on lap {best.lap_number}.")

    weather = db.query(SessionWeather).filter(SessionWeather.session_key == sk).all()
    if weather:
        wet = any(w.rainfall for w in weather)
        track = [w.track_temperature for w in weather if w.track_temperature is not None]
        if track:
            lines.append(
                f"Track temperature averaged {sum(track) / len(track):.0f}°C and it was a "
                f"{'wet' if wet else 'dry'} race."
            )

    facts = [
        _fact(_ordinal(r.position),
              f"{meta.get(r.driver_id, {}).get('code') or r.driver_id}"
              + (f"  {r.gap_to_leader}" if r.gap_to_leader else ""),
              highlight=r.position == 1)
        for r in results[:5]
    ]

    return _reply(
        "race_summary", " ".join(lines), facts,
        sources=[f"OpenF1 classification and laps, {_title(race)}"],
        follow_ups=["What was the best strategy here?", "Who had the fastest pit stop?"],
    )


def degradation_answer(db: OrmSession, race: Race | None) -> dict:
    if not race:
        return _unsupported("Which race's degradation? Open a race first, or name it.")
    sk = race_session_key(db, race.race_id)
    curves = degradation_curves(db, sk) if sk else []
    if not curves:
        return _unsupported(f"Not enough clean stint data in {_title(race)} to measure degradation.")

    by_compound: dict[str, list[float]] = defaultdict(list)
    for curve in curves:
        if curve["compound"]:
            by_compound[curve["compound"].title()].append(curve["degradationPerLap"])
    ranked = sorted(((c, sum(v) / len(v), len(v)) for c, v in by_compound.items()), key=lambda x: -x[1])

    worst = ranked[0]
    best = ranked[-1]
    lines = [
        f"In {_title(race)} the {worst[0]} degraded fastest at {worst[1]:+.3f}s per lap across "
        f"{worst[2]} {'stint' if worst[2] == 1 else 'stints'}, and the {best[0]} held up best at "
        f"{best[1]:+.3f}s per lap.",
        "These are fuel-corrected: the session's own lap-time-versus-lap-number slope is subtracted "
        "first, so what is left is tyre wear rather than the car getting lighter.",
    ]
    if worst[1] > 0 and best[1] > 0:
        stint_length = 20
        lines.append(
            f"Over a {stint_length}-lap stint that difference is worth about "
            f"{(worst[1] - best[1]) * stint_length:.1f}s."
        )

    facts = [_fact(c, f"{slope:+.3f}s/lap over {n} {'stint' if n == 1 else 'stints'}",
                   highlight=c == best[0])
             for c, slope, n in ranked]
    return _reply("degradation", " ".join(lines), facts,
                  sources=[f"Fuel-corrected stint regression, {_title(race)}"],
                  follow_ups=["What was the best strategy here?"])


def pit_stop_answer(db: OrmSession, race: Race | None) -> dict:
    if not race:
        return _unsupported("Which race's pit stops? Open a race first, or name it.")
    sk = race_session_key(db, race.race_id)
    if not sk:
        return _unsupported(f"No session data is ingested for {_title(race)}.")

    meta_by_number = {
        e.driver_number: e for e in db.query(SessionDriver).filter(SessionDriver.session_key == sk).all()
    }
    stops = [
        p for p in db.query(PitStop).filter(PitStop.session_key == sk).all()
        if p.pit_duration is not None
        and simulation.PIT_LOSS_MIN <= p.pit_duration <= simulation.PIT_LOSS_MAX
    ]
    if not stops:
        return _unsupported(
            f"No usable pit-stop data for {_title(race)}. OpenF1's pit endpoint returns nothing "
            "for 2023, so pit timing starts at 2024."
        )

    stops.sort(key=lambda p: p.pit_duration)
    fastest = stops[0]
    code = (meta_by_number.get(fastest.driver_number).name_acronym
            if meta_by_number.get(fastest.driver_number) else None) or "?"
    measured, source = simulation.measured_pit_loss(db, db.query(Session).filter(Session.session_key == sk).first())

    lines = [
        f"The quickest pit-lane transit at {_title(race)} was {code}'s {fastest.pit_duration:.2f}s "
        f"on lap {fastest.lap_number}.",
        f"The median across {len(stops)} stops was {measured:.1f}s, which is the pit-loss figure the "
        f"simulator charges per stop ({source}).",
        "These are pit-lane times, not stationary times, and readings outside "
        f"{simulation.PIT_LOSS_MIN:.0f}-{simulation.PIT_LOSS_MAX:.0f}s are dropped as red-flag or "
        "timing artifacts.",
    ]
    facts = [
        _fact(
            (meta_by_number.get(p.driver_number).name_acronym
             if meta_by_number.get(p.driver_number) else "?") or "?",
            f"{p.pit_duration:.2f}s on lap {p.lap_number}",
            highlight=p is fastest,
        )
        for p in stops[:5]
    ]
    return _reply("pit_stops", " ".join(lines), facts,
                  sources=[f"OpenF1 pit data, {_title(race)}"],
                  follow_ups=["What was the best strategy here?"])


def fastest_lap_answer(db: OrmSession, race: Race | None) -> dict:
    if not race:
        return _unsupported("Which race? Open one first, or name it and the season.")
    sk = race_session_key(db, race.race_id)
    laps = clean_laps(db, sk) if sk else []
    if not laps:
        return _unsupported(f"No clean lap data for {_title(race)}.")

    meta = driver_meta_by_id(db, sk)
    best = min(laps, key=lambda l: l.lap_time_seconds)
    code = meta.get(best.driver_id, {}).get("code") or best.driver_id

    by_driver: dict[str, float] = {}
    for lap in laps:
        if lap.driver_id not in by_driver or lap.lap_time_seconds < by_driver[lap.driver_id]:
            by_driver[lap.driver_id] = lap.lap_time_seconds
    ranked = sorted(by_driver.items(), key=lambda kv: kv[1])[:5]

    return _reply(
        "fastest_lap",
        f"{code} set the fastest clean lap of {_title(race)}, a {_lap_time(best.lap_time_seconds)} "
        f"on lap {best.lap_number} on {(best.tyre_compound or 'an unrecorded compound').title()}. "
        "Pit, opening and safety-car laps are excluded, so this is a green-flag time.",
        [
            _fact(meta.get(d, {}).get("code") or d, _lap_time(t), highlight=i == 0)
            for i, (d, t) in enumerate(ranked)
        ],
        sources=[f"Clean-lap filter over OpenF1 laps, {_title(race)}"],
        follow_ups=["Who was most consistent?", "Which tyre degraded fastest?"],
    )


def consistency_answer(db: OrmSession, race: Race | None) -> dict:
    if not race:
        return _unsupported("Which race? Open one first, or name it.")
    sk = race_session_key(db, race.race_id)
    rows = consistency(db, sk) if sk else []
    if not rows:
        return _unsupported(f"Not enough clean laps in {_title(race)} to measure consistency.")
    best, worst = rows[0], rows[-1]
    return _reply(
        "consistency",
        f"{best['code']} was the most consistent driver at {_title(race)}, with a standard "
        f"deviation of {best['stdDevSeconds']:.3f}s across {best['laps']} clean laps. "
        f"{worst['code']} was the most variable at {worst['stdDevSeconds']:.3f}s. "
        "This is spread, not speed: a slow but metronomic car scores well here.",
        [_fact(r["code"] or r["driverId"], f"{r['stdDevSeconds']:.3f}s over {r['laps']} laps",
               highlight=r is best)
         for r in rows[:5]],
        sources=[f"Standard deviation of clean laps, {_title(race)}"],
        follow_ups=["Who set the fastest lap?"],
    )


def teammate_answer(db: OrmSession, race: Race | None) -> dict:
    if not race:
        return _unsupported("Which race? Open one first, or name it.")
    sk = race_session_key(db, race.race_id)
    gaps = teammate_gaps(db, sk) if sk else []
    if not gaps:
        return _unsupported(f"No complete teammate pairs with clean laps in {_title(race)}.")
    closest, widest = gaps[0], gaps[-1]
    return _reply(
        "teammate",
        f"At {_title(race)} the closest teammate pair was {closest['team']}, "
        f"{closest['fasterCode']} ahead of {closest['slowerCode']} by just "
        f"{closest['gapSeconds']:.3f}s of median pace. The widest was {widest['team']}, where "
        f"{widest['fasterCode']} had {widest['gapSeconds']:.3f}s per lap on {widest['slowerCode']}.",
        [_fact(g["team"], f"{g['fasterCode']} by {g['gapSeconds']:.3f}s", highlight=g is widest)
         for g in gaps],
        sources=[f"Median clean-lap pace by team, {_title(race)}"],
        follow_ups=["Who was most consistent?"],
    )


def conditions_answer(db: OrmSession, race: Race | None) -> dict:
    if not race:
        return _unsupported("Which race's conditions? Open one first, or name it.")
    sk = race_session_key(db, race.race_id)
    rows = db.query(SessionWeather).filter(SessionWeather.session_key == sk).order_by(SessionWeather.date).all() if sk else []
    if not rows:
        return _unsupported(f"No weather data is ingested for {_title(race)}.")

    air = [w.air_temperature for w in rows if w.air_temperature is not None]
    track = [w.track_temperature for w in rows if w.track_temperature is not None]
    humidity = [w.humidity for w in rows if w.humidity is not None]
    wet = any(w.rainfall for w in rows)

    parts = [f"{_title(race)} ran {'in the wet' if wet else 'dry'}."]
    if track:
        parts.append(
            f"Track temperature ran {min(track):.0f}°C to {max(track):.0f}°C, averaging "
            f"{sum(track) / len(track):.0f}°C."
        )
    if air:
        parts.append(f"Air was around {sum(air) / len(air):.0f}°C.")
    parts.append(
        "Track temperature is one of the model's six inputs, so a hot session shifts its "
        "degradation prediction upward."
    )

    facts = []
    if air:
        facts.append(_fact("Air", f"{sum(air) / len(air):.1f}°C"))
    if track:
        facts.append(_fact("Track", f"{sum(track) / len(track):.1f}°C", highlight=True))
    if humidity:
        facts.append(_fact("Humidity", f"{sum(humidity) / len(humidity):.0f}%"))
    facts.append(_fact("Rainfall recorded", "Yes" if wet else "No"))

    return _reply("conditions", " ".join(parts), facts,
                  sources=[f"OpenF1 weather trace, {_title(race)}"],
                  follow_ups=["Which tyre degraded fastest?"])


def methodology_answer() -> dict:
    status = predictor.status()
    if not status["available"]:
        return _reply(
            "methodology",
            "No trained model is loaded right now, so the simulator falls back to fitting pace and "
            "degradation to the race's own clean laps. Running `python -m app.ml.train_tyre_model` "
            "in the backend folder trains the real one from every ingested race. "
            "Either way, a clean lap means: not lap 1, not a pit in or out lap, not under a safety "
            "car, and within 107% of that driver's own median.",
            [_fact("Model", "Not trained yet")],
            sources=["app/ml/train_tyre_model.py", "app/services/lap_filters.py"],
            follow_ups=["Explain my strategy"],
        )

    all_metrics = status["metrics"]
    metrics = all_metrics["model"]
    headline_key = all_metrics.get("headline_baseline", "baseline_driver_circuit_median")
    baseline = all_metrics[headline_key]
    relative = status.get("targetMode") == "relative"
    years = status["years"]
    importance = sorted((status["featureImportance"] or {}).items(), key=lambda kv: -kv[1])[:3]

    lines = [
        f"Lap times come from an XGBoost regressor trained on {status['trainingRows']:,} clean race "
        f"laps from {status['trainingRaces']} races between {years[0]} and {years[1]}, using "
        f"{', '.join(status['features'])}."
    ]
    if relative:
        lines.append(
            "It predicts each lap's offset from that race's own median clean lap rather than an "
            "absolute time. That is fair rather than a shortcut, because the simulator only ever "
            "runs against a real historical race, so that median is genuinely known at prediction "
            "time. It also puts the model's effort where the question is: what the tyre, the fuel "
            "load and the conditions do to a lap, not how fast this circuit is."
        )
    lines.append(
        f"On a holdout of {status['holdoutRaces']} races it never saw, it lands within "
        f"{metrics['mae']:.3f}s of the real lap time on average."
    )
    if relative:
        lines.append(
            f"The baseline it has to beat is the one handed the same reference pace: predict that "
            f"median for every lap, which scores {baseline['mae']:.3f}s. The model is "
            f"{all_metrics['mae_improvement_seconds']:.3f}s better, so roughly "
            f"{(1 - metrics['mae'] / baseline['mae']) * 100:.0f}% of the within-race variation is "
            "explained by tyre age, compound and conditions."
        )
    else:
        lines.append(
            f"The naive \"this driver's median lap at this circuit\" baseline scores "
            f"{baseline['mae']:.3f}s on the same holdout."
        )
    lines.append(
        "The split is by whole race, three ways. Two laps from the same race share a car, a track "
        "and a fuel load, so splitting laps randomly would leak almost everything. Early stopping "
        f"watches a separate validation set of {status.get('validationRaces')} races, and the "
        "holdout is scored once at the end without influencing any training decision."
    )
    lines.append(
        "A clean lap excludes lap 1, pit in and out laps, safety-car laps, and anything slower than "
        "107% of that driver's own median."
    )

    facts = [
        _fact("Holdout MAE", f"{metrics['mae']:.3f}s", highlight=True),
        _fact("Baseline it beats", f"{baseline['mae']:.3f}s"),
        _fact("R squared", f"{metrics['r2']:.3f}"),
        _fact("Training laps", f"{status['trainingRows']:,}"),
        _fact("Races: train / validate / hold out",
              f"{status['trainingRaces']} / {status.get('validationRaces')} / {status['holdoutRaces']}"),
        _fact("Top features", ", ".join(name for name, _ in importance)),
    ]

    return _reply(
        "methodology", " ".join(lines), facts,
        sources=[
            "app/ml/train_tyre_model.py",
            "app/services/lap_filters.py",
            "OpenF1 laps, stints, weather and race control",
        ],
        follow_ups=["Explain my strategy"],
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def answer(db: OrmSession, question: str, context: dict | None = None) -> dict:
    """Route one question to the renderer whose data can actually support it."""
    context = context or {}
    question = (question or "").strip()
    if len(question) < 3:
        return _unsupported("Ask me something about a race, a driver, or a strategy.")

    intent, strength = detect_intent(question)
    race = resolve_race(db, question, context)
    drivers = resolve_drivers(db, question)

    # "Compare X and Y" wins over a weaker keyword match elsewhere in the
    # sentence: two named drivers is a much stronger signal than one verb.
    if len(drivers) >= 2 and intent in ("unknown", "driver_stats", "race_summary"):
        intent = "compare_drivers"

    if intent == "unknown" or strength < 0.25:
        if drivers:
            intent = "compare_drivers" if len(drivers) >= 2 else "driver_stats"
        elif context.get("stints"):
            intent = "explain_simulation"
        else:
            return _unsupported("I could not match that to something I have data for.")

    routes = {
        "explain_simulation": lambda: explain_simulation(db, context),
        "best_strategy": lambda: best_strategy(db, race),
        "compare_drivers": lambda: compare_drivers(db, drivers, race),
        "driver_stats": lambda: driver_stats(db, drivers),
        "race_summary": lambda: race_summary(db, race),
        "degradation": lambda: degradation_answer(db, race),
        "pit_stops": lambda: pit_stop_answer(db, race),
        "fastest_lap": lambda: fastest_lap_answer(db, race),
        "consistency": lambda: consistency_answer(db, race),
        "teammate": lambda: teammate_answer(db, race),
        "conditions": lambda: conditions_answer(db, race),
        "methodology": methodology_answer,
    }
    result = routes[intent]()
    result["matchedRaceId"] = race.race_id if race else None
    result["matchedDrivers"] = [d.driver_id for d in drivers]
    return result
