# Leftover work

## Today — Live feed & database (in progress)

Branch: `feature/strategy-pitwall-modules` (uncommitted, alongside the pitwall
work below). Full plan with rationale, measured numbers, and file-level detail
at `C:\Users\ankul\.claude\plans\breezy-riding-kurzweil.md`.

**Why:** the Live tab showed Zandvoort (Aug 23) after the Italian GP had already
run — not a lag, the backend had no code path that ever fetched new data.
`opentyref1.db` is committed and baked into the Docker image; refreshing it was
a manual CLI run + commit + redeploy nobody was doing. Separately, the Races
screen only ever offered 2026/2025/2024 (a pagination bug hid 2023 and all
pre-2023 seasons), and 2018–2022 turned out to be backfillable via FastF1.

- [x] **Phase 0 — Get Monza on the phone today.** Re-ingested 2026
      Race+Sprint+Qualifying via `fetch_openf1.py`. Monza Race (`sk 11361`):
      1055 laps, 22 results. Monza Qualifying (`sk 11357`): 307 laps, 22
      results — needed for the starting-grid view. This run also backfilled
      Qualifying for every earlier 2026 race and created skeleton `Session`
      rows (zero laps, real `date_start`) for every remaining 2026 race through
      Abu Dhabi — a head start on Phase 2's countdown catalog.
      **Remaining:** commit `opentyref1.db` and get it to whatever branch/
      service Render actually deploys — see open question below.
- [x] **Phase 1a — Postgres portability (code only).** `database.py`'s
      `ensure_columns()` rewritten off SQLite-only `PRAGMA table_info` onto
      `sqlalchemy.inspect()`, so it works on both backends. Smoke-tested against
      the local SQLite, unchanged behaviour. New
      `app/ingestion/migrate_to_postgres.py` — dry-run tested, copies all 15
      tables in FK-safe order, coerces SQLite's 0/1 to real booleans, resets
      Postgres sequences after insert, skips any table already populated so
      re-runs are safe. **Blocked:** needs the real Supabase DB password and
      the session-pooler connection string (port 6543 — Render's egress is
      IPv4, Supabase's direct 5432 host is IPv6-only). Get it from Supabase →
      Project Settings → Database → Connection Pooling → "Session mode".
- [x] **Security fix, unplanned:** `backend/.env` was committed to git with no
      secret in it yet. Untracked it (`git rm --cached`) and added it to
      `.gitignore` *before* any Supabase password goes near it —
      `opentyref1/.env` stays tracked on purpose, it only holds a public URL.
- [ ] **Phase 1b — Run the migration** once the pooler string + password
      arrive: point `DATABASE_URL` at Supabase, run
      `python -m app.ingestion.migrate_to_postgres`, verify row counts, redeploy
      Render with the new `DATABASE_URL`.
- [ ] **Phase 2 — Auto-sync.** Background thread so this never goes stale
      again: `sync_session_catalog()` writes every session (incl. future ones)
      up front, `sync_recent()` ingests anything that finished >35 min ago and
      has no laps yet, on a 15 min / 6 hr loop.
- [ ] **Phase 3 — `GET /api/live/feed`.** One endpoint, three slots (featured /
      last completed / upcoming), a real session state machine
      (scheduled → running → awaiting_data → completed), reusing
      `session_live()`/`session_track()`/`upcoming_races()` rather than
      duplicating them.
- [ ] **Phase 4 — Live tab UI.** Countdown hero when a race is scheduled today,
      starting grid + track dossier while it's running (free tier has nothing
      live — that's an OpenF1 paywall, not something to route around), full
      result once it lands, last-completed + upcoming stacked below.
- [ ] **Phase 5 — All 24 seasons reachable.** Fix the `limit=60` pagination bug
      hiding 2023 (2026+2025+2024 laps sum to exactly 60 — not a coincidence,
      a cutoff). Add `GET /api/races/seasons` and outer-join pre-2023 races in
      as `RESULTS ONLY` rows with a results-table detail view, since OpenF1 has
      no timing data before 2023 by nature of the source (Jolpica is a results
      database; OpenF1 records F1's live timing feed, only captured from 2023).
- [ ] **Phase 6 — FastF1 backfill, 2018–2022 laps.** Confirmed live: laps + tyre
      compounds available from 2018 (telemetry only from 2019, stays on-demand,
      never bulk-stored). ~103 races, ~5s/race. Also fixes `fetch_fastf1.py`
      fabricating Race rows instead of linking to real ones, and adds the
      retired SUPERSOFT/ULTRASOFT/HYPERSOFT compounds to the tyre-badge map so
      they don't collide on the same letter as SOFT/HARD.

**Open question, not yet resolved:** the current branch and `main` are at the
same commit (`a4a6e36`) — nothing has diverged. Committing the refreshed
`opentyref1.db` here is safe and local, but getting Monza *live* on Render
today means either a small hotfix commit on `main`, or merging this whole
in-progress feature branch. Needs a call before pushing anything outward.

---

## Later — Strategy pitwall modules

Phase 1 of this track is done and verified (uncommitted, same branch). See the
punch list below for what's left; full original plan at
`C:\Users\ankul\.claude\plans\lets-make-a-new-nifty-sifakis.md`.

### Before testing on a phone

`opentyref1/.env` has `EXPO_PUBLIC_API_URL` pointed at the deployed Render
backend, and that always wins over LAN in dev. The pitwall endpoints only
exist on this branch, not on the deployed service. To see them live, either:

- temporarily point `EXPO_PUBLIC_API_URL` at your machine's LAN IP and run
  `backend` locally (`uvicorn app.main:app --host 0.0.0.0 --port 8000`), or
- deploy this branch to Render.

### Phase 2 — Assistant integration (not started)

Teach `backend/app/services/explain.py` to route strategy questions to
`pitwall.py` and answer with the same grounded `facts[]` shape the other
intents already use.

- Add intents/keywords for: safety car pit calls, red/yellow flag reaction,
  wet/dry crossover, overtake/defend probability, position prediction, risk.
- Each new intent needs a race + driver + lap resolved from the question or
  from context (mirror how `explain_simulation` reads `context`) — the
  pitwall modules require a `lap`, which nothing in `explain.py` currently
  parses.
- Add the new capabilities to `CAPABILITIES` (`explain.py:83`) and to
  `GET /api/ai/capabilities`'s `quickPrompts` so the app surfaces them.
- Decide whether the Assistant tab should read the same
  `usePitwallSelection()` context as the pitwall screens, the way it already
  reads `useStrategyDraft()` for the stint planner.

### Phase 3 — ERS proxy module (not started)

Ships last and behind a permanent "modelled estimate, not measured" badge —
no energy data exists anywhere in this dataset or in OpenF1's `car_data`.

- Backend: `pitwall.ers_call()` — pull one lap's `car_data` via the existing
  `openf1_client` (speed/throttle/brake), derive a rough harvest/deploy trace
  (braking zones harvest, throttle+speed zones deploy), normalise to 0–100%.
  No per-driver claims beyond "estimated from this lap's traces."
- Route: `GET /api/strategy/ers/{race_id}`.
- Frontend: `src/app/strategy/ers.tsx` using the same
  `PitwallModuleScreen`/`RecommendationCard` pattern as the other 7, plus a
  small trace chart (reuse `charts/telemetry-trace.tsx` if it fits).
- Add the 9th card back to the picker grid in `src/app/(tabs)/strategy.tsx`
  (`opentyref1/src/app/(tabs)/strategy.tsx:24`, `TYPES` array).

### Smaller things worth a look later

- `pitwall.py`'s five module-level caches (`_SC_OUTCOME_CACHE`,
  `_RED_FLAG_CACHE`, `_CROSSOVER_CACHE`, `_OVERTAKE_CACHE`, `_HAZARD_CACHE`)
  are computed lazily on first request (~3–13s cold, then fast). Fine for
  now; if it's ever annoying, warm them in `main.py`'s startup event instead.
- `neutralisation_events()` deliberately reproduces a legacy quirk in the
  original safety-car logic (a second DEPLOYED before the first clears
  silently drops the first event) to keep `safety_car_laps()` byte-identical
  for the ML training set. Worth revisiting *with a retrain* if the
  structured event list is ever used somewhere that needs the dropped event.
- The Monte Carlo (`outcome`/`risk`) freezes every rival at their real
  result — it measures variance in *this driver's* run, not a full
  what-if-everyone-raced-differently simulation. Good enough for v1; a
  multi-driver simulation would be a bigger project.
