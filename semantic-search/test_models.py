"""
Run prompt_description.txt against several OpenRouter models on one game,
to compare NSFW-willingness, quality and cost. Saves each output and a summary.

  python embed_pilot/test_models.py [--game <gid>] [--chars 60000]

Outputs to embed_pilot/model_test/<safe_model>.txt + summary printed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.request
import urllib.error
from pathlib import Path

PILOT = Path(__file__).resolve().parent
HARVEST = PILOT.parent
GAMES = HARVEST / "games"
DEFAULT_MODELS = [
    "google/gemini-3.5-flash",
    "google/gemma-4-31b-it",
    "deepseek/deepseek-v4-flash",
    "z-ai/glm-4.5-air",
    "minimax/minimax-m2.5",
    "moonshotai/kimi-k2.6",
    "qwen/qwen3.6-flash",
    "cognitivecomputations/dolphin-mistral-24b-venice-edition",  # known-uncensored baseline
]

REFUSAL_PAT = re.compile(
    r"\b(i can't|i cannot|i'm unable|i am unable|i won't|i will not|"
    r"unable to (assist|help|comply)|cannot (assist|help|comply|fulfill)|"
    r"as an ai|i'm not able|against my|i must decline|i apologize, but)\b",
    re.I,
)


def _key() -> str:
    for line in (HARVEST / ".env").read_text().splitlines():
        m = re.match(r"\s*OPENROUTER_API_KEY\s*=\s*(\S+)", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    raise RuntimeError("OPENROUTER_API_KEY missing")


def pricing() -> dict:
    d = json.load(urllib.request.urlopen("https://openrouter.ai/api/v1/models", timeout=60))["data"]
    return {m["id"]: m.get("pricing", {}) for m in d}


def call(model: str, game_text: str, key: str, prompt: str, max_tokens: int) -> dict:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": game_text},
        ],
        "temperature": 0.3,
        "max_tokens": max_tokens,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=240) as r:
        d = json.load(r)
    dt = time.time() - t0
    if "choices" not in d:
        return {"error": json.dumps(d)[:300]}
    msg = d["choices"][0]["message"]["content"]
    return {"text": msg or "", "usage": d.get("usage", {}), "secs": dt,
            "finish": d["choices"][0].get("finish_reason")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default="dragonswhore-cyoas.cyoa.cafe/blacked-sissy")
    ap.add_argument("--chars", type=int, default=60000)
    ap.add_argument("--prompt", default="prompt_description.txt")
    ap.add_argument("--models", default="", help="comma-separated; default = built-in list")
    ap.add_argument("--max-tokens", type=int, default=1200)
    ap.add_argument("--tag", default="", help="suffix for output filenames")
    args = ap.parse_args()
    key = _key()

    prompt = (PILOT / args.prompt).read_text()
    outdir = PILOT / "model_test"
    outdir.mkdir(exist_ok=True)
    models = [m.strip() for m in args.models.split(",") if m.strip()] or DEFAULT_MODELS

    et = json.load(open(GAMES / args.game / "extracted_text.json"))
    game_text = (et.get("full_text") or "")[: args.chars]
    print(f"game: {args.game}  input ~{len(game_text)//4} tokens\n")

    prices = pricing()
    rows = []
    for model in models:
        safe = model.replace("/", "__") + (f"__{args.tag}" if args.tag else "")
        print(f"--- {model} ---")
        try:
            res = call(model, game_text, key, prompt, args.max_tokens)
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code}: {e.read()[:200]}\n")
            rows.append((model, "HTTP_ERR", 0, 0, 0.0, 0.0, "?"))
            continue
        except Exception as e:
            print(f"  ERR {e}\n")
            rows.append((model, "ERR", 0, 0, 0.0, 0.0, "?"))
            continue
        if "error" in res:
            print(f"  {res['error']}\n")
            rows.append((model, "API_ERR", 0, 0, 0.0, 0.0, "?"))
            continue
        txt = res["text"].strip()
        (outdir / f"{safe}.txt").write_text(txt)
        u = res["usage"]
        ctoks = u.get("completion_tokens", 0)
        pin = float(prices.get(model, {}).get("prompt", 0)) * u.get("prompt_tokens", 0)
        pout = float(prices.get(model, {}).get("completion", 0)) * ctoks
        cost = pin + pout
        refused = bool(REFUSAL_PAT.search(txt)) or len(txt) < 200
        # truncation check: did the model actually finish with the Keywords line?
        has_kw = "keywords:" in txt[-600:].lower()
        kw = "kw_ok" if has_kw else ("CUT" if res.get("finish") == "length" else "no_kw")
        status = "REFUSED?" if refused else "ok"
        rows.append((model, status, len(txt.split()), ctoks, res["secs"], cost, kw))
        print(f"  {status}  {len(txt.split())} words  {ctoks} out-toks  {res['secs']:.1f}s  "
              f"${cost:.5f}  keywords:{kw}  finish:{res.get('finish')}")
        print(f"  head: {txt[:140]}\n")

    print("\n=== SUMMARY ===")
    print(f"{'model':40} {'status':9} {'words':5} {'otoks':5} {'kw':6} "
          f"{'$/game':9} {'$/600':8} {'$/2000':8}")
    for m, st, w, ct, secs, cost, kw in rows:
        print(f"{m:40} {st:9} {w:5} {ct:5} {kw:6} ${cost:.5f} ${cost*600:7.2f} ${cost*2000:7.2f}")


if __name__ == "__main__":
    main()
