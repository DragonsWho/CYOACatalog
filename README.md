# CYOA Cafe — catalog site

Source of [cyoa.cafe](https://cyoa.cafe): a public catalog of CYOA games. Users browse, submit, tag,
upvote, comment, chat, and host games on `<author>.cyoa.cafe` subdomains.

This repository exists so the site can be rebuilt if the original maintainer disappears. It holds
everything needed to build and run the server. It does **not** hold the database: user accounts are
not shared, and a catalog dump may be published separately.

**Stack:** Go + [PocketBase](https://pocketbase.io) (single binary, SQLite) · React/TypeScript
(Vite, MUI) embedded into the binary · Cloudflare (CDN, R2 for hosted game files).

## Layout

- `*.go` — the server: a PocketBase app with custom routes (game hosting, chat, tag voting,
  moderation, SEO pages, web push, bump roulette). Entry point: `main.go`.
- `src/` — the React SPA. `vite build` output (`dist/`) is embedded via `//go:embed`.
- `pb_hooks/` — PocketBase JS hooks, read from disk at runtime (NOT embedded).
- `cheat_shim.js` — script injected into hosted games for the build saver / cheat companion.
- `public/` — static assets copied into the build.

## Build and run

Requirements: Go 1.25+, Bun (or npm).

```bash
make install   # frontend dependencies
make dev       # PocketBase on :8090 + Vite HMR on :8091
make build     # tsc + vite build + go build → dist/serve
make run       # ./dist/serve serve --dir ./pb_data
```

⚠️ In `make dev`, Vite proxies `/api` to the **production** site (see `vite.config.ts`). Only `/all`
goes to the local server. Point that proxy at `http://127.0.0.1:8090` to work against a local database.

Semantic search and "similar games" (`/api/semantic-search`, `/api/similar-games`) come from a
separate embeddings service (port 8100 in dev). It is not part of this repository; the rest of the
site works without it.

`make build` first runs `update-oauth`, which pulls the forked OAuth2 plugin
(`github.com/DragonsWho/pocketbase-ext-oauth2`). It is used for forum SSO.

## Data

The server expects a PocketBase data directory (`pb_data/`) with the site's collections
(games, tags, authors, comments, users, chat, …). Starting on an empty directory boots PocketBase,
but the catalog UI needs that schema. Restore from a PocketBase backup or catalog dump. Some
collections (e.g. `game_views`) are created automatically on boot.

## Configuration

Copy `.env.example` to `.env`. Everything is optional for local development. Production needs:
- Cloudflare R2 credentials (game hosting);
- Turnstile keys;
- a Cloudflare API token (cache purge);
- VAPID keys (`./dist/serve push-keys`);
- a unique `SHOUTBOX_ANON_SALT`.

## Deploy

`make ship` cross-compiles for linux/amd64, uploads the binary and hooks over SSH, restarts the
systemd service and purges the Cloudflare cache. The SSH target is read from an untracked
`deploy.mk`:

```make
SSH_HOST := root@<origin-ip>
```

Keep the origin address private: the site relies on Cloudflare in front of it.
