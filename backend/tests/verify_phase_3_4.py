"""End-to-end check of the Phase 3 and Phase 4 endpoints against a live server.

    python tests/verify_phase_3_4.py                 # http://localhost:8000
    python tests/verify_phase_3_4.py --base http://10.0.0.5:8000

Not a unit-test suite: it drives the real API against the real ingested
database, which is the only way to catch the failures that actually happen
here (a race with no pit data, a driver who retired, a model artifact that
does not match the feature list the simulator sends). Exits non-zero if any
check fails, so it can gate a demo.
"""

from __future__ import annotations

import argparse
import sys

import requests

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> bool:
    results.append((name, PASS if condition else FAIL, detail))
    return condition


def section(title: str) -> None:
    results.append((f"--- {title}", "", ""))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8000")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    def get(path: str, **kwargs):
        return requests.get(f"{base}{path}", timeout=60, **kwargs)

    def post(path: str, payload: dict):
        return requests.post(f"{base}{path}", json=payload, timeout=60)

    # ---------------------------------------------------------------- health
    section("Health and model")
    try:
        health = get("/api/health")
    except requests.RequestException as exc:
        print(f"Cannot reach {base}: {exc}")
        print("Start it with: uvicorn app.main:app --host 0.0.0.0 --port 8000")
        return 1
    check("GET /api/health", health.status_code == 200, str(health.status_code))

    model = get("/api/strategy/model").json()
    check("GET /api/strategy/model responds", "available" in model)
    if model.get("available"):
        metrics = model["metrics"]
        headline = metrics[metrics["headline_baseline"]]
        check(
            "Model beats the baseline it is measured against",
            metrics["beats_baseline"],
            f"MAE {metrics['model']['mae']:.3f}s vs {headline['mae']:.3f}s",
        )
        check("Holdout is whole races", (model.get("holdoutRaces") or 0) >= 1,
              f"{model.get('holdoutRaces')} races")
        check("Validation split exists (no early stopping on the holdout)",
              (model.get("validationRaces") or 0) >= 1, f"{model.get('validationRaces')} races")
    else:
        results.append(("Model artifact present", "SKIP",
                        "no artifact; the simulator will use its empirical fallback"))

    # ------------------------------------------------------------ a real race
    section("Strategy options")
    races = get("/api/races", params={"limit": 5}).json()["items"]
    if not check("GET /api/races returns replayable races", bool(races)):
        return report()

    race = races[0]
    options = get(f"/api/strategy/options/{race['raceId']}").json()
    check("Options include drivers", bool(options.get("drivers")), f"{len(options.get('drivers', []))}")
    check("Options include a race distance", (options.get("raceLaps") or 0) > 5,
          f"{options.get('raceLaps')} laps")
    check("Pit loss is in a plausible range",
          15.0 <= options.get("pitLossSeconds", 0) <= 45.0,
          f"{options.get('pitLossSeconds')}s from {options.get('pitLossSource')}")

    winner = options["drivers"][0]
    check("Leading driver has a real stint plan", bool(winner.get("actualStints")),
          str(winner.get("actualStints")))

    # -------------------------------------------------------------- simulate
    section("Simulation")
    race_laps = options["raceLaps"]
    real_plan = [
        {"compound": s["compound"], "laps": s["laps"]}
        for s in winner["actualStints"] if s.get("compound") and s.get("laps")
    ]
    if not real_plan:
        real_plan = [{"compound": "MEDIUM", "laps": race_laps}]

    replay = post("/api/strategy/simulate", {
        "raceId": race["raceId"], "driverId": winner["driverId"], "stints": real_plan,
    })
    if not check("POST /api/strategy/simulate", replay.status_code == 200,
                 replay.text[:200] if replay.status_code != 200 else ""):
        return report()
    sim = replay.json()

    check("Total time is plausible for a race",
          3000 < sim["totalTime"] < 12000, f"{sim['totalTime']:.1f}s")
    check("Frames cover the compared distance",
          len(sim["frames"]) == sim["comparedOverLaps"],
          f"{len(sim['frames'])} frames / {sim['comparedOverLaps']} laps")
    check("Frames carry a full field", len(sim["frames"][0]["leaderboard"]) > 5,
          f"{len(sim['frames'][0]['leaderboard'])} cars on lap 1")
    check("Exactly one car in a frame is the simulated one",
          sum(1 for e in sim["frames"][-1]["leaderboard"] if e["simulated"]) == 1)
    check("Positions in a frame are 1..n with no gaps",
          [e["position"] for e in sim["frames"][-1]["leaderboard"]]
          == list(range(1, len(sim["frames"][-1]["leaderboard"]) + 1)))
    check("Leader's gap is zero",
          abs(sim["frames"][-1]["leaderboard"][0]["gap"]) < 0.001)
    check("Degradation curve has one point per planned lap",
          len(sim["degradationCurve"]) == sim["plannedLaps"])
    check("Cumulative time increases monotonically",
          all(a["cumulativeTime"] < b["cumulativeTime"]
              for a, b in zip(sim["degradationCurve"], sim["degradationCurve"][1:])))
    check("Pit stops charged once per stint change",
          sum(1 for p in sim["degradationCurve"] if p["pitStop"]) == sim["pitStops"],
          f"{sim['pitStops']} stops")

    # Replaying the driver's real strategy should land near their real time.
    delta = sim.get("projectedFinishDelta")
    if delta is not None:
        check("Replaying the real plan lands close to the real race time",
              abs(delta) < 120, f"{delta:+.1f}s over {sim['comparedOverLaps']} laps")

    section("Simulation: a different strategy changes the answer")
    one_stop = post("/api/strategy/simulate", {
        "raceId": race["raceId"], "driverId": winner["driverId"],
        "stints": [
            {"compound": "MEDIUM", "laps": race_laps // 2},
            {"compound": "HARD", "laps": race_laps - race_laps // 2},
        ],
    }).json()
    check("A one-stop produces a different total than the real plan",
          abs(one_stop["totalTime"] - sim["totalTime"]) > 0.5,
          f"{one_stop['totalTime']:.1f}s vs {sim['totalTime']:.1f}s")
    check("Fewer stops means less pit time",
          one_stop["timeLostInPits"] <= sim["timeLostInPits"] or sim["pitStops"] <= 1)

    section("Simulation: bad input is rejected, not guessed at")
    bad = post("/api/strategy/simulate", {
        "raceId": race["raceId"], "driverId": winner["driverId"],
        "stints": [{"compound": "BANANA", "laps": 10}],
    })
    check("Unknown compound is a 400", bad.status_code in (400, 422), str(bad.status_code))

    missing = post("/api/strategy/simulate", {
        "raceId": race["raceId"], "driverId": "not_a_real_driver",
        "stints": [{"compound": "SOFT", "laps": 10}],
    })
    check("Unknown driver is a 404", missing.status_code == 404, str(missing.status_code))

    # -------------------------------------------------------------- assistant
    section("Assistant")
    caps = get("/api/ai/capabilities").json()
    check("GET /api/ai/capabilities", bool(caps.get("quickPrompts")))

    context = {"raceId": race["raceId"], "driverId": winner["driverId"], "stints": real_plan}

    def ask(question: str, ctx: dict | None = None) -> dict:
        return post("/api/ai/query", {"question": question, "context": ctx or {}}).json()

    explained = ask("Explain why my strategy loses time", context)
    check("Explains a simulation", explained["intent"] == "explain_simulation", explained["intent"])
    check("Explanation cites real numbers", len(explained["facts"]) >= 4)
    check("Explanation names the pit-loss lever", "pit" in explained["answer"].lower())

    best = ask("What was the best tyre strategy here?", {"raceId": race["raceId"]})
    check("Answers best strategy", best["intent"] == "best_strategy", best["intent"])

    who = ask("Who won this race?", {"raceId": race["raceId"]})
    check("Answers race summary", who["intent"] == "race_summary", who["intent"])

    deg = ask("Which tyre degraded fastest?", {"raceId": race["raceId"]})
    check("Answers degradation", deg["intent"] == "degradation", deg["intent"])

    compare = ask("Compare Hamilton and Verstappen")
    check("Compares two drivers", compare["intent"] == "compare_drivers", compare["intent"])
    check("Comparison resolved both drivers", len(compare.get("matchedDrivers", [])) == 2,
          str(compare.get("matchedDrivers")))

    stats = ask("How many wins does Alonso have?")
    check("Answers driver stats", stats["intent"] == "driver_stats", stats["intent"])

    how = ask("How does the model work and how accurate is it?")
    check("Explains its own methodology", how["intent"] == "methodology", how["intent"])

    nonsense = ask("What is the best pizza in Rome?")
    check("Refuses what it cannot ground", nonsense["grounded"] is False, nonsense["intent"])
    check("Refusal lists what it can do", "What I can answer" in nonsense["answer"])

    no_context = ask("Explain why my strategy loses time")
    check("Asks for a strategy when given none", no_context["grounded"] is False)

    # Every grounded answer must carry a source.
    for label, payload in (("explain", explained), ("best strategy", best), ("summary", who)):
        check(f"Answer cites a source: {label}", bool(payload.get("sources")))

    return report()


def report() -> int:
    width = max(len(name) for name, _, _ in results) + 2
    failed = 0
    print()
    for name, status, detail in results:
        if not status:
            print(f"\n{name}")
            continue
        if status == FAIL:
            failed += 1
        print(f"  {name.ljust(width)} {status}" + (f"   {detail}" if detail else ""))

    total = sum(1 for _, s, _ in results if s in (PASS, FAIL))
    print(f"\n{total - failed}/{total} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
