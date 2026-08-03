"""
Build (or refresh) the production semantic-search index for cyoa.cafe.

One entry point for both initial build and updates — re-running is cheap:
vectors are disk-cached by text hash (lib_embed), so only NEW/changed
descriptions hit the embedding API.

Pipeline:
  1. Fetch the live catalog from prod PB (anonymous GET, browser UA).
  2. Map each catalog game to a local games/ dir:
       a) harvester state.json  catalog_id -> local_dir   (authoritative)
       b) iframe_url/original_link matched against dir paths (any depth)
  3. Resolve one description text per game, by priority:
       rich   — games/<dir>/rich_description.txt
       legacy — summary from old cyoa_embendings_old/games.db (OCR'd statics etc.)
       catalog— title + description from the PB record (last resort)
  4. Embed (gemini-embedding-001 @ 1536, cached) and write:
       index/catalog_vecs.npy   (N, 1536) float32 L2-normalised
       index/catalog_meta.json  [{id, title, source, snippet}]  row-aligned

Run:  python embed_pilot/build_catalog_index.py [--dry-run]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

import lib_embed

PILOT = Path(__file__).resolve().parent
HARVEST = PILOT.parent
GAMES = HARVEST / "games"
STATE = HARVEST / "data" / "state.json"
OLD_DB = PILOT.parent.parent / "cyoa_embendings_old" / "games.db"
OUT = PILOT / "index"
OUT.mkdir(exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
API = "https://cyoa.cafe/api/collections/games/records"


def fetch_catalog() -> list[dict]:
    items, page = [], 1
    while True:
        url = (f"{API}?perPage=200&page={page}"
               "&fields=id,title,description,iframe_url,original_link,img_or_link")
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
            d = json.load(r)
        items += d["items"]
        if page >= d["totalPages"]:
            return items
        page += 1


def url_key(url: str) -> str | None:
    """https://Author.neocities.org/Some%20Game/index.html -> author.neocities.org/some game"""
    if not url:
        return None
    u = urllib.parse.unquote(url.strip().split("://", 1)[-1])
    host, _, path = u.partition("/")
    host = host.lower().removeprefix("www.")
    path = path.split("?", 1)[0].split("#", 1)[0]
    if path.endswith(("index.html", "index.htm")):
        path = path.rsplit("/", 1)[0] if "/" in path else ""
    path = path.strip("/").casefold()
    return f"{host}/{path}" if path else host


def dir_key(rel: str) -> str:
    parts = rel.split("/")
    if parts[-1] == "_root":
        parts = parts[:-1]
    host = parts[0].lower()
    path = "/".join(p.casefold() for p in parts[1:])
    return f"{host}/{path}" if path else host


def map_to_local_dirs(catalog: list[dict]) -> dict[str, Path]:
    """pb_id -> absolute Path of the local game dir (only where one exists)."""
    out: dict[str, Path] = {}

    # a) harvester state: catalog_id -> local_dir
    if STATE.exists():
        st = json.load(open(STATE))
        for v in st.get("games", st).values():
            cid, ld = v.get("catalog_id"), v.get("local_dir")
            if cid and ld and Path(ld).is_dir():
                out.setdefault(cid, Path(ld))

    # b) URL matching against dirs holding a rich_description.txt (any depth)
    by_key: dict[str, Path] = {}
    for p in GAMES.rglob("rich_description.txt"):
        by_key.setdefault(dir_key(str(p.parent.relative_to(GAMES))), p.parent)
    for g in catalog:
        if g["id"] in out:
            continue
        for u in (g.get("iframe_url"), g.get("original_link")):
            k = url_key(u or "")
            if k and k in by_key:
                out[g["id"]] = by_key[k]
                break
    return out


def legacy_summaries() -> dict[str, str]:
    if not OLD_DB.exists():
        print(f"WARN: old games.db not found at {OLD_DB}, skipping legacy summaries")
        return {}
    con = sqlite3.connect(OLD_DB)
    rows = con.execute(
        "SELECT pocketbase_id, summary FROM games "
        "WHERE summary IS NOT NULL AND length(summary) > 100"
    ).fetchall()
    return {r[0]: r[1] for r in rows}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, no embedding")
    args = ap.parse_args()

    catalog = fetch_catalog()
    print(f"catalog: {len(catalog)} games")

    dirs = map_to_local_dirs(catalog)
    legacy = legacy_summaries()

    meta, texts = [], []
    counts = {"rich": 0, "legacy": 0, "catalog": 0}
    for g in catalog:
        text, source = None, None
        d = dirs.get(g["id"])
        if d and (d / "rich_description.txt").exists():
            t = (d / "rich_description.txt").read_text().strip()
            if len(t) > 100:
                text, source = t, "rich"
        if text is None and g["id"] in legacy:
            text, source = legacy[g["id"]].strip(), "legacy"
        if text is None:
            text = f"{g['title']}\n\n{(g.get('description') or '').strip()}".strip()
            source = "catalog"
        counts[source] += 1
        snippet = " ".join(text.split())[:300]
        ei = f"{g['title']}\n\n{text}"   # embed input; same shape as server.py
        meta.append({"id": g["id"], "title": g["title"], "source": source,
                     "snippet": snippet,
                     "h": hashlib.sha1(ei.encode()).hexdigest()})
        texts.append(ei)

    print("description sources:", counts)
    if args.dry_run:
        for m in meta:
            if m["source"] == "catalog":
                print("  catalog-fallback:", m["title"][:60])
        return

    vecs = lib_embed.embed_texts(texts, dim=1536, task="RETRIEVAL_DOCUMENT")
    np.save(OUT / "catalog_vecs.npy", vecs)
    json.dump(meta, open(OUT / "catalog_meta.json", "w"), ensure_ascii=False, indent=1)
    print(f"done: {len(meta)} games -> {OUT}/catalog_vecs.npy, catalog_meta.json")


if __name__ == "__main__":
    main()
