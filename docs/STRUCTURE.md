# Repository structure

This is the source for cyoa.cafe: a single Go binary (PocketBase core + custom
routes + embedded React/TypeScript frontend) plus a standalone Python
semantic-search sidecar. This document maps the repository; see
`docs/ARCHITECTURE.md` for how the pieces work together at runtime.

## Root Go files (package `main`)

All files below share one Go package — they compile into a single binary
(`dist/serve`). One-line purpose of each, read from the file itself:

| File | Purpose |
|---|---|
| `main.go` | Entry point. Configures the PocketBase app (SQLite pool sizing, JS-hook loading, OAuth2 plugin registration, username hooks), registers the `/api/custom/*` route group (comments, notifications, mod-requests, upvotes, tag-vote, Turnstile verification), serves the embedded frontend (`go:embed dist`) with Early-Hints preload headers and an inlined catalog snapshot for the SPA shell, and wires up every other `register*` call (hosting, shoutbox, publication queue, name trimming, game edits, view counter, bump roulette, SEO, push). Also handles the dev-mode reverse proxy to Vite on `:8091`. |
| `hosting.go` | Game hosting: R2 (S3-compatible) client setup, zip-upload ingestion, chunked/multipart upload for games >100MB, per-user `hosting_slug` subdomain serving (`<slug>.cyoa.cafe`), game claim flow (Turnstile-gated), moderation queue for hosted games, legacy `/play/{user}/{slug}` redirect. Largest file in the repo. |
| `game_edits.go` | Moderator-only game edit/hide/revert flow. Every mutation appends an immutable revision to `game_revisions` (and archives any storage files it displaces under `revisions/<gameId>/<revisionId>/...`); nothing is ever hard-deleted. |
| `bump_roulette.go` | "Bump roulette" — a community raffle where users spend a daily vote ticket (up to 3 per game per account) on a game; a periodic cron draw picks one ticket uniformly at random and bumps that game to the top of the catalog (30-day per-user lockout after voting). Auto-creates its own collections (`bump_votes`, `bump_draws`, `bump_settings`) on boot. |
| `push.go` | Web Push (VAPID) subscription management and notification sending. Subscriptions live in `push_subscriptions` (not publicly readable). Includes the `serve push-keys` CLI subcommand for one-time VAPID key generation. |
| `publication_queue.go` | Drip-feed publication cron: promotes queued items from `game_pipeline_state` into the public `games` collection on a timer/singleton-settings basis. |
| `publication_queue_api.go` | Moderator-only HTTP endpoints for the `/moderator/queue` panel (list/inspect queue items). Reads the admin-only `game_pipeline_state` / `publication_settings` collections via the privileged app instance, checking `isModerator` itself. |
| `seo.go` | Serves `/robots.txt` and `/sitemap.xml` (registered before the SPA catch-all so they aren't swallowed by it). |
| `slug.go` | Pretty game-slug generation (`/game/<slug>`), NFKD-normalize + ASCII-fold algorithm that must stay byte-identical to the Python counterpart `PB/slugify.py`. |
| `usernames.go` | Produces sane usernames on OAuth sign-up (Discord/OIDC names often fail the username pattern or collide with PocketBase's generated `usersNNNNNN`) and enforces "change username once." |
| `trim_names.go` | Normalizes leading/trailing/collapsed whitespace in game titles at the PocketBase record-hook level, so every write path (add-game form, nightly pipeline, admin scripts) gets the same cleanup without being patched individually. |
| `view_counter.go` | First-party, same-origin page-view counter per game (ad-blocker-resistant, unlike GA). Stores counts in its own additive `game_views` collection; surfaced only in the moderator stats panel for now. |
| `reserved.go` | Site-wide reserved-word/slug list (e.g. usernames or hosting slugs that must not be claimed). |
| `overload.go` | In-flight request limiter for `/api/*` (excludes `/api/realtime` and `/api/health`). Turns database overload into fast 503s instead of a multi-minute collapse; added after a 2026-07-26 incident where slow SQLite queries caused unbounded handler pileup and swap thrashing. |
| `pprof.go` | Loopback-only (`127.0.0.1:6060`) Go `pprof` HTTP endpoint for heap/goroutine introspection, reachable only via SSH port-forward. Added after the same 2026-07-26 incident to diagnose "where did the memory go." |
| `cheat.go` | Embeds `cheat_shim.js` (via `go:embed`) — the script injected into a hosted game's `index.html` when the request carries `?__cheat=1`. See `hosting.go`'s `serveFromR2`/inject path for where it's spliced in. |
| `shoutbox.go` | Site mini-chat ("shoutbox") v1: single `shoutbox_messages` collection (writes are backend-only; reads/realtime use PocketBase's normal list/subscribe). Feature-flagged by `SHOUTBOX_ENABLED`; disabled → all chat endpoints 404 and the frontend hides the UI. Anti-spam state is in-memory (resets on restart). |
| `shoutbox_v2.go` | Delta on top of `shoutbox.go`: channels (including closed/private ones), an anonymous toggle for logged-in users, a guest password for deleting one's own message, image reactions, and a "who's here now" presence list. Kept in a separate file because it only adds new routes; it doesn't touch the v1 POST path. |
| `aliases_test.go` | Tests `normalizeAliases` — must match `_split_aliases` in the harvester's `agent_ops.py` (both split game-title aliases on newline only; commas are legal inside a title). |
| `overload_test.go` | Tests the in-flight limiter (`overload.go`) against a real router handler using `httptest`. |
| `slug_test.go` | Shared test vectors with `PB/slugify.py` — the Go and Python slugifiers must agree byte-for-byte. |
| `trim_names_test.go` | Tests `normalizeName` whitespace/NBSP/zero-width/BOM stripping. |
| `usernames_test.go` | Tests `cleanOAuthName`, in particular Discord's legacy `#0`/`#NNNN` discriminator stripping. |

## `src/` — React/TypeScript frontend

Built with Vite, UI on MUI (`@mui/material` v6) plus Tailwind utility classes.

| Path | Contents |
|---|---|
| `src/App.tsx` | Route table (`react-router-dom`) and top-level layout/providers; most screens are lazy-loaded. |
| `src/main.tsx` | React entry point / root render. |
| `src/theme.ts` | MUI theme definition. |
| `src/types.tsx` | Shared TypeScript types. |
| `src/pocketbase/pocketbase.ts` | The single `PocketBase` client instance (`new PocketBase(window.location.origin)`), auth-store staleness handling (drops the token on a 401, probes on a 403 — see file comment for the "likes stopped working" failure mode), shared React contexts. |
| `src/pocketbase/bumpRouletteApi.ts` | Client wrapper for the bump-roulette endpoints. |
| `src/pocketbase/__mocks__/` | Test mocks for the PocketBase client. |
| `src/push/pushClient.ts`, `src/push/PushBell.tsx` | Web Push subscription client + bell UI. |
| `src/components/Add/` | Legacy/manual "create game" form pieces: author selector, tag selector, image cropper/compressor/splitter, cover uploader. |
| `src/components/AddGame/` | Current add-game flow (`/create`): `AddGamePage.tsx` (entry), `SuggestLink.tsx` (submit a URL for the intake pipeline), `ManualCreate.tsx` (manual fallback form). |
| `src/components/Announcements/` | Site announcement banner + a `/log` page listing past announcements. |
| `src/components/ChatLab/` | Experimental chat UI sandbox (`/chat-lab`). |
| `src/components/CheatLab/` | Cheat-companion iframe harness (`/cheat-lab`) — stages a hosted game in an iframe and drives `cheat_shim.js` via `useCheatBridge.ts`. |
| `src/components/CyoaPage/` | Game detail page (`/game/:id`): `GameDetails.tsx`, tag display/voting (`TagCategory.tsx`, `TagChip.tsx`, `tagVoteApi.ts`), bump-vote widget, related games, cheat-companion drawer, edit dialog, `Comments/` (see below), language switcher for multilingual variants. |
| `src/components/CyoaPage/Comments/` | Comment thread UI + `buildsApi.ts` (cheat-companion "build" posts attached to comments). |
| `src/components/Footer/` | Site footer, Patreon/Boosty icon components. |
| `src/components/Header/` | The unified header used at every viewport: search bar, login/verification/recovery dialogs, user menu, NSFW filter switch, legal pages (`Legal/`), external social links. |
| `src/components/Hosting/` | Self-hosting UI (`/hosting`) — upload a game to the user's own `<slug>.cyoa.cafe`. |
| `src/components/Moderation/` | `mod_requests` ticket panel (dead-link / missing-images / update-version / duplicate reports). |
| `src/components/ModeratorPanel/` | Moderator-only screens: pipeline review (`PipelineReviewPanel.tsx`), publication queue (`PublicationQueuePanel.tsx`), roulette admin, view-count stats, relationship editor, tag moderation, community suggestions. |
| `src/components/Notifications/` | Notification bell + its API client. |
| `src/components/Profile/` | Account settings, avatar upload/crop, liked games, blocked games/tags. |
| `src/components/Roulette/` | Public bump-roulette page (`/roulette`). |
| `src/components/Search/` | Catalog grid (`GameGrid.tsx`), full catalog search (`SearchPage.tsx`), semantic/natural-language search (`SemanticSearchPage.tsx`, `VectorSearchPage.tsx`) — these call the semantic-search sidecar, not the Go backend. |
| `src/components/Shoutbox/` | Shoutbox chat widget, anonymous-identity handling, rich-text rendering, API client. |
| `src/utils/` | Cross-cutting helpers: alias parsing, GA4 analytics wrapper, image blur-placeholder, Cloudflare image URL builder, cheat-companion helpers, fuzzy search, view-count client, language preference, tag color/usage helpers, viewport-scale hook. |
| `src/styles/` | Global CSS. |
| `index.html` | Vite entry HTML / SPA shell (this is what `main.go` reads and rewrites at request time to inline the catalog snapshot and per-page OG/meta tags). |

## Other top-level directories

| Path | Contents |
|---|---|
| `pb_hooks/` | PocketBase JS (JSVM/goja) hooks, loaded from disk at runtime — **not** compiled into the Go binary, so they hot-reload without a rebuild. `pipeline_review.pb.js` implements the `/api/pipeline/review/*` and `/api/pipeline/submit` endpoints (moderator review of intake pipeline items) plus tag-voting record logic; each `routerAdd` handler runs in its own isolated goja runtime with no access to top-level file scope (see the file's header comment for the full list of JSVM gotchas: `getBool`/`getString`/`findFirstRecordByFilter` panic at the Go level, no global `URL`, etc.). `test_script_hello.pb.js` is a minimal `onBootstrap` hook used as a smoke test / example. |
| `public/` | Static assets served as-is: favicons, web app manifest, `sw.js` (service worker), `like.lottie` animation, `placeholder.jpg`, `catalog-playground.html` (a standalone dev/debug page), `icons/`. |
| `e2e/` | Playwright end-to-end tests. `tests/` covers auth, comments, games, profile, and shoutbox flows; `helpers/` has login and raw-PocketBase-API helpers; `global-setup.ts`/`global-teardown.ts` prepare a dedicated test PocketBase instance; `constants.ts` holds shared test constants. Run via `make test` (which builds first) or `make test-ui`. |
| `semantic-search/` | Standalone Python/FastAPI service — natural-language and "similar games" search. Not part of the Go binary; deployed and run separately. See `docs/ARCHITECTURE.md` for how it's wired to the site, and the files below. |
| `docs/specs/` | Historical design specs, written in Russian, kept for the reasoning behind subsystems (`hosting.md`, `publication_pipeline_architecture.md`, `publication_queue_spec.md`). Not necessarily current — cross-check against actual code before trusting. See `docs/specs/README.md`. |
| `docs/` | Current documentation, including this file, `ARCHITECTURE.md`, and `analytics-events.md` (GA4 event catalog + first-party view counter). |

### `semantic-search/` contents

| File | Purpose |
|---|---|
| `server.py` | The FastAPI app: `GET /api/semantic-search`, `GET /api/similar-games/{id}`, `GET /healthz`; background thread re-syncs the index against PocketBase every `SYNC_HOURS`. |
| `lib_embed.py` | Embedding client (Gemini) with disk cache and rate pacing. |
| `build_catalog_index.py` | One-off/rebuild script that builds the index from local game rips. |
| `build_index.py`, `search.py` | Earlier pilot index-builder and CLI search tool (see `STATUS.md`). |
| `backfill_descriptions.py` | One-time script that wrote `rich_description` into PocketBase for the existing catalog. |
| `gen_descriptions.py` | Bulk/backfill generator for `rich_description` text via an LLM prompt. |
| `eval.py`, `eval_desc_model.py`, `nn_report.py`, `nn_overlay.py`, `test_models.py` | Evaluation/reporting scripts for search quality and embedding model comparisons. |
| `prompt_description.txt`, `prompt_description_v2.txt` | LLM prompts used to generate `rich_description` text. |
| `golden_queries.json`, `queries.tsv` | Golden query set and query log for evaluation. |
| `index/` (not listed above, generated) | `catalog_vecs.npy` + `catalog_meta.json` — the actual on-disk index, row-aligned by content hash. |
| `README_DEPLOY.md` | Deploy/rollout runbook for this service (schema migration, backfill, systemd cutover). |
| `STATUS.md` | Historical pilot notes/status (quota findings, prompt design discussion) — dated, treat as a snapshot not current state. |
| `semantic-search-v2.service` | systemd unit file. |
| `Makefile` | Deploy/reindex targets for this service (separate from the root `Makefile`). |

## Build/config files (root)

| File | Purpose |
|---|---|
| `Makefile` | Canonical build/dev/deploy entry points — see `docs/ARCHITECTURE.md` for what each target does. |
| `vite.config.ts` | Vite build config; dev-server proxy rules (`/api` → `https://cyoa.cafe`, `/api/semantic-search`, `/api/similar-games`, `/stats`, `/games` → `127.0.0.1:8100`). |
| `flake.nix` / `flake.lock` | Nix dev shell providing `bun` and `go`. |
| `tsconfig.json` | Root TS project — references `tsconfig.app.json` and `tsconfig.node.json`. |
| `tsconfig.app.json` | TypeScript compiler options for `src/` (ES2020 target, bundler module resolution, strict mode, no-emit). |
| `tsconfig.node.json` | TypeScript config for Node-context config files (e.g. `vite.config.ts`). |
| `tsconfig.e2e.json` | TypeScript config for the Playwright e2e suite. |
| `package.json` | Frontend/Node dependencies and scripts (`dev`, `build`, `lint`, `preview`); package manager is `bun` (`bun.lockb` present). Note: its `build` script differs slightly from the Makefile's `build` target — the Makefile is the one used for `make build`/`make ship`. |
| `go.mod` / `go.sum` | Go module definition and lockfile. Key dependency: `github.com/pocketbase/pocketbase v0.36.7` (see `docs/ARCHITECTURE.md` for what this pins). Also: AWS SDK v2 (`aws-sdk-go-v2` + S3, for R2), `webpush-go` (VAPID push), a private fork `github.com/DragonsWho/pocketbase-ext-oauth2` (OAuth2 plugin), `spf13/cobra` (CLI), `golang.org/x/text` (Unicode normalization for slugs). |
| `eslint.config.js` | ESLint flat config for the frontend. |
| `postcss.config.js`, `tailwind.config.js` | Tailwind/PostCSS setup (used alongside MUI). |
| `.prettierrc` | Prettier formatting config. |
| `.env.example` | Template for the root `.env` consumed by the Go binary (see `docs/ARCHITECTURE.md`'s Environment Variables section). |
| `.envrc` | direnv hook (loads the Nix flake shell). |
| `playwright.config.ts` | Playwright e2e test runner config. |
