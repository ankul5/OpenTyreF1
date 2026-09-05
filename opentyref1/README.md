# OpenTyreF1 — Mobile App

React Native (Expo SDK 54, Expo Go compatible) mobile client for OpenTyreF1. See `../DocumentsF1/OpenTyreF1_PRD_Implementation_Plan.md` for the full product plan and phased build order.

## Running the app

The backend must be running first (see `../backend/README.md` if present, or below).

```bash
npm install
npx expo start
```

Scan the QR code with **Expo Go** (SDK 54 build) on a physical device, or press `a`/`i` for an emulator/simulator.

`EXPO_PUBLIC_API_URL` in `.env` must point at your machine's LAN IP (not `localhost`) when testing on a physical device, since `localhost` on the phone points at the phone itself. Run `ipconfig` (Windows) to find the current IP if it changes.

## Backend + data

```bash
cd ../backend
python -m venv venv && venv\Scripts\activate   # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

To (re-)backfill the driver/race database from Jolpica-F1 (2002–present):

```bash
python -m app.ingestion.fetch_jolpica --all
```

This is idempotent — safe to re-run any time; it only fills in missing seasons/races/results rather than duplicating what's already there.

## Database: SQLite now, Supabase later

The backend runs on SQLite (`backend/opentyref1.db`) by default — zero setup, works offline, fine for a 25-season backfill. The code is already database-agnostic (SQLAlchemy + a single `DATABASE_URL`), so moving to Supabase later is a one-line change, not a rewrite:

1. Create a Supabase project, grab its Postgres connection string (Project Settings → Database → Connection string, "URI" mode).
2. Set `DATABASE_URL` in `backend/.env` to that string. `postgres://` URIs are auto-normalized to `postgresql://` for SQLAlchemy in `app/config.py`.
3. Run the backend once — `Base.metadata.create_all` creates the schema on the new database automatically.
4. Re-run the Jolpica backfill (`python -m app.ingestion.fetch_jolpica --all`) against the new database.

Do this migration deliberately when you're ready to share a hosted backend — not required for local development or an Expo Go demo, and Phase 5 explicitly recommends keeping the demo network-independent.

## EAS (builds + OTA updates)

Expo Go does **not** support EAS Update — OTA updates only ever reach a development or production **build**, never Expo Go. The project is pre-configured (`eas.json`, `runtimeVersion` policy, `expo-updates` installed) so a build is one login away:

```bash
npm install --global eas-cli
eas login
eas init                                            # links this project, writes your real EAS project ID
eas build --profile development --platform android  # first build; use --profile preview for an installable APK to share
```

`eas init` overwrites the `REPLACE_WITH_EAS_PROJECT_ID` placeholders in `app.json` (`extra.eas.projectId`, `updates.url`) with your real project ID — don't hand-edit those first.

Once a development/preview build is installed on-device, ship an OTA update with:

```bash
eas update --channel development --message "describe the change"
```

## Design system

All UI tokens (color, type, spacing, radius) live in `src/constants/theme.ts` — one locked palette, one accent (F1 red, used once per screen), Barlow Condensed for display type, Manrope for body/UI, IBM Plex Mono for every numeral. Don't introduce new colors or ad-hoc radii in a screen; add a token instead.
