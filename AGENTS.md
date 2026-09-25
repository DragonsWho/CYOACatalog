# AGENTS.md — working on cyoa.cafe

Instructions for AI coding agents (and humans) working in this repository. The maintainer may give
you extra local instructions on top of this file.

## What this is

The source of [cyoa.cafe](https://cyoa.cafe), a catalog of CYOA games. One Go binary: a
[PocketBase](https://pocketbase.io) app (SQLite) with custom routes in `*.go`, plus a React/TypeScript
SPA (`src/`, Vite, MUI) embedded into it. `pb_hooks/*.pb.js` are read from disk at runtime.
`semantic-search/` is a separate Python service. See README.md for the layout.

## Run it locally

Requirements: Go 1.25+, Node 20+ with npm, Python 3.

```bash
npm ci            # or: make install
make seed         # build pb_data/ (takes ~1 min, downloads covers of the newest 300 games)
make dev          # then open http://localhost:8090
```

- `make seed` builds the DB from `pb_schema.json` (production schema, sanitized) and copies the
  public catalog (tag categories, tags, authors, newest games + covers) from cyoa.cafe's public API.
  `SEED_ARGS="--games 0"` copies all games, `--no-images` skips covers. An existing `pb_data/` is
  moved to `pb_data.bak-<date>/`, never deleted. Re-seed whenever you want a fresh copy.
- Local accounts (they exist only in your seeded DB):

  | role | email | password |
  |---|---|---|
  | PocketBase superuser (`/_/`) | `admin@local.test` | `localadmin123` |
  | user | `user@local.test` | `localuser123` |
  | moderator (full access) | `moder@local.test` | `localmoder123` |

- The maintainer checkout uses :8090/:8091. The Codex clone uses :8190/:8191 through `DEV_PORT`
  and `VITE_PORT`. Always browse the Go server port, never the Vite port: Vite proxies `/api` to
  the **production** site, so writes made through it affect the live site.
- No `.env` is needed. Copy `.env.example` to `.env` to turn features on, e.g. `SHOUTBOX_ENABLED=1`
  for the chat.

### What does not work locally (expected, not bugs)

- Cover images first request `/cdn-cgi/image/...` (Cloudflare resizing), get 404 and fall back to
  the original file. Covers still show.
- Static games have no page scans (the seed copies covers only); interactive games load from the
  production hosting domain.
- Semantic search and "similar games" need the service in `semantic-search/` on :8100 plus an
  embeddings API key. Without it those widgets are empty.
- Game hosting uploads, cache purge, web push and forum SSO need production credentials.
- Games have no comments, upvotes or uploaders: users are never copied.

## Check your work

```bash
make check        # tsc (no emit) + go vet + go test — run before every commit
make test         # Playwright e2e: builds dist/, runs a throwaway PocketBase on a copy of pb_data
```

e2e needs a seeded `pb_data/` and Chromium (`npx playwright install chromium` once).

## Rules

- Comments and docs are English, short, and explain *why*. No Cyrillic in code. The pre-commit hook
  enforces this — enable it once per clone: `git config core.hooksPath .githooks`. Never use
  `--no-verify`.
- Never commit secrets, `.env`, `pb_data/` or production data. Never put the server's IP anywhere.
- Don't edit `pb_schema.json` by hand, and don't change the schema from Go/JS code. Schema and bulk
  data changes are scripts in `pb_scripts/` — see `pb_scripts/README.md`.
- Maintainer-only targets — don't run: `make ship`, `ship-codex`, `pb-prod`, `schema-snapshot`,
  `cf-purge`, `update-oauth`, `logs`, `ssh`, `server-env`, anything in `semantic-search/Makefile` that deploys.
- Keep diffs focused; match the surrounding code style. UI text is English.
- Commit when a piece of work is done and `make check` passes, with a message saying what and why.

## Codex clone workflow

These machine-local rules apply in `/data/codex-cyoa-cafe`:

- Work only on the `codex` branch; never commit to `main`. The maintainer updates the local `main`
  branch. Start every task with `git rebase main && make check`. The check and dev targets refresh
  `node_modules` automatically when `package-lock.json` changes.
- When a piece of work is complete and `make check` passes, commit it to `codex`. The maintainer
  reviews and merges it from her checkout. This clone cannot push to GitHub, which is expected.
- Use :8190 for the Go server and :8191 for Vite. `DEV_PORT`, `VITE_PORT`, and `PB_URL` are normally
  set in the environment. If they are missing, run
  `make dev DEV_PORT=8190 VITE_PORT=8191` and set `PB_URL=http://127.0.0.1:8190` for local scripts.
- On the first run, use `make seed`, then `make dev`, and browse http://localhost:8190. Dependencies
  are installed already, and caches live under `/data/codex-cache`.
- If Git reports dubious ownership, run
  `git config --global --add safe.directory /data/codex-cyoa-cafe`.
- For database schema, rule, or bulk-data changes, add a script under `pb_scripts/` following
  `pb_scripts/README.md`. Test with `make pb-local S=...`, then `APPLY=1`, then a final dry run.
  Commit the script and include `apply with make pb-prod S=pb_scripts/<file>.py` in the final report.
  Never connect to production from this clone.
- Finish every task with a short report covering changes, tests, and any maintainer action such as a
  `pb-prod` script, `.env` variable, or deploy step.
