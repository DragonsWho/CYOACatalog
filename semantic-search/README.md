# Semantic search service

Powers `/api/semantic-search` (natural-language catalog search) and `/api/similar-games/{id}`
("Similar games" strip). A small FastAPI app on port 8100, next to the main server; the site's
reverse proxy routes those two paths to it.

- **Index:** one vector per game (Google `gemini-embedding-001`, 1536 dims, numpy, cosine).
  Text = the hidden `games.rich_description` field, else title + description.
- **Self-updating:** a background thread re-syncs with PocketBase every `SYNC_HOURS` (fetches as
  superuser to read the hidden field), embeds only new/changed texts, drops removed games, and
  swaps the index atomically. No manual reindex after publishing.
- **Safety valve:** if more than 20% of texts change in one sync (usually broken creds/schema),
  the sync aborts; `SYNC_FORCE=1` overrides. An empty index (fresh install) builds without it.
- **Costs:** every vector is disk-cached by text hash (`cache_vectors/`), queries are normalized
  and rate-limited per IP (`RATE_MAX`/`RATE_WINDOW`).

## Run

```bash
pip install -r requirements.txt
make serve-local            # needs .env: GOOGLE_API_KEY (+ PB_SUPERUSER_EMAIL/PASSWORD for sync)
```

Env knobs: `SYNC_HOURS` (0 = off), `INDEX_DIR`, `EMBED_CACHE_DIR`, `EMBED_KEYS_FILE`,
`EMBED_MIN_INTERVAL`, `SITE_API_URL`, `SIMILAR_TOP_K`, `SIMILAR_MIN_COS`.

## Deploy

`make deploy-setup` once (venv + systemd unit `semantic-search-v2.service`), then `make deploy`
for code updates. Uses `SSH_HOST` from the untracked `../deploy.mk`.

`queries.tsv` (query log) is written next to the server and stays out of git.
