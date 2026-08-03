"""
Build the pilot search index from already-downloaded games.

Channels:
  text  — raw full_text split into ~500-word chunks (literal details, names).
  desc  — homogeneous rich description (one per game) IF a *.desc.txt exists
          next to the game (generated separately once the prompt is settled).

Outputs (in embed_pilot/index/):
  games.json          list of {gid, title, author, n_text_chunks, has_desc}
  text_vecs.npy       (N_chunks, dim) float32, L2-normalised
  text_rows.json      row -> gid
  desc_vecs.npy       (N_games_with_desc, dim)
  desc_rows.json      row -> gid

Run:  python embed_pilot/build_index.py [--dim 1536] [--max-chunks 60]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from pathlib import Path

import numpy as np

import lib_embed

PILOT = Path(__file__).resolve().parent
HARVEST = PILOT.parent
GAMES = HARVEST / "games"
OUT = PILOT / "index"
OUT.mkdir(exist_ok=True)


def chunk_words(text: str, size: int = 500, overlap: int = 50) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks, i = [], 0
    while i < len(words):
        chunks.append(" ".join(words[i:i + size]))
        i += size - overlap
    return chunks


def title_of(et: dict, gid: str) -> str:
    secs = et.get("sections") or []
    if secs and secs[0].get("title") and secs[0]["title"].lower() not in (
        "intro", "introduction", "start"
    ):
        return secs[0]["title"]
    ft = et.get("full_text", "")
    first = ft.split("\n", 1)[0].lstrip("# ").strip() if ft else ""
    return first or gid


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dim", type=int, default=1536)
    ap.add_argument("--max-chunks", type=int, default=60)
    args = ap.parse_args()

    games, all_chunks, chunk_rows = [], [], []
    desc_texts, desc_rows = [], []

    for et_path in sorted(glob.glob(str(GAMES / "*" / "*" / "extracted_text.json"))):
        d = os.path.dirname(et_path)
        gid = os.path.relpath(d, GAMES)
        try:
            et = json.load(open(et_path))
        except Exception:
            continue
        ft = et.get("full_text", "") or ""
        if len(ft) < 200:
            continue
        author = gid.split(os.sep)[0].replace(".neocities.org", "").replace(".cyoa.cafe", "")
        title = title_of(et, gid)

        chunks = chunk_words(ft)[: args.max_chunks]
        for c in chunks:
            all_chunks.append(c)
            chunk_rows.append(gid)

        desc_path = Path(d) / "rich_description.txt"
        has_desc = desc_path.exists()
        if has_desc:
            desc_texts.append(desc_path.read_text())
            desc_rows.append(gid)

        games.append({
            "gid": gid, "title": title, "author": author,
            "n_text_chunks": len(chunks), "has_desc": has_desc,
        })

    print(f"games: {len(games)}  text chunks: {len(all_chunks)}  descs: {len(desc_texts)}")

    print("embedding text channel...")
    text_vecs = lib_embed.embed_texts(all_chunks, dim=args.dim, task="RETRIEVAL_DOCUMENT")
    np.save(OUT / "text_vecs.npy", text_vecs)
    json.dump(chunk_rows, open(OUT / "text_rows.json", "w"))

    if desc_texts:
        print("embedding desc channel...")
        desc_vecs = lib_embed.embed_texts(desc_texts, dim=args.dim, task="RETRIEVAL_DOCUMENT")
        np.save(OUT / "desc_vecs.npy", desc_vecs)
        json.dump(desc_rows, open(OUT / "desc_rows.json", "w"))

    json.dump(games, open(OUT / "games.json", "w"), ensure_ascii=False, indent=1)
    print("done ->", OUT)


if __name__ == "__main__":
    main()
