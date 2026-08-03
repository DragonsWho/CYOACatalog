"""
Semantic-search HTTP server v2 for cyoa.cafe — replaces cyoa_embendings/main.py.

Serves a catalog-only index and keeps it fresh AUTONOMOUSLY: a background
thread re-syncs against PocketBase every SYNC_HOURS (default 24):

  - fetches all games as superuser (incl. the HIDDEN `rich_description` field);
  - description text = rich_description, else title+description fallback;
  - games whose text hash is already in the index reuse their vector;
  - new/changed texts are embedded (gemini-embedding-001 @ 1536);
  - games removed from the catalog drop out of the index;
  - result is swapped in atomically and persisted to index/ (tmp+rename).

So publishing a game (drip-feed queue writes rich_description to games)
makes it searchable within a day with no manual reindex.

index/catalog_meta.json rows: {id, title, source, snippet, h}
`id` is the real PocketBase record id — the frontend resolves it directly.

API (same shape the frontend already expects):
  GET /api/semantic-search?q=...&mode=...   mode accepted, ignored (desc-only)
  GET /api/similar-games/{id}               neighbours by stored vector (no embed)
  GET /healthz

Queries are normalised (trim+lowercase) to lift the disk-cache hit rate, and a
generous per-IP sliding-window rate limit (RATE_MAX/RATE_WINDOW) keeps scripts
from burning the paid embed quota.

.env next to this file (or process env): GOOGLE_API_KEY,
PB_SUPERUSER_EMAIL/PB_SUPERUSER_PASSWORD (или EMAIL/PASSWORD как в старой
системе), опционально SITE_API_URL (default https://cyoa.cafe/api).

Run:  uvicorn server:app --host 127.0.0.1 --port 8100
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request

# Queries are single texts from live users — don't apply batch-build pacing.
# The daily sync shares this pacing; a big first sync may hit 429, lib_embed
# retries with backoff, so it self-heals.
os.environ.setdefault("EMBED_MIN_INTERVAL", "0.5")
import lib_embed  # noqa: E402

PILOT = Path(__file__).resolve().parent
INDEX = PILOT / "index"
LOG = PILOT / "queries.tsv"

TOP_K = 20
MIN_COS = 0.45
# similar-games compares two catalog vectors (related games sit far higher than
# a free-text query↔doc match), so it gets its own, stricter floor.
SIMILAR_TOP_K = int(os.environ.get("SIMILAR_TOP_K", "12"))
SIMILAR_MIN_COS = float(os.environ.get("SIMILAR_MIN_COS", "0.55"))
SYNC_HOURS = float(os.environ.get("SYNC_HOURS", "24"))

# Per-IP rate limit (sliding window). Generous — meant to stop scripts/bots
# hammering the paid embed call, not to bother humans. Identical repeated
# queries are already free (lib_embed disk-caches every query vector), so this
# mainly caps *distinct* query floods. Tune via env.
RATE_MAX = int(os.environ.get("RATE_MAX", "60"))          # requests…
RATE_WINDOW = float(os.environ.get("RATE_WINDOW", "60"))  # …per this many sec
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def _load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


# later files win only for keys missing earlier; process env wins overall
_FILE_ENV = {**_load_env(PILOT.parent / ".env"), **_load_env(PILOT / ".env")}


def _env(*names: str) -> str | None:
    for n in names:
        if os.environ.get(n):
            return os.environ[n]
    for n in names:
        if _FILE_ENV.get(n):
            return _FILE_ENV[n]
    return None


PB_API = (_env("SITE_API_URL") or "https://cyoa.cafe/api").rstrip("/")


def _pb_json(path: str, data: dict | None = None, token: str | None = None) -> dict:
    headers = {"User-Agent": UA, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    req = urllib.request.Request(
        f"{PB_API}{path}",
        data=json.dumps(data).encode() if data is not None else None,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _pb_token() -> str:
    email = _env("PB_SUPERUSER_EMAIL", "EMAIL")
    pwd = _env("PB_SUPERUSER_PASSWORD", "PASSWORD")
    if not (email and pwd):
        raise RuntimeError("no PB superuser creds in env/.env")
    d = _pb_json("/collections/_superusers/auth-with-password",
                 {"identity": email, "password": pwd})
    return d["token"]


def resolve_text(g: dict) -> tuple[str, str]:
    """One description text per game. Mirrors build_catalog_index.py exactly
    (hash-compatible). Returns (text, source)."""
    rich = (g.get("rich_description") or "").strip()
    if len(rich) > 100:
        return rich, "rich"
    return f"{g['title']}\n\n{(g.get('description') or '').strip()}".strip(), "catalog"


def embed_input(g: dict, text: str) -> str:
    return f"{g['title']}\n\n{text}"


def text_hash(s: str) -> str:
    return hashlib.sha1(s.encode()).hexdigest()


# ─── index state (swapped atomically by the sync thread) ───
VECS = np.load(INDEX / "catalog_vecs.npy")
META = json.load(open(INDEX / "catalog_meta.json"))
assert len(META) == VECS.shape[0], "meta/vecs row mismatch — rebuild the index"
LAST_SYNC: str | None = None

app = FastAPI(title="cyoa.cafe semantic search v2")
_qlock = threading.Lock()
print(f"[server] index loaded: {len(META)} games, dim={VECS.shape[1]}")


# ─── per-IP rate limit (sliding window, in-memory) ───
_rl_lock = threading.Lock()
_rl: dict[str, list[float]] = {}


def _client_ip(request: Request) -> str:
    # behind nginx every connection is 127.0.0.1; trust the forwarded header.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    xr = request.headers.get("x-real-ip")
    if xr:
        return xr.strip()
    return request.client.host if request.client else "unknown"


def _rate_ok(ip: str) -> bool:
    now = time.time()
    cutoff = now - RATE_WINDOW
    with _rl_lock:
        hits = _rl.setdefault(ip, [])
        while hits and hits[0] < cutoff:
            hits.pop(0)
        if len(hits) >= RATE_MAX:
            return False
        hits.append(now)
        if len(_rl) > 10000:  # opportunistic GC of cold IPs
            for k in [k for k, v in _rl.items() if not v or v[-1] < cutoff]:
                del _rl[k]
        return True


def _guard(request: Request) -> None:
    if not _rate_ok(_client_ip(request)):
        raise HTTPException(status_code=429,
                            detail="rate limit exceeded — slow down")


def _norm_q(q: str) -> str:
    """Collapse whitespace + lowercase. Makes search case-insensitive and lifts
    the disk-cache hit rate (so 'Worm', 'worm ', 'WORM' embed once, not thrice)."""
    return " ".join(q.lower().split())


def _rank(vecs: np.ndarray, meta: list[dict], qv: np.ndarray, *,
          top_k: int, floor: float, exclude: int | None = None) -> list[dict]:
    sims = vecs @ qv
    results = []
    for r in np.argsort(-sims):
        if r == exclude:
            continue
        cos = float(sims[r])
        if cos < floor:
            break
        m = meta[r]
        results.append({
            "id": m["id"],
            "title": m["title"],
            "url": f"https://cyoa.cafe/game/{m['id']}",
            "score": int(round(min(cos, 1.0) * 100)),
            "match_type": "summary",
            "snippet": m["snippet"],
        })
        if len(results) >= top_k:
            break
    return results


def sync_index() -> None:
    global VECS, META, LAST_SYNC
    token = _pb_token()
    games, page = [], 1
    while True:
        d = _pb_json(f"/collections/games/records?perPage=200&page={page}"
                     "&fields=id,title,description,rich_description,hidden", token=token)
        games += d["items"]
        if page >= d["totalPages"]:
            break
        page += 1

    old_vecs, old_meta = VECS, META
    by_hash = {m["h"]: r for r, m in enumerate(old_meta) if m.get("h")}

    meta, rows, to_embed, embed_rows = [], [], [], []
    for g in games:
        if g.get("hidden"):
            continue  # скрытые/«удалённые» игры не индексируем (semantic/similar)
        text, source = resolve_text(g)
        ei = embed_input(g, text)
        h = text_hash(ei)
        meta.append({"id": g["id"], "title": g["title"], "source": source,
                     "snippet": " ".join(text.split())[:300], "h": h})
        if h in by_hash:
            rows.append(old_vecs[by_hash[h]])
        else:
            rows.append(None)
            to_embed.append(ei)
            embed_rows.append(len(rows) - 1)

    # guard: a mass hash change means schema/creds trouble (e.g. hidden field
    # not readable -> everything degrades to title+description). Don't let one
    # bad sync silently replace good vectors; override with SYNC_FORCE=1.
    if (len(to_embed) > max(50, 0.2 * len(games))
            and not os.environ.get("SYNC_FORCE")):
        print(f"[sync] ABORT: {len(to_embed)}/{len(games)} texts changed — "
              "suspicious; set SYNC_FORCE=1 if intended")
        return

    if to_embed:
        print(f"[sync] embedding {len(to_embed)} new/changed descriptions")
        new_vecs = lib_embed.embed_texts(to_embed, dim=int(old_vecs.shape[1]),
                                         task="RETRIEVAL_DOCUMENT")
        for j, r in enumerate(embed_rows):
            rows[r] = new_vecs[j]

    vecs = np.vstack(rows).astype(np.float32)

    tmp_v, tmp_m = INDEX / "catalog_vecs.npy.tmp", INDEX / "catalog_meta.json.tmp"
    np.save(tmp_v, vecs)  # np.save appends .npy → file is catalog_vecs.npy.tmp.npy
    json.dump(meta, open(tmp_m, "w"), ensure_ascii=False, indent=1)
    os.replace(str(tmp_v) + ".npy", INDEX / "catalog_vecs.npy")
    os.replace(tmp_m, INDEX / "catalog_meta.json")

    VECS, META = vecs, meta
    LAST_SYNC = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    print(f"[sync] done: {len(meta)} games ({len(to_embed)} embedded)")


def _sync_loop() -> None:
    while True:
        try:
            sync_index()
        except Exception as e:  # never kill the thread — search keeps serving
            print(f"[sync] FAILED: {e}")
        time.sleep(SYNC_HOURS * 3600)


if SYNC_HOURS > 0:
    threading.Thread(target=_sync_loop, daemon=True).start()
else:
    print("[server] SYNC_HOURS=0 — autonomous sync disabled")


def _log(q: str, results: list[dict]) -> None:
    try:
        top = results[0]["title"] if results else "-"
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(LOG, "a") as f:
            f.write(f"{ts}\t{q[:300]}\t{len(results)}\t{top[:80]}\n")
    except OSError:
        pass


@app.get("/healthz")
def healthz():
    return {"status": "ok", "games": len(META), "dim": int(VECS.shape[1]),
            "last_sync": LAST_SYNC}


@app.get("/api/semantic-search")
def semantic_search(request: Request,
                    q: str = Query(..., min_length=1, max_length=500),
                    mode: str = "mixed"):
    _guard(request)
    qn = _norm_q(q)
    if not qn:
        return {"results": [], "total_found": 0, "mode_used": "desc"}
    vecs, meta = VECS, META  # snapshot refs — sync may swap mid-request
    with _qlock:
        qv = lib_embed.embed_query(qn)
    results = _rank(vecs, meta, qv, top_k=TOP_K, floor=MIN_COS)
    _log(q, results)
    return {"results": results, "total_found": len(results), "mode_used": "desc"}


@app.get("/api/similar-games/{game_id}")
def similar_games(request: Request, game_id: str):
    """Games closest to `game_id` by its stored catalog vector. No embed call —
    vectors are L2-normalised, so cosine = dot of the game's own vector."""
    _guard(request)
    vecs, meta = VECS, META  # snapshot refs — sync may swap mid-request
    idx = next((i for i, m in enumerate(meta) if m["id"] == game_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="game not in semantic index")
    results = _rank(vecs, meta, vecs[idx], top_k=SIMILAR_TOP_K,
                    floor=SIMILAR_MIN_COS, exclude=idx)
    return {"results": results, "total_found": len(results), "mode_used": "similar"}
