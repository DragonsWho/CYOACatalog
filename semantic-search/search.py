"""
Search the pilot index. Two fusion modes for A/B comparison:

  --mode rrf   (default)  rank-based Reciprocal Rank Fusion across channels,
                          with a per-game "breadth bonus" over its top-m chunks.
  --mode old              reproduces the legacy formula:
                          summary*0.70 + log1p(sum(chunk*0.85^i))/5.0 *0.30
                          (uses desc channel as the "summary"; text as chunks)

Usage:
  python embed_pilot/search.py "green tailed demon girl study" [--mode rrf] [-k 10]
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

import lib_embed

OUT = Path(__file__).resolve().parent / "index"

# RRF tunables
RRF_K = 60
TOPM_CHUNKS = 5          # breadth bonus: how many of a game's chunks count
W_DESC = 1.0
W_TEXT = 1.0
POOL = 200               # how many chunk hits to consider before fusing

# legacy formula tunables
DECAY = 0.85
DIVISOR = 5.0
SUMMARY_W = 0.70
TEXT_W = 0.30


def _load(name):
    p = OUT / name
    return np.load(p) if name.endswith(".npy") else json.load(open(p))


def search(query: str, mode: str = "rrf", k: int = 10):
    games = {g["gid"]: g for g in _load("games.json")}
    qv = lib_embed.embed_query(query)

    text_vecs = _load("text_vecs.npy")
    text_rows = _load("text_rows.json")
    text_sims = text_vecs @ qv  # cosine (both normalised)

    has_desc = (OUT / "desc_vecs.npy").exists()
    if has_desc:
        desc_vecs = _load("desc_vecs.npy")
        desc_rows = _load("desc_rows.json")
        desc_sims = desc_vecs @ qv

    if mode == "old":
        # group text sims by game
        per_game = defaultdict(list)
        for r, gid in enumerate(text_rows):
            per_game[gid].append(float(text_sims[r]))
        desc_by_game = {}
        if has_desc:
            for r, gid in enumerate(desc_rows):
                desc_by_game[gid] = float(desc_sims[r])
        scores = {}
        for gid, sims in per_game.items():
            sims.sort(reverse=True)
            tscore = sum(s * (DECAY ** i) for i, s in enumerate(sims))
            ntext = math.log1p(tscore) / DIVISOR if tscore > 0 else 0.0
            summ = desc_by_game.get(gid, max(sims))  # fall back to best chunk
            scores[gid] = summ * SUMMARY_W + ntext * TEXT_W
        ranked = sorted(scores.items(), key=lambda x: -x[1])[:k]

    else:  # rrf
        scores = defaultdict(float)

        # text channel: rank chunks globally, give each game a breadth bonus
        order = np.argsort(-text_sims)[:POOL]
        seen = defaultdict(int)
        for rank, r in enumerate(order):
            gid = text_rows[r]
            if seen[gid] >= TOPM_CHUNKS:
                continue
            seen[gid] += 1
            scores[gid] += W_TEXT * 1.0 / (RRF_K + rank)

        # desc channel: one vector per game
        if has_desc:
            dorder = np.argsort(-desc_sims)
            for rank, r in enumerate(dorder):
                gid = desc_rows[r]
                scores[gid] += W_DESC * 1.0 / (RRF_K + rank)

        ranked = sorted(scores.items(), key=lambda x: -x[1])[:k]

    print(f'\nQuery: "{query}"   mode={mode}   desc_channel={has_desc}\n')
    for i, (gid, sc) in enumerate(ranked, 1):
        g = games.get(gid, {})
        print(f"{i:2}. {sc:.4f}  {g.get('title','?')[:55]:55}  [{g.get('author','?')}]")
    return ranked


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--mode", choices=["rrf", "old"], default="rrf")
    ap.add_argument("-k", type=int, default=10)
    a = ap.parse_args()
    search(a.query, a.mode, a.k)
