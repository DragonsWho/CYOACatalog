# Architecture

This document describes how cyoa.cafe is put together, based on reading the
code in this repository. Where something could not be confirmed from the
repo (e.g. edge/CDN/nginx configuration, which lives outside this checkout),
it is marked "not verified".

## 1. High-level shape

cyoa.cafe runs as **one Go binary** (`dist/serve`) that is:

1. A [PocketBase](https://pocketbase.io) application — `pocketbase.NewWithConfig(...)`
   in `main.go` — which gives the app its SQLite database, the standard
   PocketBase REST API (`/api/collections/...`), auth, realtime subscriptions,
   file storage, and the `_/` admin UI, all "for free."
   `go.mod` pins `github.com/pocketbase/pocketbase v0.36.7`.
2. A set of **custom Go routes** registered on top of that same router
   (`e.Router` / `se.Router`) across the other root `.go` files — hosting,
   comments/notifications, tag voting, shoutbox, publication queue, bump
   roulette, SEO, push, etc. These are plain PocketBase route handlers, not a
   separate HTTP server.
3. The **built frontend**, embedded into the binary at compile time via
   `//go:embed dist` (`main.go`, top of file) and served as static files /
   SPA fallback in production. In development the same binary instead reverse
   proxies unmatched requests to a locally running Vite dev server on
   `:8091` (see §7).

A second, independent process — the **semantic-search sidecar**
(`semantic-search/server.py`, FastAPI) — runs on `127.0.0.1:8100` and serves
natural-language and "similar games" search. It talks to PocketBase over the
public REST API as a superuser; the Go binary has no code path that talks to
it or proxies it (confirmed: no `semantic-search`/`similar-games` route
exists in any `.go` file). See §5.

```
Browser
  │
  ├─ cyoa.cafe/*                 → Go binary :8090 (PocketBase + custom routes + embedded SPA)
  │     ├─ /api/collections/...  → PocketBase's built-in collections REST API
  │     ├─ /api/custom/...       → main.go route group (comments, notifications, mod-requests, tag-vote, ...)
  │     ├─ /api/hosting/...      → hosting.go
  │     ├─ /api/pipeline/review* /submit → pb_hooks/pipeline_review.pb.js (JSVM, not compiled Go)
  │     ├─ /api/pipeline/queue/* → publication_queue_api.go
  │     ├─ /oauth2/...           → pocketbase-ext-oauth2 plugin
  │     └─ everything else       → embedded SPA shell (index.html + assets)
  │
  ├─ <username>.cyoa.cafe/*      → same Go binary, routed by Host header (hosting.go) → game files in R2
  │
  └─ cyoa.cafe/api/semantic-search, /api/similar-games/{id}
        → NOT handled by the Go binary. Per the deployment setup, these paths are
          proxied at the edge (nginx) to the sidecar on 127.0.0.1:8100. No nginx
          config is checked into this repo, so the exact proxy rule is not verified
          here — see semantic-search/README_DEPLOY.md and STATUS.md for the
          sidecar's own account of this.
```

Cloudflare sits in front of the origin (cache rules, Turnstile, R2 access,
Early Hints). Its rule configuration is not part of this repository.

## 2. Request routing inside the Go binary

`main.go`'s `app.OnServe().BindFunc(...)` is where most top-level wiring
happens, roughly in this order:

1. `startPprof(...)` — loopback-only pprof listener (`pprof.go`).
2. `registerOverloadGuard(...)` — in-flight request limiter for `/api/*`
   (`overload.go`), registered first so a rejection costs almost nothing.
3. Auth-request logging middleware.
4. The `/api/custom` route group (comments, notifications, mod-requests,
   upvotes, tag-vote, Turnstile verification) — all inline in `main.go`.
5. `registerSEORoutes` (`seo.go`) — `/robots.txt`, `/sitemap.xml`, registered
   before the catch-all routes so they aren't swallowed by the SPA fallback.
6. `registerPushRoutes` (`push.go`).
7. The dev-vs-prod branch: either the Vite reverse proxy, or the embedded
   `dist` filesystem with `/assets/*` served with immutable cache headers and
   the SPA shell served for everything else (with the catalog snapshot and
   per-page OG/meta tags spliced in — see §2.1).

Outside that block, `main()` also calls, in order: `registerHostingRoutes`,
`registerShoutbox`, `registerPublicationQueue` + `registerPublicationQueueAPI`,
`registerNameTrim`, `registerGameEdits`, `registerViewCounter`,
`registerBumpRoulette`, `registerCatalogSnapshotRefresh`,
`registerSitemapInvalidation`.

`hosting.go` additionally installs its own `se.Router.BindFunc` middleware
that inspects the `Host` header on *every* request: if the host resolves to a
known `hosting_slug` subdomain, the request is routed to game-file serving
from R2 instead of the normal app routes (see §4). This is why the whole
game-hosting feature works without any separate reverse proxy or DNS-level
routing beyond a wildcard CNAME.

### 2.1 Catalog snapshot inlining and per-page SEO

To avoid an empty-shell-then-pop-in first paint, `main.go` maintains an
in-memory `catalogSnap` (`catalogSnapshot` struct) — a pre-rendered
`<script>window.__CATALOG__=[...]</script>` tag holding the default,
SFW-filtered, `-created`-sorted first page of the catalog. It's rebuilt on a
5-minute timer and immediately after any new game is published
(`registerCatalogSnapshotRefresh`, an `OnRecordAfterCreateSuccess("games")`
hook), and inlined into `index.html` before `</head>` on every SPA-shell
response. A `cfPurger` coalesces a burst of publishes into a single
Cloudflare cache purge call (uses `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID`).

The same response path also injects per-route Open Graph/Twitter meta tags
and a real `<title>` (`buildSocialMeta`, `staticPageMeta` map in `main.go`)
so link previews and crawlers see correct content without running React, and
sets `X-Robots-Tag: noindex` for paths in `noindexPaths` (`chat-lab`,
`cheat-lab`, `moderator`, `profile`).

## 3. Data access patterns

- **Frontend → PocketBase collections API directly**: most reads (catalog
  listing, tags, authors, likes, etc.) go straight to PocketBase's built-in
  `/api/collections/<name>/records` endpoints via the `pocketbase` JS SDK
  client instantiated once in `src/pocketbase/pocketbase.ts` as
  `new PocketBase(window.location.origin)`. Collection-level `listRule` /
  `viewRule` / `createRule` in the PocketBase schema (not in this repo's Go
  code) govern what anonymous vs. authenticated vs. moderator users can do
  through this path.
- **Frontend → custom Go endpoints**: anything that needs server-enforced
  business logic beyond a plain collection rule — comments (with pinning and
  like-counting), notifications, moderation-request tickets, upvotes,
  tag-vote tallying with "gold tag" denormalization, hosting, game edits/
  revisions, shoutbox, publication queue, bump roulette, view counting. These
  live under `/api/custom/*`, `/api/hosting/*`, `/api/pipeline/queue/*`, etc.
- **Frontend → PocketBase JSVM hooks**: `pb_hooks/pipeline_review.pb.js`
  implements `/api/pipeline/review*` and `/api/pipeline/submit` — moderator
  review of intake-pipeline items and the tag-vote persistence logic. These
  are loaded from disk at boot (`jsvm.MustRegister(app, jsvm.Config{HooksDir:
  "pb_hooks"})` in `main.go`) rather than compiled into the binary, so they
  can be hot-patched on the server without a redeploy.
- **Frontend → semantic-search sidecar**: `SemanticSearchPage.tsx` /
  `VectorSearchPage.tsx` call `/api/semantic-search` and
  `/api/similar-games/{id}`, which (per §1) are not Go routes — they reach
  the Python service at the edge.
- **Session integrity**: the client treats a `401` on any authenticated
  request as "token is dead" and clears the auth store; a `403` triggers a
  background probe of the auth-refresh endpoint rather than an immediate
  logout, because Cloudflare/WAF can itself answer 403 for a dead token
  before PocketBase gets a chance to say 401 (see the long comment in
  `src/pocketbase/pocketbase.ts`).

## 4. Game hosting (`hosting.go`)

Hosting stores game files in **Cloudflare R2** (S3-compatible) via
`aws-sdk-go-v2`'s S3 client, configured against
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` with region `"auto"`
(`newR2Client`). If the R2 env vars are unset, `newR2Client` returns `nil` and
`registerHostingRoutes` disables all hosting routes at boot rather than
failing to start.

Key mechanics:

- **Per-user subdomain routing.** Every user has a `hosting_slug`
  (`users.hosting_slug`). A request's `Host` header is matched against known
  slugs (`extractSubdomain` + the `hosting.go` middleware described in §2);
  `<slug>.cyoa.cafe/<game-slug>/<path>` is resolved by looking up the
  `hosted_games` record (`owner = ... && slug = ... && status = 'active'`),
  cached in an in-memory `lookupCache`, then served from R2 under
  `games/<hosting_slug>/<game-slug>/<path>` (`r2GamePrefix`,
  `serveFromR2`). `<slug>.cyoa.cafe/` alone serves the user's landing page
  (`handleLanding`).
- **Direct (small) upload**: `POST /api/hosting/upload` accepts a zip
  (capped at `maxZipSize = 200<<20`, 200MB, and `maxFiles = 10000`), unpacks
  it, validates extensions against an allow-list (`allowedExtensions`), and
  writes objects to R2.
- **Chunked upload for large games**: `POST /api/hosting/admin/upload-part`
  (superuser/God-Mode only) accepts a game in multiple part-requests to get
  around the edge's ~100MB single-request limit, up to
  `maxChunkedGameSize = 512<<20` (512MB) total. The client protocol this
  expects is documented at the harvester side
  (`tools/big_upload_chunked/chunked_upload.py`, not in this repo).
- **Admin/mirror upload**: `POST /api/hosting/admin/upload` — superuser-only,
  used by the harvester's mirror stage to publish games on behalf of any user
  by `hosting_slug`, bypassing normal per-user limits; `force=true` bumps the
  version counter.
- **Claim flow**: `POST /api/hosting/claim/generate` /
  `/api/hosting/claim/verify` — Turnstile-gated (`TURNSTILE_SITE_KEY` /
  `TURNSTILE_SECRET_KEY`) proof that a user controls a given slug/game before
  it's attached to their account.
- **HTML injection on serve**: `serveFromR2` can splice extra script tags
  into an HTML response when the request carries `?__save=1` (save-state
  shim) or `?__cheat=1` (`cheat.go`'s embedded `cheat_shim.js` — the cheat
  companion, see §6) — but only for files up to `maxInjectSize = 32<<20`
  (32MB), since injection requires holding the file (and a second copy while
  patching) fully in memory; larger files are served untouched, streamed.
- **Moderation**: `GET /api/hosting/mod/queue`, `POST
  /api/hosting/mod/block/{id}` / `/mod/restore/{id}`, `DELETE
  /api/hosting/mod/purge/{id}` — moderator tooling over hosted games,
  including full R2 cleanup and Cloudflare cache purge on delete.
- **Legacy compatibility**: `GET /play/{username}/{slug}/{path...}` 301s to
  the current `<hosting_slug>.cyoa.cafe/<slug>/<path>` form.

## 5. Semantic search (`semantic-search/`)

A standalone FastAPI process, **not** part of the Go binary, run separately
(e.g. via `uvicorn server:app --host 127.0.0.1 --port 8100`, per the
docstring in `server.py`, and the included `semantic-search-v2.service`
systemd unit).

- **Model**: `gemini-embedding-001` at 1536 dimensions (`lib_embed.py`
  handles the embed calls, with disk caching and rate pacing).
- **Index**: plain numpy — `index/catalog_vecs.npy` (float32 vectors,
  L2-normalized) + `index/catalog_meta.json` (row-aligned metadata: id,
  title, source, snippet, content hash). No vector DB/FAISS in the current
  version (that was the prior `cyoa_embendings/` system this replaced, per
  `README_DEPLOY.md`).
- **Sync with PocketBase**: a background thread (`_sync_loop`) calls
  `sync_index()` every `SYNC_HOURS` (default 24). It authenticates as a
  PocketBase superuser (`PB_SUPERUSER_EMAIL`/`PB_SUPERUSER_PASSWORD`, or
  legacy `EMAIL`/`PASSWORD`), fetches all `games` records including the
  hidden `rich_description` field, computes a text (rich_description if
  >100 chars, else `title + description`) and its hash, reuses the stored
  vector for unchanged text, embeds only new/changed text, and atomically
  swaps in the new index (write to `.tmp`, `os.replace`). Games with
  `hidden=true` are excluded. A safety guard aborts the sync (without
  `SYNC_FORCE=1`) if more than 20% of texts changed in one pass, treating
  that as a sign of a schema/credential problem rather than legitimate churn.
- **Endpoints**: `GET /api/semantic-search?q=...&mode=...` (mode is accepted
  but currently ignored — description-only search),
  `GET /api/similar-games/{game_id}` (nearest neighbours to a game's own
  stored vector — no embed call needed since vectors are pre-normalized),
  `GET /healthz` (index size, dim, last sync time).
- **Rate limiting**: a per-IP sliding-window limiter (`RATE_MAX` per
  `RATE_WINDOW` seconds, defaults 60/60s), trusting `X-Forwarded-For`/
  `X-Real-IP` since every connection arrives from nginx as `127.0.0.1`.
- **Source of truth**: PocketBase (`games.rich_description`, a hidden field
  never sent to anonymous clients). Publishing a game (the drip-feed queue
  writing `rich_description`) makes it searchable within the next sync, no
  manual reindex step required.
- **Go backend involvement**: none. The Go binary neither calls this service
  nor proxies it; routing `/api/semantic-search` and `/api/similar-games/*`
  to port 8100 is an edge/nginx concern outside this repository (not
  verified here — see `semantic-search/README_DEPLOY.md`).

## 6. Key features and where they live

| Feature | Frontend | Backend |
|---|---|---|
| Catalog browse/filter | `src/components/Search/SearchPage.tsx`, `GameGrid.tsx` | PocketBase `games` collection API directly; default view seeded by the inlined catalog snapshot (§2.1) |
| Semantic / natural-language search | `src/components/Search/SemanticSearchPage.tsx`, `VectorSearchPage.tsx` | `semantic-search/server.py` (§5) |
| Tags + tag voting | `src/components/CyoaPage/TagCategory.tsx`, `TagChip.tsx`, `tagVoteApi.ts` | `pb_hooks/pipeline_review.pb.js` (vote tally, gold-tag denormalization) |
| Likes / upvotes | — | `POST /api/custom/upvotes/{id}` (`main.go`) |
| Comments | `src/components/CyoaPage/Comments/` | `POST /api/custom/comments`, `/comments/delete`, `/comments/pin`, `/comments/{id}/like`, `/comments/edit` (`main.go`) |
| Notifications | `src/components/Notifications/` | `POST /api/custom/notifications/read` (`main.go`) |
| Moderation tickets | `src/components/Moderation/ModRequestsPanel.tsx` | `POST /api/custom/mod-requests/update` (`main.go`) |
| Shoutbox / site chat | `src/components/Shoutbox/`, `src/components/ChatLab/` | `shoutbox.go` (v1) + `shoutbox_v2.go` (channels, anon toggle, guest delete password, reactions, presence); feature-flagged by `SHOUTBOX_ENABLED` |
| Push notifications | `src/push/` | `push.go` (VAPID, `push_subscriptions` collection) |
| Moderation / pipeline review | `src/components/ModeratorPanel/PipelineReviewPanel.tsx` | `pb_hooks/pipeline_review.pb.js` (`/api/pipeline/review*`, `/submit`) |
| Publication queue (drip-feed) | `src/components/ModeratorPanel/PublicationQueuePanel.tsx` | `publication_queue.go` (cron that promotes queue → `games`), `publication_queue_api.go` (panel endpoints) |
| Bump roulette | `src/components/Roulette/RoulettePage.tsx`, `src/components/ModeratorPanel/RoulettePanel.tsx` | `bump_roulette.go` |
| Pretty game slugs | routing in `src/App.tsx` (`/game/:id`, id may be a slug) | `slug.go` (must match `PB/slugify.py` byte-for-byte, outside this repo) |
| Multilingual game variants | `src/components/CyoaPage/LanguageSwitcher.tsx` | PocketBase `game_variants`-style relations (schema, not in this repo's Go code) |
| Cheat companion (build/save shim) | `src/components/CheatLab/`, `CyoaCompanionDrawer.tsx`, `src/utils/cheat.ts` | `cheat.go` (embeds `cheat_shim.js`), injected by `hosting.go`'s `serveFromR2` on `?__cheat=1` |
| Game edit / hide / revert | `src/components/CyoaPage/GameEditDialog.tsx` | `game_edits.go` (append-only `game_revisions`, archived file copies) |
| View counting | moderator stats panel (`ViewStatsPanel.tsx`) | `view_counter.go` (`game_views` collection) |
| Self-service game hosting | `src/components/Hosting/Hosting.tsx` | `hosting.go` (§4) |

## 7. Build and deploy (`Makefile`)

| Target | What it does |
|---|---|
| `make install` | `bun i` — installs frontend dependencies. |
| `make dev` | Runs the Go server (`go run . serve`, `NODE_ENV=development`) and the Vite dev server (`vite --port 8091`) concurrently. **The Go server in this mode reverse-proxies unmatched requests to Vite on :8091, and Vite's own dev proxy (`vite.config.ts`) forwards `/api` to `https://cyoa.cafe` (production)** — so `make dev` talks to the live production PocketBase API for everything except `/api/semantic-search`/`/api/similar-games`/`/stats`/`/games`, which it proxies to `127.0.0.1:8100`. This is convenient for frontend-only work but means **`make dev` does not exercise the local backend at all**. |
| `make build` | Runs `update-oauth` first (see below), removes any existing `dist/serve`, type-checks (`tsc -b`), builds the frontend (`vite build`), then compiles the Go binary (`go build -buildvcs=false -o dist/serve .`, `CGO_ENABLED=0`). This produces a real local binary — **use `make build && make run` to actually test backend changes**, since `make dev` bypasses the local backend entirely. |
| `make run` | Runs the just-built binary: `./dist/serve serve --dir ./pb_data`, on PocketBase's default port `:8090`. |
| `make update-oauth` | Fetches the latest commit of the private fork `github.com/DragonsWho/pocketbase-ext-oauth2` from GitHub (bypassing the Go module proxy cache via `GOPROXY=direct`) and runs `go mod tidy`. Run automatically before `build` and `ship`. |
| `make cf-purge` | Purges specific Cloudflare cache entries (home, key static paths, `/assets/` and a list of app-route prefixes) via the Cloudflare API, using `CLOUDFLARE_ZONE_ID`/`CLOUDFLARE_API_TOKEN`. |
| `make open-incognito` | Opens `https://cyoa.cafe` in an incognito Chrome window (post-deploy manual check). |
| `make ship` | The deploy target: cross-compiles for `linux/amd64` (`GOOS=linux GOARCH=amd64`) to `dist/serve-linux`, SCPs it to the remote host (`SSH_HOST`, default `root@your-server.example.com` — override via `.env` or CLI) plus the `pb_hooks/*.pb.js` files (which are **not** embedded in the binary and must ship separately as they're read from disk on the server), atomically renames it into place, restarts the `cyoa-cafe` systemd service, then runs `cf-purge` and `open-incognito`. |
| `make logs` | Tails the remote systemd service journal (`journalctl -u cyoa-cafe -f -n 100`). |
| `make test` | Builds first, then runs the Playwright e2e suite (`e2e/tests/*.spec.ts`) headlessly against a dedicated test PocketBase instance. |
| `make test-ui` | Same, but with the Playwright UI (trace viewer, watch mode). |
| `make test-report` | Shows the last HTML Playwright report without re-running tests. |
| `make update-local` | `git pull` + `bun i --frozen-lockfile` + `make build` + restart the local systemd service — a same-host update path, distinct from `make ship`'s remote-deploy path. |

`SSH_HOST`, `SERVICE_NAME` (`cyoa-cafe`), and `REMOTE_DIR`
(`/root/cyoa-cafe`) are the deploy-target variables at the top of the
Makefile; `SSH_HOST` in particular must be overridden (via `.env` or the
command line) since the checked-in default is a placeholder.

`package.json` also defines `dev`/`build`/`preview` npm scripts that overlap
with the Makefile targets, but the Makefile is the canonical path (it's what
`make build`/`make ship` actually run); the package.json `build` script
compiles with a slightly different `go build` invocation and is not
guaranteed to stay in sync.

## 8. Environment variables (`.env.example`)

All of these are read via `os.Getenv` somewhere in the root `.go` files
unless noted otherwise. Grouped by subsystem, in the order they appear in
`.env.example` plus additional variables found only in code (not present in
the example file).

| Variable | Read in | Purpose |
|---|---|---|
| `NODE_ENV` | `main.go`, `hosting.go` | `"development"` switches the server into dev mode: reverse-proxies to Vite on `:8091` instead of serving the embedded `dist`, and allows the hosting subdomain middleware to be overridden via a `?_host=` query param (since local dev has no real subdomains). Anything else (including unset) is treated as production. |
| `PB_LOG_LEVEL` | `main.go` | Auth-tracing log verbosity: `trace \| debug \| info \| warn \| error`. |
| `PB_DEBUG` | `main.go` | Set to `"1"` to force debug-level logging regardless of `PB_LOG_LEVEL`. |
| `TURNSTILE_SECRET_KEY` | `main.go`, `hosting.go` | Cloudflare Turnstile server-side secret, used to verify captcha tokens on comment/hosting-claim submissions. |
| `TURNSTILE_SITE_KEY` | `hosting.go` | Turnstile client-side site key, injected into the hosted-game claim page. |
| `CLOUDFLARE_API_TOKEN` | `main.go`, `hosting.go` | API token used to issue Cloudflare cache-purge calls (catalog snapshot changes, hosting deletes). |
| `CLOUDFLARE_ZONE_ID` | `main.go`, `hosting.go` | The Cloudflare zone to purge against. |
| `SHOUTBOX_ENABLED` | `shoutbox.go` | Feature flag for the site chat. Empty/`0` → all shoutbox endpoints 404 and the frontend hides the UI. |
| `SHOUTBOX_ANON_SALT` | `shoutbox.go` | Salt for deriving an anonymous user's `anon_key`. Must be set to a real secret in production — without it the key can be brute-forced from IP alone. |
| `SHOUTBOX_WORD_FILTER` | `shoutbox.go` | Comma-separated stop-word list for chat message filtering (kept out of the repo). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `push.go` | Web Push (VAPID) key pair. Generated once via `./dist/serve push-keys`. Rotating these invalidates every existing push subscription (browsers won't reissue them automatically). |
| `VAPID_SUBJECT` | `push.go` | Contact URI (`mailto:`) required by the Web Push protocol; example default `mailto:admin@cyoa.cafe`. |
| `R2_ACCOUNT_ID` | `hosting.go` | Cloudflare account ID, used to build the R2 S3-compatible endpoint URL. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | `hosting.go` | R2 API credentials for the S3 client. |
| `R2_BUCKET_NAME` | `hosting.go` | R2 bucket used for all hosted-game storage. |

### Additional variables used in code but not listed in `.env.example`

| Variable | Read in | Purpose |
|---|---|---|
| `PB_APP_URL` | `main.go` | Overrides `app.Settings().Meta.AppURL` before the OAuth2 plugin registers, so its OpenID discovery `issuer` reflects the real production URL instead of freezing on PocketBase's `http://localhost:8090` default (the plugin builds discovery metadata synchronously at `Register()`, before settings load from the DB). |
| `PB_SQLITE_CACHE_KB` | `main.go` (`envInt`) | Per-connection SQLite page cache size in KB (default 4000). |
| `PB_DATA_MAX_OPEN_CONNS` / `PB_DATA_MAX_IDLE_CONNS` | `main.go` | Pool size for PocketBase's main data DB connection (defaults 10/5). |
| `PB_AUX_MAX_OPEN_CONNS` / `PB_AUX_MAX_IDLE_CONNS` | `main.go` | Pool size for PocketBase's auxiliary DB connection (defaults 4/2). |
| `OVERLOAD_MAX_INFLIGHT` | `overload.go` | Max concurrent `/api/*` requests before the limiter starts returning 503. |
| `PPROF_ADDR` | `pprof.go` | Override for the loopback pprof listener address (defaults to `127.0.0.1:6060`, bound loopback-only for safety — never exposed to `0.0.0.0`). |

### Semantic-search sidecar's own environment (separate `.env`, not the root one)

Read directly in `semantic-search/server.py` / `lib_embed.py`, not by the Go
binary: `GOOGLE_API_KEY` (embedding API key), `PB_SUPERUSER_EMAIL` /
`PB_SUPERUSER_PASSWORD` (or legacy `EMAIL`/`PASSWORD`) for authenticating
against the PocketBase REST API, `SITE_API_URL` (defaults to
`https://cyoa.cafe/api`), `SYNC_HOURS`, `SIMILAR_TOP_K`, `SIMILAR_MIN_COS`,
`RATE_MAX`, `RATE_WINDOW`, `EMBED_MIN_INTERVAL`, `SYNC_FORCE`. This service
loads its env from its own `.env` (falling back to a parent-directory
`.env`) in addition to process environment — see `server.py`'s `_load_env`/
`_env` helpers.

## 9. Notable design decisions found in code comments

- **Embed target is `dist`, not `all:dist`.** `go:embed all:dist` would also
  pick up dotfiles/underscore files, including `.fuse_hidden*` copies left
  behind by ntfs-3g when the binary replaces `dist/serve` while it's still
  running — bloating the binary with a stale self-copy. Real frontend build
  output never starts with `.`/`_`, so plain `dist` is sufficient and safer.
- **In-flight request limiter (`overload.go`) and the loopback pprof
  endpoint (`pprof.go`) both trace back to a specific 2026-07-26 incident**
  where slowed-down SQLite queries turned ~7 requests/sec into ~200
  concurrently-held handlers, causing swap thrashing. The limiter caps
  concurrent `/api/*` handlers (excluding `/api/realtime` and `/api/health`);
  pprof exists purely so a future recurrence can be diagnosed ("where," not
  just "how much").
- **JS hooks are loaded from disk, not embedded**, specifically so they can
  be hot-patched on the server without a full binary rebuild/redeploy — this
  is also why `make ship` copies `pb_hooks/*.pb.js` via `scp` as a separate
  step from shipping the binary.
- **No hard deletes for game edits** (`game_edits.go`): every mutation is an
  append-only revision plus an archived copy of any displaced storage file,
  because R2 has no bucket versioning of its own.
