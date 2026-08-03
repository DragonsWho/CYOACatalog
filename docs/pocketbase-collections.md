# Database schema

## Why there is no database in this repository

The site's database is PocketBase's own SQLite file. In production it holds real user
accounts — emails, password hashes, OAuth links — so it cannot be published, and a
sanitized copy with a handful of fake users would be a liability rather than a help: it
goes stale the moment a collection changes, and a stale seed database is worse than none
because it lies convincingly.

What is published instead is the **collection schema**: the collections, their fields,
indexes and API access rules, with no rows.

## Getting a working instance

1. Build and start the server (`make build && make run`).
2. Open `http://127.0.0.1:8090/_/` and create a superuser account.
3. Go to **Settings → Import collections**, paste or upload
   `pocketbase-collections.json` from this directory, review the diff, apply.

That gives you an empty catalog with the correct shape. Create a couple of games through
the admin UI or the site's own add-game flow to have something to look at.

## Collections

Roughly what lives where. Field-level detail is in the JSON export.

| Collection | Holds |
|---|---|
| `users` | Accounts. PocketBase auth collection |
| `games` | Catalog entries: title, descriptions, tags, author links, images, flags |
| `authors` | Game authors, with aliases |
| `tags`, `tag_categories` | Tag taxonomy |
| `game_tag_votes` | Per-user votes on which tags a game should carry |
| `comments` | Comments, referencing the game they belong to |
| `hosted_games` | Games served from our own hosting: slot, version, storage location |
| `game_relationships` | Links between entries — ports, translations, sequels, remakes |
| `game_pipeline_state` | Per-game pipeline state when the harvester runs with `STATE_BACKEND=pb` |
| `mod_requests` | Moderation tickets |
| `notifications` | Per-user notification feed |
| `audit_log` | Record of moderation and administrative actions |
| `game_views` | View counters |
| `asset_fingerprints` | Image fingerprints, used for deduplication |
| `publication_settings` | Configuration for the drip-feed publication queue |

Collections prefixed with `_` are PocketBase internals (auth origins, OAuth state, MFA,
OTP, superusers) and come with the framework.

## A warning about the export

The schema is managed **by hand through the admin UI** — there are no migration files,
no versioning, and no automated way to reconcile a running database with this snapshot.
The JSON here is a point-in-time export. Where it disagrees with the running site, the
running site wins.

To refresh the export from a live instance: **Settings → Export collections** in the
admin UI, then commit the resulting file over `pocketbase-collections.json`.
