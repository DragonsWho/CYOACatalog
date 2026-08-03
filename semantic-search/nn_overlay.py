"""Overlay author-confirmed dedup verdicts onto nn_report.csv.

Dedup v3 layer-3 calibration, step 2. nn_report.py gives the raw cosine bands;
this joins them against ground truth the author already produced by hand:

  data/reports/dedup_actions.json — 47 hand-reviewed clusters, each member gid
  bucketed keep/quarantine/hub_split/redownload/not_game/uncertain. The `games::`
  -prefixed members map 1:1 onto nn_report gids (strip the bucket prefix).

For every reported pair it adds a `known` column:
  same-cluster  → both gids sit in the SAME author cluster (= confirmed family;
                  keep+quarantine = the same game, hub_split = related-not-equal).
                  These should land in the HIGH cosine bands — they calibrate the
                  floor. A same-cluster pair with LOW cosine = embedding blind spot.
  (blank)       → not co-clustered by the author. A high-cosine diff-title blank
                  is the real catch — a near-dup the manual pass never saw.

Read-only. Run AFTER nn_report.py:
  venv/bin/python embed_pilot/nn_overlay.py
Writes embed_pilot/nn_report_labeled.csv (same rows + known, cluster, verdictA/B).
"""
from __future__ import annotations

import csv
import json
import os
from pathlib import Path

JUNK_TITLES = {"optimized", "index", "game", "cyoa", "untitled", ""}


def intra_game(ga: str, gb: str, ta: str, tb: str) -> bool:
    """True when the two gids are the SAME game's folders, not two games.

    The games/ tree carries per-game variant subdirs — `<game>/optimized`,
    `<game>/v2`, sibling files under one game dir — plus junk titles like
    "optimized" on those children. Such a pair is intra-game (it should collapse
    to one entity), NOT a cross-game near-dup. We catch them by path topology so
    they don't drown the genuine cross-tree collisions in the top cosine band.
    """
    a, b = ga.strip("/"), gb.strip("/")
    if a == b:
        return True
    if a.startswith(b + "/") or b.startswith(a + "/"):      # parent / sub-variant
        return True
    if os.path.dirname(a) and os.path.dirname(a) == os.path.dirname(b):  # siblings
        return True
    if ta.strip().lower() in JUNK_TITLES or tb.strip().lower() in JUNK_TITLES:
        return True
    return False

import sys

PILOT = Path(__file__).resolve().parent
HARVEST = PILOT.parent
sys.path.insert(0, str(HARVEST))
from utils.lang_detect import classify_text, _game_text  # noqa: E402

ACTIONS = HARVEST / "data" / "reports" / "dedup_actions.json"
GAMES = HARVEST / "games"
IN_CSV = PILOT / "nn_report.csv"
OUT_CSV = PILOT / "nn_report_labeled.csv"
CROSS_CSV = PILOT / "nn_report_cross.csv"

BUCKETS = ("keep", "quarantine", "hub_split", "redownload", "not_game", "uncertain")


def load_clusters() -> dict[str, tuple[int, str]]:
    """gid (games:: stripped, lowercased) -> (cluster_index, verdict_bucket)."""
    if not ACTIONS.exists():
        return {}
    data = json.loads(ACTIONS.read_text(encoding="utf-8"))
    gid2cl: dict[str, tuple[int, str]] = {}
    for ci, cl in enumerate(data.values()):
        for bucket in BUCKETS:
            for member in cl.get(bucket) or []:
                if not member.startswith("games::"):
                    continue
                gid = member.split("::", 1)[1].strip().lower()
                # first verdict wins; keep is the canonical one if duplicated
                gid2cl.setdefault(gid, (ci, bucket))
    return gid2cl


def main() -> None:
    if not IN_CSV.exists():
        print(f"missing {IN_CSV} — run nn_report.py first")
        return
    gid2cl = load_clusters()
    print(f"cluster members (games::): {len(gid2cl)} across the manual ledger")

    rows = list(csv.DictReader(IN_CSV.open(encoding="utf-8")))

    # language only for gids that actually appear in a pair (lazy + cached)
    lang_cache: dict[str, str] = {}

    def lang_of(gid: str) -> str:
        if gid not in lang_cache:
            d = GAMES / gid
            lang_cache[gid] = classify_text(_game_text(d))[0] if d.exists() else "unknown"
        return lang_cache[gid]

    n_same = 0
    out = []
    for r in rows:
        ga = r["gidA"].strip().lower()
        gb = r["gidB"].strip().lower()
        ca = gid2cl.get(ga)
        cb = gid2cl.get(gb)
        known = ""
        cluster = ""
        va = vb = ""
        if ca and cb and ca[0] == cb[0]:
            known = "same-cluster"
            cluster = str(ca[0])
            va, vb = ca[1], cb[1]
            n_same += 1
        intra = intra_game(r["gidA"], r["gidB"], r["titleA"], r["titleB"])
        la, lb = lang_of(r["gidA"]), lang_of(r["gidB"])
        # different languages (and not both unknown) ⇒ translation pair, NOT a
        # duplicate: link by relationship, never merge. Flags the Korean↔English
        # case (e.g. Demon God of World Creation) the embedding scores as a dup.
        xlang = ""
        if la != lb and "unknown" not in (la, lb):
            xlang = f"{la}/{lb}"
        out.append({**r, "known": known, "cluster": cluster,
                    "verdictA": va, "verdictB": vb,
                    "intra_game": "Y" if intra else "",
                    "langA": la, "langB": lb, "xlang": xlang})

    fields = list(rows[0].keys()) + ["known", "cluster", "verdictA", "verdictB",
                                     "intra_game", "langA", "langB", "xlang"]
    tmp = OUT_CSV.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(out)
    os.replace(tmp, OUT_CSV)
    print(f"wrote {OUT_CSV}  ({len(out)} rows, {n_same} same-cluster)")

    # ── the calibration view that matters: CROSS-game, distinct-title pairs ──
    # (drop same-title mirrors AND intra-game subfolders; what's left is the set
    #  where the embedding alone has to decide "same game or not").
    cross = [r for r in out if r["same_title"] != "Y" and r["intra_game"] != "Y"]
    translations = [r for r in cross if r["xlang"]]
    cross = [r for r in cross if not r["xlang"]]      # translations are not dup-disputes
    if translations:
        print(f"cross-language (translation, NOT duplicate): {len(translations)} pairs")
    cross_out = CROSS_CSV.with_suffix(".tmp")
    with open(cross_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(sorted(cross, key=lambda r: -float(r["cosine"])))
    os.replace(cross_out, CROSS_CSV)
    print(f"wrote {CROSS_CSV}  ({len(cross)} cross-game distinct-title pairs)")

    bands = [(0.99, 1.01), (0.98, 0.99), (0.97, 0.98), (0.96, 0.97),
             (0.95, 0.96), (0.93, 0.95), (0.90, 0.93)]
    print("\ncross-game distinct-title pairs by band "
          "(where distinct games start colliding — set the flag floor here):")
    for lo, hi in bands:
        c = sum(1 for r in cross if lo <= float(r["cosine"]) < hi)
        print(f"  [{lo:.2f},{min(hi,1.0):.2f})   {c:4d}")

    # where do the author-confirmed same-cluster pairs land? (floor calibration)
    bands = [(0.99, 1.01), (0.98, 0.99), (0.97, 0.98), (0.96, 0.97),
             (0.95, 0.96), (0.93, 0.95), (0.90, 0.93)]
    sc = [float(r["cosine"]) for r in out if r["known"] == "same-cluster"]
    if sc:
        print("\nauthor same-cluster pairs by cosine band (where the floor should sit):")
        for lo, hi in bands:
            c = sum(1 for x in sc if lo <= x < hi)
            print(f"  [{lo:.2f},{min(hi,1.0):.2f})   {c:4d}")
        lows = sorted(x for x in sc if x < 0.95)
        if lows:
            print(f"\n⚠ {len(lows)} confirmed-family pairs below 0.95 "
                  f"(embedding under-counts these): min={min(lows):.4f}")


if __name__ == "__main__":
    main()
