# Codex working agreement

This repository has two distinct editing surfaces. Keep them separate.

## Dashboard UI and application code

- Work from the repository root on a `type/short-description` branch. Never push directly to `main`.
- Read `CLAUDE.md` and the relevant file under `docs/` before changing code.
- Dashboard UI lives in `frontend/src/dashboard/`. The plan editor lives in `frontend/src/plan-editor/`.
- Keep each page's `main.ts` thin and put behavior in responsibility-specific modules.
- Run `npm run ci` before opening a pull request.
- A merged `main` deploys the frontend automatically. API deployment follows `docs/deploy.md`.

## Trip and itinerary data

- Production MySQL is the source of truth. Do not edit `frontend/public/trip-config.js` or local JSON to change an itinerary.
- Prefer the authenticated plan editor for ordinary itinerary changes. It preserves authorization, validation, and optimistic locking.
- For Codex-assisted bulk changes, use `npm run plan:data -- ...`; read `docs/codex-data-editing.md` first.
- A public export is read-only evidence. Never apply it because private collections are intentionally absent.
- A database apply must start from a fresh database export, keep its `plan.version`, run without `--commit` first, and create a backup before committing.
- Direct database access requires the configured SSH tunnel. If SSH authentication is unavailable, stop and use the authenticated browser editor instead of weakening MySQL exposure or host-key checks.
- Never print, commit, or copy `.env`, session cookies, database passwords, API keys, or LINE secrets into issues or pull requests.

## Target trip

The current China trip is identified by title `中国旅行`, slug `trip-8`, and plan ID `pln_mspsd9p901a`. Resolve it again from the current API or database before every write; IDs and versions can change.
