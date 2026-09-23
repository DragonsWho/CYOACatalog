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
- `semantic-search/` — embeddings search service (Python, FastAPI), deployed separately.
- `pb_scripts/` — PocketBase schema/data change scripts; `seed.go` builds a local dev DB.
- `e2e/` — Playwright tests.

## Build and run

Requirements: Go 1.25+, Node 18+ with npm, Python 3 (for `pb_scripts/` only).

```bash
make install   # frontend dependencies (npm ci, from package-lock.json)
make seed      # local DB: schema from pb_schema.json + today's public catalog from cyoa.cafe
make dev       # open http://localhost:8090 — local API + Vite hot reload
make check     # type check + go vet + go test (writes nothing)
make test      # Playwright end-to-end tests against a throwaway copy of the local DB
make build     # tsc + vite build + go build → dist/serve
```

`make seed` never copies users. It creates local accounts instead: `admin@local.test` /
`localadmin123` (PocketBase admin UI at `/_/`), `user@local.test` / `localuser123`,
`moder@local.test` / `localmoder123` (moderator). Details, and what does not work locally, are in
[AGENTS.md](AGENTS.md) — written for AI coding agents, equally useful for humans.

⚠️ Use port **8090**. Vite's own port 8091 proxies `/api` to the **production** site.

Semantic search and "similar games" come from the service in `semantic-search/` (port 8100 in dev).
The rest of the site works without it.

`make build` first runs `update-oauth`, which pulls the forked OAuth2 plugin
(`github.com/DragonsWho/pocketbase-ext-oauth2`, forum SSO) and may touch `go.mod`;
`make build-app` skips that.

## Data

`pb_schema.json` is a sanitized snapshot of the production collections (no system collections,
no secrets). The maintainer refreshes it after every deploy and schema change, so `make seed` stays
current. Don't edit it by hand: schema changes are Python scripts in `pb_scripts/`
(see [pb_scripts/README.md](pb_scripts/README.md)), tested locally and applied to production by the
maintainer.

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

## License

Apache-2.0 — see [LICENSE](LICENSE). The name "cyoa.cafe" is not covered by the license.
