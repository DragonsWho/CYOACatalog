# AGENTS.md — working on cyoa.cafe

Instructions for AI coding agents (and humans) working in this repository. The maintainer may give
you extra local instructions on top of this file.

## What this is

The source of [cyoa.cafe](https://cyoa.cafe), a catalog of CYOA games. One Go binary: a
[PocketBase](https://pocketbase.io) app (SQLite) with custom routes in `*.go`, plus a React/TypeScript
SPA (`src/`, Vite, MUI) embedded into it. `pb_hooks/*.pb.js` are read from disk at runtime.
`semantic-search/` is a separate Python service. See README.md for the layout.

## Run it locally

Requirements: Go 1.25+, Node 18+ with npm (or Bun), Python 3.

```bash
npm ci            # or: make install (bun)
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

- ⚠️ Always use **:8090**. `make dev` also starts Vite on :8091, and Vite proxies `/api` to the
  **production** site: anything you do there reads and writes the live site.
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
  `cf-purge`, `update-oauth`, `logs`, anything in `semantic-search/Makefile` that deploys.
- Keep diffs focused; match the surrounding code style. UI text is English.
- Commit when a piece of work is done and `make check` passes, with a message saying what and why.
