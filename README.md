# cyoa.cafe

Catalog and hosting platform for CYOA games — interactive "Choose Your Own Adventure"
projects that live as self-contained web pages. The site indexes them, hosts them, and
lets people find, play, rate and discuss them.

Runs in production at [cyoa.cafe](https://cyoa.cafe).

This repository holds the whole serving side of the product:

| Directory | What it is |
|---|---|
| `src/` | Frontend — React 18 + TypeScript + MUI, built with Vite |
| `*.go` (repo root) | Backend — Go, built on [PocketBase](https://pocketbase.io) as a framework |
| `pb_hooks/` | PocketBase JavaScript hooks, loaded from disk at runtime |
| `semantic-search/` | Semantic search service — Python, FastAPI, Gemini embeddings |
| `docs/` | Architecture, repository map, CDN configuration |
| `e2e/` | Playwright end-to-end tests |

The pipeline that *fills* the catalog — crawling, downloading, optimizing and
publishing games — is a separate project with its own repository.

## How it fits together

One Go binary is the whole server. It embeds PocketBase (SQLite database, REST API,
authentication, admin UI), adds the site's own HTTP routes on top, and serves the
compiled frontend through `go:embed`. There is no separate API process and no Node
runtime in production.

Two things run beside it:

- **Semantic search** — a small FastAPI process bound to `127.0.0.1:8100`. nginx routes
  `/api/semantic-search` and `/api/similar-games/{id}` to it. The Go backend is not
  involved in those requests at all.
- **Cloudflare** — CDN and cache in front of everything. See
  [`docs/cdn-cache.md`](docs/cdn-cache.md); the cache rules are load-bearing and easy to
  get subtly wrong.

Game files live in Cloudflare R2 and are served from `<slug>.cyoa.cafe`.

Deeper detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). File-by-file map:
[`docs/STRUCTURE.md`](docs/STRUCTURE.md).

## Requirements

- Go 1.25+
- Node 20+ or [Bun](https://bun.sh/) — build only, not needed at runtime
- Python 3.11+ — only if you are working on `semantic-search/`

## Getting started

```bash
cp .env.example .env      # fill in what you need — see Configuration below
make install              # install frontend dependencies
make build                # tsc + vite build + go build -> ./dist/serve
make run                  # serve on http://127.0.0.1:8090
```

`main.go` embeds the built frontend with `//go:embed dist`, and `dist/` is generated, not
committed. A bare `go build` on a fresh clone therefore fails — always go through
`make build`, which runs the frontend build first.

On first start, open `http://127.0.0.1:8090/_/` and create a superuser. The database is
created empty in `pb_data/`; see [Database schema](#database-schema) to get the
collections in place.

### Development loop

```bash
make dev                  # Vite on :8091 + `go run` on :8090
```

> **`make dev` proxies API calls to the production instance.** It exists for frontend
> work against real data. Any change to Go code or to `pb_hooks/` must be tested with
> `make build && make run` on `:8090` instead — `make dev` never exercises your local
> backend, and the failure mode is that your change appears to do nothing.

### Tests

```bash
go test ./...             # Go unit tests
make test                 # Playwright end-to-end (builds first)
```

## Configuration

Every setting comes from environment variables read from `.env` at startup.
[`.env.example`](.env.example) has the complete annotated list. The ones that cause
quiet misbehaviour when missing:

| Variable | Needed for |
|---|---|
| `PB_APP_URL` | Absolute links in emails, push notifications, SEO tags |
| `R2_*` | Game hosting storage — uploads fail without it |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` | Purging the CDN when a game is re-uploaded |
| `TURNSTILE_*` | Bot protection on the game-claim flow |
| `VAPID_*` | Web push. Rotating these invalidates every existing subscription |
| `SHOUTBOX_ENABLED`, `SHOUTBOX_ANON_SALT` | Site chat. Disabled → endpoints 404 and the UI hides itself |

Email delivery (verification, password reset) is configured in the PocketBase admin UI
under Settings → Mail, not through environment variables.

## Database schema

The database is PocketBase's own SQLite file under `pb_data/`. This repository ships no
database — it would contain real user accounts.

To bring an instance up with the right collections, import the schema snapshot from the
admin UI: **Settings → Import collections**. See
[`docs/pocketbase-collections.md`](docs/pocketbase-collections.md) for the collection
list and the procedure.

The schema has no automated migration story: it is managed by hand through the admin UI,
and the snapshot is a point-in-time export. Read it as documentation of intent, not as a
guaranteed mirror of what production runs today.

## Deployment

```bash
make ship SSH_HOST=root@your-server
```

`make ship` copies **only the compiled binary** `dist/serve` and restarts the service.
`pb_hooks/` is read from disk on the server and is *not* embedded in the binary —
changing a hook means shipping that file separately and restarting.

The semantic search service deploys on its own; see
[`semantic-search/README_DEPLOY.md`](semantic-search/README_DEPLOY.md).

## Status and expectations

This is a working production system for one specific site, not a product you can deploy
for your own catalog without effort. Parts of it are wired to cyoa.cafe by name: the
Cloudflare zone, the R2 buckets, the game subdomain scheme. There is no multi-tenant
story and no upgrade path between schema versions.

It is published so the code can be read, learned from and borrowed — not as a supported
release. Issues and pull requests are welcome; there is no roadmap commitment behind
them.

## License

[Apache License 2.0](LICENSE). You may use, modify and redistribute this code, including
in closed-source and commercial work, as long as you keep the license and attribution and
state what you changed. Nothing here obliges you to publish code you build on top of it.

The license covers this source code only. It grants no rights to the "cyoa.cafe" name or
branding, and it says nothing about the game content hosted on the site — that belongs to
its respective authors.
