# Leftover work

## Today — Live feed & database (in progress)

Branch: `feature/strategy-pitwall-modules`. Phases 0–2 are committed
(`ced2a2f`, `f591aa7`, `d34da6b`) — **not yet pushed anywhere**, see
"How to deploy" below. The pitwall work further down stays uncommitted, as
before; committing only touches what a commit lists, so it was never at risk.
Full plan with rationale, measured numbers, and file-level detail at
`C:\Users\ankul\.claude\plans\breezy-riding-kurzweil.md`.

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
- [x] **Phase 1a — Postgres portability (code only).** `database.py`'s
      `ensure_columns()` rewritten off SQLite-only `PRAGMA table_info` onto
      `sqlalchemy.inspect()`, so it works on both backends. New
      `app/ingestion/migrate_to_postgres.py` — copies all 15 tables in FK-safe
      order, coerces SQLite's 0/1 to real booleans, resets Postgres sequences
      after insert, skips any table already populated so re-runs are safe.
- [x] **Security fix, unplanned:** `backend/.env` was committed to git with no
      secret in it yet. Untracked it (`git rm --cached`) and added it to
      `.gitignore` *before* any Supabase password went near it —
      `opentyref1/.env` stays tracked on purpose, it only holds a public URL.
- [x] **Phase 1b — Migration run, done.** Supabase project
      `ycahkctebtuglxadtfkj` (ap-south-1), connected via the session pooler
      (port 5432 — the direct 5432 host is IPv6-only, unreachable from here or
      from Render). All 15 tables migrated with **zero row-count mismatches**
      (173,259 rows total: 105,826 laps, 22,717 overtakes, 10,803 race-control
      messages, 10,068 results, the rest smaller). Verified beyond row counts:
      inserted+deleted a throwaway row to prove sequences reset correctly (no
      PK collision), and confirmed **FK enforcement is now actually active**
      — Postgres rejected an orphan-row insert that SQLite would have silently
      allowed. Actual database size: **47 MB** (9.4% of Supabase's 500 MB free
      tier — the ~30 MB estimate in the plan undercounted Postgres's row
      overhead, doesn't change the headroom conclusion).
      Booted the real app against it and hit the actual endpoints:
      `/api/sessions/latest` → **Monza** (the reported bug, fixed and verified
      end-to-end, not just checked in the database directly).
      `/api/races?limit=90` → all 4 seasons (2023–2026) come back once the
      limit is raised past 60, confirming the Phase 5 diagnosis is exactly
      right — pure pagination cutoff, no missing data.
      `backend/.env` now holds the working `DATABASE_URL` (untracked).
      **Not done:** Render's `DATABASE_URL` env var hasn't been touched — that
      switches the live app's database and is a production change, left for
      an explicit decision rather than done unasked.
- [x] **Phase 2 — Auto-sync, done.** New `app/services/session_sync.py`,
      wired into `main.py` as a daemon thread on startup (confirmed
      non-blocking: health/session requests served while the first sync pass
      ran concurrently). `POST /api/admin/sync` (token-guarded via
      `ADMIN_SYNC_TOKEN`, unset/503 by default) for forcing a pass without a
      redeploy; `GET /api/admin/sync` reports last run time/error. All three
      token paths tested (missing/wrong/correct → 403/403/200).
      **Real bug caught and fixed during testing:** the first version called
      `ingest_year()` for the "cheap" catalog step too, which has no concept
      of "hasn't happened yet" — it attempted the full ~10-endpoint harvest
      against 20 future 2026 sessions and tripped OpenF1's rate limiter twice
      before finishing. Split into `sync_session_catalog()` (3 cheap requests,
      writes only the catalog row, never calls `ingest_session()`) and
      `sync_recent()` (the only step gated by the 35-min embargo window, reads
      candidates from what the catalog step already wrote). Re-verified: full
      pass now completes in seconds, idempotent (140 sessions, 105,826 laps,
      stable across repeated runs), zero rate-limit hits.
      **Also caught:** the catalog step initially stored sessions with no
      matching race as `race_id=NULL` orphans (10 of them). Traced to a real
      upstream gap — verified directly against Jolpica's raw API — **Jolpica's
      2026 calendar only has 23 races and skips Bahrain + Saudi Arabia
      entirely** (jumps straight from Japan, round 3, to Miami, round 4), even
      though OpenF1 has session data for both. Fixed by skipping unmatched
      sessions instead of half-storing them, matching `match_race()`'s own
      "never fabricate what isn't there" discipline. **Not fixed** (needs a
      call, not silently patched): the calendar gap itself, and a separate
      naming oddity spotted in the same table — round 16 is stored as
      "Bahrain Grand Prix in Malaysia" at Sepang (which is in Malaysia).
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

---

## How to deploy — commands to run yourself

`main` and `origin/main` are still at `a4a6e36`, unchanged — the 3 commits
above are 3 commits *ahead*, purely linear, nothing to merge or resolve.

**This is two separate stages that do different things — worth doing both,
but stage A alone already fixes what you'll see in the app:**

- **Stage A (push code)** — `backend/opentyref1.db` is still committed (with
  Monza's data now baked in), so the instant this reaches Render, the app
  stops showing Zandvoort. That's true even before touching Stage B.
- **Stage B (switch the database)** — is what makes the fix *permanent*. Until
  Render's `DATABASE_URL` points at Supabase, the auto-sync thread (Phase 2)
  writes into Render's own container filesystem — which Render wipes on every
  redeploy. Skip Stage B and the very next `git push` silently undoes Phase 2,
  resetting to whatever `opentyref1.db` was last committed. Stage B is what
  the whole Postgres migration (Phase 1) was for.

### Stage A — push to GitHub

```bash
# Backs up the branch as-is (useful regardless, e.g. for a PR later)
git push origin feature/strategy-pitwall-modules

# Fast-forwards origin's main by these 3 commits directly — safe, since main
# hasn't diverged, so this can't produce a merge conflict
git push origin feature/strategy-pitwall-modules:main

# Bring your local main pointer in sync too (doesn't touch the working tree,
# main isn't checked out right now, so your uncommitted pitwall edits are
# untouched either way)
git branch -f main feature/strategy-pitwall-modules
```

If Render is set to auto-deploy on push to `main` (its default for a
GitHub-connected service), this alone triggers a redeploy. If nothing happens
after a minute or two, go to the Render dashboard → your service → **Manual
Deploy** → **Deploy latest commit**.

Verify with:
```bash
curl https://opentyreapi.onrender.com/api/sessions/latest
```
`sessionName`/`location` should read Monza, not Zandvoort.

### Stage B — point Render at Supabase

1. Render dashboard → your backend service → **Environment** tab.
2. Add or edit `DATABASE_URL`, value:
   ```
   postgresql://postgres.ycahkctebtuglxadtfkj:AnkulTiwari%4005@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
   (Same string as `backend/.env` locally — password already URL-encoded,
   `@` → `%40`.)
3. Save. Render usually auto-redeploys on an env var change; use **Manual
   Deploy** if it doesn't.
4. *(Optional, enables `POST /api/admin/sync` in production)* also add
   `ADMIN_SYNC_TOKEN` with any random string you generate yourself — it 503s
   until this is set, which is safe, just means that one endpoint stays off
   until you want it.

Verify with:
```bash
curl https://opentyreapi.onrender.com/api/health
# {"status":"ok","database":"connected"} confirms Render is reading Postgres,
# not the baked SQLite file, the moment this differs from before Stage B.
```

**Not yet decided, no action needed today:** whether to stop committing
`backend/opentyref1.db` now that Postgres is the real source of truth (the
original Phase 1 plan called for this once the switch was live). Leaving it
committed for now costs nothing and keeps it as a working seed/backup.

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
