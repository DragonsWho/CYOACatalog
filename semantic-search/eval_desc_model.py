"""
Desc-only retrieval eval for whatever embedding model EMBED_MODEL points at.
Embeds every game's rich_description.txt + the golden queries with that model,
then reports Hit@10 / MRR. Lets us A/B gemini-embedding-001 vs -2 on OUR text.

  EMBED_MODEL=gemini-embedding-001 python embed_pilot/eval_desc_model.py
  EMBED_MODEL=gemini-embedding-2   python embed_pilot/eval_desc_model.py
"""
from __future__ import annotations

import glob
import json
import os
from pathlib import Path

import numpy as np

import lib_embed

PILOT = Path(__file__).resolve().parent
GAMES = PILOT.parent / "games"
GOLDEN = json.load(open(PILOT / "golden_queries.json"))


def _norm(g: str) -> str:
    g = g.lower()
    for s in (".neocities.org", ".cyoa.cafe", ".github.io"):
        g = g.replace(s, "")
    return g


def main():
    gids, descs = [], []
    for dp in sorted(glob.glob(str(GAMES / "*" / "*" / "rich_description.txt"))):
        gids.append(os.path.relpath(os.path.dirname(dp), GAMES))
        descs.append(Path(dp).read_text())

    print(f"model={lib_embed.MODEL}  games={len(gids)}  queries={len(GOLDEN)}")
    dvecs = lib_embed.embed_texts(descs, dim=1536, task="RETRIEVAL_DOCUMENT")
    qvecs = lib_embed.embed_texts([g["q"] for g in GOLDEN], dim=1536, task="RETRIEVAL_QUERY")

    hit = mrr = 0.0
    for gi, g in enumerate(GOLDEN):
        sims = dvecs @ qvecs[gi]
        order = np.argsort(-sims)[:10]
        rr = 0.0
        for pos, r in enumerate(order, 1):
            if any(_norm(rel) in _norm(gids[r]) for rel in g["relevant"]):
                rr = 1.0 / pos
                break
        hit += 1 if rr > 0 else 0
        mrr += rr
    n = len(GOLDEN)
    print(f"\nDESC-ONLY  {lib_embed.MODEL}:  Hit@10={hit/n:.3f}  MRR={mrr/n:.3f}")


if __name__ == "__main__":
    main()
