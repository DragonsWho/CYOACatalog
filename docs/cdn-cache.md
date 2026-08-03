# CDN / cache configuration

The site sits behind Cloudflare. This document records the cache configuration the
production zone runs, and — more importantly — *why* each rule exists, so the setup
can be recreated on another zone or audited after a change.

No credentials, zone IDs or account identifiers are stored in this repository. The
rules below are applied through the Cloudflare dashboard (Caching → Cache Rules) or
the Rulesets API with a token scoped to `Zone → Cache Rules → Edit`.

## The one thing that breaks everyone's mental model

With **Cache Rules** (the current engine) the **last matching rule wins** — the one
lowest in the list. This is the opposite of the legacy Page Rules, where the first
match won.

Design consequence: **broad rules go on top, narrow exceptions go at the bottom.**
A bypass rule placed above a caching rule does nothing.

## The origin already sets correct headers

The Go backend emits deliberate `Cache-Control` headers, and purges the CDN itself
when a game is re-uploaded. Cache rules should mostly *respect* those headers rather
than override them. Overriding is what caused stale comments, stale likes and stale
game versions in the past.

| Resource | Set in | Header |
|---|---|---|
| `/assets/*` (Vite hashed bundles) | `main.go` | `public, max-age=31536000, immutable` |
| Hosted game entry page | `hosting.go` | `public, max-age=0, s-maxage=31536000, must-revalidate` |
| Hosted game assets | `hosting.go` | `public, max-age=600, s-maxage=31536000` |
| Dynamic pages | `hosting.go` | `no-cache, no-store, must-revalidate` |
| New game version uploaded | `hosting.go` | calls the Cloudflare purge API directly |
| PocketBase REST API | — | no cache headers (default: not cached) |

## Rule set (top to bottom; remember the bottom one wins)

### R1 — Frontend static assets · respect origin
Match: `host = cyoa.cafe` AND (path starts with `/assets/` OR path is `/favicon.ico`
OR a static file extension).
Action: cache ON, edge TTL and browser TTL both `respect_origin`.

Vite puts content hashes in asset filenames, so a one-year cache is safe. Respecting
the origin here also overrides the zone-wide Browser Cache TTL, which would otherwise
cut asset caching down to two minutes.

### R2 — PocketBase media `/api/files/` · cache 31 days (override)
Match: `host = cyoa.cafe` AND path starts with `/api/files/`.
Action: cache ON, edge TTL 31d, browser TTL 31d, override origin.

This is roughly 98% of the bytes served. PocketBase file names are stable, so a hard
cache is safe. Override rather than respect, because PocketBase sends no cache headers
of its own and the hit ratio matters here more than anywhere else.

Caveat: this assumes no `protected: true` file fields exist in the schema (all files
are public — covers, screenshots, avatars). If private files are ever added, extend the
match with `not http.request.uri.query contains "token="`.

### R3 — Hosted games on subdomains · respect origin
Match: host ends with `.cyoa.cafe`, excluding `www`, `forum`, and the retired auth
subdomains.
Action: cache ON, edge and browser TTL `respect_origin`.

Games live at `<slug>.cyoa.cafe` on versioned paths, and the backend purges on upload.
Respecting the origin is both the safest and the most aggressive option here.

### R4a — API lookup tables (tags / authors / categories) · edge 1 day
Match: `host = cyoa.cafe` AND **no `Authorization` header** AND path starts with
`/api/collections/{tag_categories|authors|tags}/records`.
Action: cache ON, edge TTL 1d, browser TTL 0, override.

These change rarely. Caching them at the edge takes real load off PocketBase, while a
zero browser TTL keeps clients honest.

### R4b — API game list / records · edge 5 minutes
Match: `host = cyoa.cafe` AND **no `Authorization` header** AND path starts with
`/api/collections/games/records`.
Action: cache ON, edge TTL 300s, browser TTL 0, override.

Catalog and search lag by at most five minutes; PocketBase load drops sharply.

> **Why R4 excludes authorized requests.** PocketBase is stateless: a logged-in client
> sends `Authorization: Bearer …`, and moderators or authors receive *non-public* games
> (drafts, items under review) from the same endpoint. Caching such a response would
> leak it to anonymous visitors. Cloudflare documents that a request carrying
> `Authorization` is only cacheable when the origin sends `s-maxage`/`public`/
> `must-revalidate` — which PocketBase does not — but the interaction with an `override`
> edge TTL is not guaranteed by the docs. So R4a/R4b match only requests without the
> header: `not any(http.request.headers["authorization"][*] ne "")`.
>
> The gate is deliberately surgical rather than a zone-wide bypass on `Authorization`.
> R1–R3 serve public, immutable content and should stay cached for logged-in users too.

### R5 — BYPASS: dynamic, user-scoped, forum
Match: `host = forum.cyoa.cafe`, or on `cyoa.cafe` any of `/api/realtime`, `/api/batch`,
`/api/custom/`, `/api/hosting/`, `…/users/…`, `…/comments/…`, `…/game_tag_votes/…`,
`…/game_relationships/…`.
Action: cache OFF.

Guarantees that likes, comments, profiles, tokens, publishing and realtime are always
live.

### R7 — Chat pulse · respect origin (10s)
Match: `host = cyoa.cafe` AND path is **exactly** `/api/custom/shoutbox/pulse`.
Action: cache ON, edge and browser TTL `respect_origin` (the backend sends
`public, max-age=10, stale-while-revalidate=50`).

**Position is critical: this rule must sit BELOW R5.** R5 disables caching for all of
`/api/custom/`, and the lowest matching rule wins — placed above R5 this rule would
never take effect.

Rationale: this is the only request a page makes when the chat panel is closed, and it
fires in the header for every visitor. The response is byte-identical for everyone (an
online counter plus last-message timestamps for public channels; private rooms are
deliberately excluded, and unread counts are computed client-side). Serving it from the
edge means the origin sees one request per ten seconds regardless of traffic.

Verify after applying:

```
curl -sI https://cyoa.cafe/api/custom/shoutbox/pulse | grep -i cf-cache-status
```

The second call onward should report `HIT`. A persistent `BYPASS` means the rule is
above R5 or disabled.

## Anything not matched

Requests matching no rule fall through to Cloudflare defaults, which do not cache HTML
or JSON. That covers `index.html`, SPA routes and the rest of the PocketBase API — so a
frontend deploy is visible immediately, with no "Purge Everything" needed.

## Zone-level settings

| Setting | Value | Note |
|---|---|---|
| Cache Reserve | **Paused** | No measurable hit-ratio benefit for this workload; it was pure cost. |
| Tiered Cache | Smart, ON | Keep. |
| Caching Level | Standard | |
| Browser Cache TTL | 2 minutes | Per-rule TTLs override this; R1 in particular. |

## Operational notes

- Take a full backup of the zone's cache rules before changing anything — the rule set
  is applied atomically, so a backup restores the previous state in one call.
- Purging on game upload is automatic (`hosting.go`); manual purges should not be part
  of any routine.
