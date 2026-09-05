# OpenTyreF1 — Product Requirements Document & Implementation Plan

**Platform pivot:** React Native (Expo / Expo Go) mobile app
**Project:** OpenTyreF1 — Intelligent Formula 1 Race Strategy & Telemetry Analysis Platform
**Team:** Atharva Joshi, Ankit Sawalakhe, Kripa Patil, Araju Yelekar, Devshree Khodke
**Guide:** Mrs. Prachi Jain — Dept. of CSE, G H Raisoni University, Amravati (Session 2026-27)

---

## 1. Product Overview

OpenTyreF1 is a mobile app that lets users watch a race unfold, browse F1 driver history back to 2002, build and simulate their own race strategies, and ask an in-app assistant for strategy insight — all backed by real F1 data and a trained ML model, in line with the project's original goals of explainability, modularity, and industry-oriented data use.

## 2. What the reference repo actually gives us

This app is being built from scratch. [`IAmTomShaw/f1-race-replay`](https://github.com/IAmTomShaw/f1-race-replay) is used in two limited ways, nowhere else:

1. **General reference** for how to load and shape FastF1 data (`src/f1_data.py`) — sessions, laps, tyre stints, telemetry.
2. **A pattern for the Strategy Simulator's playback UI** (Screen 3): the repo's core trick is turning a loaded session into a time-ordered sequence of leaderboard/telemetry "frames" that can be played, paused, and scrubbed. That same pattern is a good fit for *watching your simulated strategy play out lap-by-lap* — press play and see simulated positions/gaps evolve — rather than for live data.

It's a Python desktop app (`arcade` GUI) and can't run inside Expo Go, and it isn't a live data source, so it has no role in Screen 1.

## 3. Scope

**In scope (MVP):**
- Driver stats/records database, 2002–present, searchable
- Session "replay" playback (any historical session) that looks and feels live
- Strategy builder + simulation engine (tyre stints → predicted outcome)
- AI assistant answering strategy/driver questions from real data + model output

**Out of scope / stretch goals (call this out to your mentor explicitly):**
- True real-time live timing during an actual live race weekend — free tiers of live F1 data (OpenF1) are limited and real official live timing is normally paid/rate-limited. Treat "Live" as best-effort during real sessions, with replay mode as the reliable fallback and demo path.
- Full LLM-powered conversational AI in Phase 1 — start with a templated explainability layer (matches your mentor's "Explainable AI" note), add a hosted LLM call as a later enhancement if time allows.
- Pre-2002 data — Jolpica-F1 covers back to 1950 if you want to stretch the range later; not required for MVP.

## 4. Data Sources

| Source | Role | Coverage |
|---|---|---|
| **FastF1** (Python) | Lap-by-lap timing, telemetry, tyre stints, session results | Full detail from 2018 onward |
| **Jolpica-F1** (Ergast-compatible REST API) | Career stats, standings, race results, team history | 1950–present (covers your 2002 requirement) |
| **OpenF1** | Best-effort live/near-live data during real sessions | Free tier 2023+, live access limited/paid |
| **f1-race-replay repo** | Reference for frame-generation logic only | N/A — logic reused, code not run directly |

All of this is ingested server-side and cached in PostgreSQL — the mobile app never talks to these APIs directly.

## 5. System Architecture

```
Expo Go App (React Native, TypeScript)
        │  REST + WebSocket
        ▼
FastAPI Backend
  ├── Ingestion jobs (FastF1 + Jolpica-F1) ──► PostgreSQL
  ├── Live session service (own implementation)
  ├── Strategy simulation service (XGBoost model + per-lap playback frames,
  │     frame pattern referenced from f1-race-replay)
  └── AI explanation service (templated NLG, optional LLM call)
        ▲
PostgreSQL (drivers, races, sessions, laps, stints, strategies, standings)
```

**Why a backend at all, instead of calling FastF1 from the phone:** FastF1 is a Python library with pandas/matplotlib dependencies — it cannot run inside Expo Go. A FastAPI backend is required regardless of platform, and it doubles as the place your XGBoost model lives and serves predictions from.

## 6. Functional Requirements by Screen

### Screen 1 — Live / Replay
- Leaderboard with live position, gap to leader, current tyre compound
- Lap counter, session clock, weather snapshot
- Tap a driver → telemetry panel (speed, gear, DRS, current lap time)
- Mode: "Live" during real session weekends (best-effort, via OpenF1/FastF1 live data — see risks below) and "Latest completed session" as the reliable fallback/demo path
- This screen is built independently — no dependency on the reference repo

**Key endpoints:**
- `GET /api/sessions?season=&round=` — list available sessions
- `GET /api/sessions/{sessionId}/live` — current leaderboard/telemetry snapshot (polled or streamed)

### Screen 2 — Driver Stats & Records (2002–present)
- Search/filter by driver name, team, season
- Driver profile: wins, podiums, poles, championships, team history, season-by-season results
- For 2018+ drivers: fastest laps, top speed, additional telemetry summaries where available

**Key endpoints:**
- `GET /api/drivers?search=&season=`
- `GET /api/drivers/{driverId}`
- `GET /api/drivers/{driverId}/seasons/{year}`

### Screen 3 — Strategy Maker & Simulation
- Pick a circuit + driver
- Build a strategy: add stints (tyre compound + lap count), reorder, remove
- "Run Simulation" → predicted total race time, projected finish/gap, tyre degradation curve, pit-loss breakdown
- Compare against what actually happened in the real race for that circuit
- **Playback of the simulated race**: play/pause/scrub through the simulated laps and watch position/gap evolve — this is where the reference repo's frame-by-frame playback pattern applies

**Key endpoint:**
- `POST /api/strategy/simulate` — body: `{ raceId, driverId, stints: [{ compound, laps }] }` → predicted outcome + per-lap frame data for playback

### Screen 4 — F1 AI Assistant
- Chat-style Q&A: "Best tyre strategy for Monza?", "Compare these two drivers"
- Answers grounded in the simulation model's output + driver/circuit stats (explainable, not freeform)
- Quick-prompt buttons for common questions

**Key endpoint:**
- `POST /api/ai/query` — body: `{ question, context }` → grounded natural-language answer

## 7. Data Model (core entities)

`Driver`, `Constructor`, `Season`, `Race`/`Event`, `Session`, `Lap`, `Stint`, `TyreCompound`, `Circuit`, `UserStrategy`, `SimulationResult`

## 8. Non-Functional Requirements

- **Expo Go compatible:** MVP uses only JS/TS libraries (no custom native modules) — `expo-router`, `@tanstack/react-query`, `axios`, `victory-native` or `react-native-svg` for charts, `zustand` for light state
- **Offline-friendly:** cache driver/race data on-device via React Query persistence so the driver database and past simulations work without a live connection during a demo
- **Performance:** telemetry/replay frames paginated/throttled server-side, not dumped all at once
- **Explainability:** every prediction (Screens 3 & 4) should show *why*, not just the number — feature importance or a plain-language breakdown

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Live timing access is unreliable/paid | Ship replay mode as the primary, demo-safe experience; live is best-effort bonus |
| FastF1 has no telemetry pre-2018 | Driver stats screen relies on Jolpica-F1 for career history; telemetry extras only shown when available |
| XGBoost model needs real training data | Start model training early (Phase 3) using 2018+ FastF1 stint data — this is the longest-lead item |
| Expo Go native module limits | Keep MVP to JS-only libraries; only move to EAS/dev builds if a stretch feature truly needs a native module |

## 10. Phased Build Plan

### Phase 0 — Foundations (Weeks 1–2)
- Scaffold Expo app (TypeScript, `expo-router`) and FastAPI backend
- Stand up PostgreSQL; write ingestion scripts for FastF1 (one season) and Jolpica-F1
- **Deliverable:** Expo app hits a FastAPI health-check endpoint; one season of data sits in Postgres

### Phase 1 — Data Layer & Driver Stats Screen (Weeks 3–4)
- Finalize schema (drivers, constructors, seasons, races, results, standings)
- Ingest Jolpica-F1 data for 2002–present
- Build `/api/drivers` endpoints + mobile Driver Stats screen (search, profile, season history)
- **Deliverable:** working, searchable driver database screen on real data

### Phase 2 — Live Screen (Weeks 5–6)
- Build `/api/sessions/{sessionId}/live` endpoint (own implementation, best-effort live + latest-completed-session fallback)
- Build mobile Live screen: leaderboard, telemetry-on-tap, weather, session status
- **Deliverable:** live/latest-session screen showing real leaderboard and telemetry data

### Phase 2b — Race Replay Engine (Week 6–7)
- Build a `GET /api/races/{raceId}/replay` endpoint that turns any past race (2002–present) into an ordered array of per-lap frames (leaderboard, gaps, tyre compounds), FastF1-detailed for 2018+ and coarser for earlier seasons
- Build a reusable mobile `<RaceReplayPlayer>` component (play/pause/scrub, animated leaderboard reordering) — this is the direct application of the reference repo's frame/playback idea, built independently in this stack
- Wire it into a race search/detail view so any old race can be watched
- **Deliverable:** any real past race can be searched and watched lap-by-lap; the player component is generic enough to be reused for simulated data in Phase 3

### Phase 3 — Strategy Maker & Simulation Engine (Weeks 8–10)
- Train XGBoost tyre-degradation/lap-time model on FastF1 stint data (2018+)
- Build `/api/strategy/simulate` (stints in → predicted time/finish/degradation curve + per-lap frames out)
- Build mobile Strategy Maker screen: stint builder, results view with charts, reusing Phase 2b's `<RaceReplayPlayer>` fed simulated frames instead of real ones
- **Deliverable:** working what-if strategy simulator with a watchable playback, longest phase — start model training as early as possible

### Phase 4 — AI Assistant (Weeks 10–11)
- Build templated explainability layer over model feature importances (no external LLM dependency yet)
- Build mobile AI Assistant screen: chat UI + quick prompts
- Stretch: wire in a hosted LLM call using retrieved stats/simulation context as grounding
- **Deliverable:** assistant answering real questions with grounded, explainable answers

### Phase 5 — Polish, Testing, Demo Prep (Weeks 12–13)
- Loading/error states, offline caching pass, cross-screen QA on Expo Go (Android + iOS)
- Preload a handful of marquee races/drivers so the demo works without network dependency
- Write up architecture + results for the report/poster
- **Deliverable:** demo-ready build + supporting material for thesis/poster submission

## 11. Appendix — References

- FastF1 docs: https://docs.fastf1.dev/
- Jolpica-F1 (Ergast-compatible historical API)
- OpenF1 API: https://openf1.org/
- FIA Sporting Regulations: https://www.fia.com/regulation/category/110
- Reference repo: https://github.com/IAmTomShaw/f1-race-replay
