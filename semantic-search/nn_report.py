"""Full-corpus near-duplicate report by rich-description cosine.

Dedup v3 layer-3 CALIBRATION. Embeds every games/**/rich_description.txt @1536
(gemini-embedding-001, cached via lib_embed) and ranks the most-similar game
PAIRS, so the author can eyeball where the cosine band stops meaning "same game"
and starts colliding distinct games — instead of baking a magic 0.98 threshold.

Labels each pair:
  same_title  — soft-normalised titles equal → likely a mirror/version/translation
                (NOT a false positive); diff-title high-cosine = the real risk.

Prints:
  - band histogram (≥0.99 / 0.99–0.98 / 0.98–0.97 / …) split same-title vs diff,
  - same-title cosine spread → empirical answer to "how much does the SAME game's
    embedding drift?" (mirrors share near-identical text; temperature adds wobble).

Output CSV: embed_pilot/nn_report.csv  (cosine, same_title, gidA, titleA, gidB, titleB)
Read-only: touches no PB, no catalog. Run: venv/bin/python embed_pilot/nn_report.py
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import sys
from pathlib import Path

import numpy as np

PILOT = Path(__file__).resolve().parent
HARVEST = PILOT.parent
GAMES = HARVEST / "games"
sys.path.insert(0, str(PILOT))
sys.path.insert(0, str(HARVEST))

from lib_embed import embed_texts            # noqa: E402
from utils.catalog_check import soft_norm_title  # noqa: E402


def collect() -> list[dict]:
    """Every game dir with a rich_description.txt (any depth under games/)."""
    items: list[dict] = []
    seen: set[str] = set()
    for rd in glob.glob(str(GAMES / "**" / "rich_description.txt"), recursive=True):
        d = Path(rd).parent
        gid = os.path.relpath(d, GAMES)
        if gid in seen:
            continue
        seen.add(gid)
        try:
            text = Path(rd).read_text(encoding="utf-8", errors="replace").strip()
        except Exception:
            continue
        if len(text) < 100:
            continue
        title = os.path.basename(gid)
        mp = d / "metadata.json"
        if mp.exists():
            try:
                title = json.loads(mp.read_text(encoding="utf-8")).get("title") or title
            except Exception:
                pass
        items.append({"gid": gid, "title": title, "text": text})
    return items


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min", type=float, default=0.90, help="floor cosine for reported pairs")
    ap.add_argument("--topk", type=int, default=5, help="nearest neighbours per game")
    ap.add_argument("--out", default=str(PILOT / "nn_report.csv"))
    args = ap.parse_args()

    items = collect()
    print(f"games with rich_description: {len(items)}")
    if len(items) < 2:
        print("nothing to compare")
        return

    M = embed_texts([it["text"] for it in items], dim=1536)   # (n,1536) L2-normalised
    n = len(items)
    print(f"embedded {n} @1536, computing pairwise cosine…")

    # cosine = dot product (rows already L2-normalised). Block the matmul to keep
    # peak memory modest for a few thousand games.
    norm_titles = [soft_norm_title(it["title"]) for it in items]
    pairs: list[tuple[float, int, int]] = []
    BS = 512
    for s in range(0, n, BS):
        sims = M[s:s + BS] @ M.T                # (bs, n)
        for r in range(sims.shape[0]):
            i = s + r
            row = sims[r]
            row[i] = -1.0                       # drop self
            # top-k neighbours above the floor
            k = min(args.topk, n - 1)
            cand = np.argpartition(row, -k)[-k:]
            for j in cand:
                c = float(row[j])
                if c >= args.min and i < j:     # unique unordered pair
                    pairs.append((c, i, j))

    # dedup (a pair can surface from both endpoints' top-k) + sort desc
    pairs = sorted(set(pairs), key=lambda p: -p[0])
    print(f"pairs ≥ {args.min}: {len(pairs)}")

    out = Path(args.out)
    tmp = out.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["cosine", "same_title", "gidA", "titleA", "gidB", "titleB"])
        for c, i, j in pairs:
            same = norm_titles[i] == norm_titles[j] and bool(norm_titles[i])
            w.writerow([f"{c:.4f}", "Y" if same else "", items[i]["gid"], items[i]["title"],
                        items[j]["gid"], items[j]["title"]])
    os.replace(tmp, out)
    print(f"wrote {out}")

    # ── band histogram (calibration view) ──
    bands = [(0.99, 1.01), (0.98, 0.99), (0.97, 0.98), (0.96, 0.97),
             (0.95, 0.96), (0.93, 0.95), (0.90, 0.93)]
    print("\nband        same-title  diff-title   (diff = false-positive risk)")
    for lo, hi in bands:
        same = sum(1 for c, i, j in pairs if lo <= c < hi
                   and norm_titles[i] == norm_titles[j] and norm_titles[i])
        diff = sum(1 for c, i, j in pairs if lo <= c < hi
                   and not (norm_titles[i] == norm_titles[j] and norm_titles[i]))
        print(f"  [{lo:.2f},{hi if hi<=1 else 1.0:.2f})   {same:6d}      {diff:6d}")

    # ── same-title spread: how much does the SAME game's embedding drift? ──
    st = sorted(c for c, i, j in pairs
                if norm_titles[i] == norm_titles[j] and norm_titles[i])
    if st:
        arr = np.array(st)
        print(f"\nsame-title pairs: {len(st)}  cosine min={arr.min():.4f} "
              f"p05={np.percentile(arr,5):.4f} median={np.median(arr):.4f} max={arr.max():.4f}")
        print("(min/p05 ≈ worst-case drift for the SAME game across mirrors/versions)")


if __name__ == "__main__":
    main()
