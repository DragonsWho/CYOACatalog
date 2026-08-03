"""
A/B evaluation of retrieval configs on the golden query set.

Configs compared:
  text      — text channel only (RRF over chunks, breadth bonus)
  desc      — description channel only (gemma v2, one vector/game)
  hybrid    — text + desc, RRF fused
  old       — legacy formula: desc*0.70 + log1p(sum(chunk*0.85^i))/5.0 *0.30

Metrics: Hit@10 (>=1 relevant in top 10) and MRR (1/rank of first relevant).
Relevance: a result gid is relevant if any golden 'relevant' substring is in it.
Note: mirror duplicates (cafe/neocities) are NOT collapsed; they penalise all
configs equally, so the relative A/B verdict stays valid.

  python embed_pilot/eval.py [-k 10]
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
GOLDEN = Path(__file__).resolve().parent / "golden_queries.json"

RRF_K = 60
TOPM = 5
POOL = 200
DECAY, DIVISOR, SW, TW = 0.85, 5.0, 0.70, 0.30


def load():
    games = json.load(open(OUT / "games.json"))
    text_vecs = np.load(OUT / "text_vecs.npy")
    text_rows = json.load(open(OUT / "text_rows.json"))
    desc_vecs = desc_rows = None
    if (OUT / "desc_vecs.npy").exists():
        desc_vecs = np.load(OUT / "desc_vecs.npy")
        desc_rows = json.load(open(OUT / "desc_rows.json"))
    return games, text_vecs, text_rows, desc_vecs, desc_rows


def rank(config, qv, text_vecs, text_rows, desc_vecs, desc_rows, k=10):
    text_sims = text_vecs @ qv
    scores = defaultdict(float)

    if config in ("text", "hybrid", "hyb_w"):
        order = np.argsort(-text_sims)[:POOL]
        seen = defaultdict(int)
        for r_i, r in enumerate(order):
            gid = text_rows[r]
            if seen[gid] >= TOPM:
                continue
            seen[gid] += 1
            scores[gid] += 1.0 / (RRF_K + r_i)

    if config in ("desc", "hybrid", "hyb_w") and desc_vecs is not None:
        w = 3.0 if config == "hyb_w" else 1.0
        dsims = desc_vecs @ qv
        for r_i, r in enumerate(np.argsort(-dsims)):
            scores[desc_rows[r]] += w * 1.0 / (RRF_K + r_i)

    if config == "old":
        per = defaultdict(list)
        for r, gid in enumerate(text_rows):
            per[gid].append(float(text_sims[r]))
        dby = {}
        if desc_vecs is not None:
            dsims = desc_vecs @ qv
            for r, gid in enumerate(desc_rows):
                dby[gid] = float(dsims[r])
        for gid, sims in per.items():
            sims.sort(reverse=True)
            t = sum(s * (DECAY ** i) for i, s in enumerate(sims))
            nt = math.log1p(t) / DIVISOR if t > 0 else 0.0
            scores[gid] = dby.get(gid, max(sims)) * SW + nt * TW

    return [g for g, _ in sorted(scores.items(), key=lambda x: -x[1])[:k]]


def _norm(gid: str) -> str:
    # strip host suffix so "aearara/Catgirl" matches "aearara.neocities.org/Catgirl_Cyoa"
    g = gid.lower()
    for suf in (".neocities.org", ".cyoa.cafe", ".github.io"):
        g = g.replace(suf, "")
    return g


def is_rel(gid, rels):
    g = _norm(gid)
    return any(_norm(r) in g for r in rels)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", type=int, default=10)
    ap.add_argument("--show", action="store_true", help="print per-query ranks")
    args = ap.parse_args()

    games, tv, tr, dv, dr = load()
    n_desc = len(dr) if dr else 0
    print(f"index: {len(games)} games, {len(tr)} text chunks, {n_desc} desc vectors\n")

    golden = json.load(open(GOLDEN))
    qtexts = [g["q"] for g in golden]
    qvs = lib_embed.embed_texts(qtexts, dim=1536, task="RETRIEVAL_QUERY")

    configs = ["text", "desc", "hybrid", "hyb_w", "old"] if dv is not None else ["text"]
    agg = {c: {"hit": 0, "mrr": 0.0} for c in configs}
    bytype = defaultdict(lambda: defaultdict(lambda: {"hit": 0, "mrr": 0.0, "n": 0}))

    for gi, g in enumerate(golden):
        qv = qvs[gi]
        rels = g["relevant"]
        line = f'  {g["q"][:42]:42} [{g["type"]:9}]'
        for c in configs:
            ranked = rank(c, qv, tv, tr, dv, dr, args.k)
            rr = 0.0
            for pos, gid in enumerate(ranked, 1):
                if is_rel(gid, rels):
                    rr = 1.0 / pos
                    break
            hit = 1 if rr > 0 else 0
            agg[c]["hit"] += hit
            agg[c]["mrr"] += rr
            bt = bytype[g["type"]][c]
            bt["hit"] += hit; bt["mrr"] += rr; bt["n"] += 1
            line += f"  {c}:{'%.2f'%rr if rr else ' . '}"
        if args.show:
            print(line)

    n = len(golden)
    print(f"\n=== AGGREGATE over {n} queries ===")
    print(f"{'config':10} {'Hit@'+str(args.k):8} {'MRR':8}")
    for c in configs:
        print(f"{c:10} {agg[c]['hit']/n:8.3f} {agg[c]['mrr']/n:8.3f}")

    print("\n=== by query type (MRR) ===")
    types = sorted(bytype)
    print(f"{'type':10} " + " ".join(f"{c:7}" for c in configs))
    for t in types:
        nrow = bytype[t][configs[0]]["n"]
        print(f"{t:10} " + " ".join(f"{bytype[t][c]['mrr']/nrow:7.3f}" for c in configs) + f"   (n={nrow})")


if __name__ == "__main__":
    main()
