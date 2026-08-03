"""
Generate one homogeneous rich_description.txt per game from its full_text,
using the prompt in prompt_description.txt.

Writes alongside each game: games/<gid>/rich_description.txt
Skips games that already have one (resumable). Does NOT touch PB or the catalog.

Model is via OpenRouter so we can pick a permissive model for explicit content
(Gemini refuses NSFW). Default deepseek; override with --model.

NOTE: for NEW games s04_describe now generates rich_description.txt inline
(same prompt file, config.RICH_DESCRIPTION_MODEL) — this script remains the
MASS/backfill tool. Keep prompt_description_v2.txt the single shared prompt.

  python embed_pilot/gen_descriptions.py --model deepseek/deepseek-chat [--limit N] [--force]

IMPORTANT: review the prompt + a few sample outputs before mass-running.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import threading
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PILOT = Path(__file__).resolve().parent
HARVEST = PILOT.parent
GAMES = HARVEST / "games"

MAX_INPUT_CHARS = 60000   # ~15k tokens of game text; plenty for a profile


def _key() -> str:
    for line in (HARVEST / ".env").read_text().splitlines():
        m = re.match(r"\s*OPENROUTER_API_KEY\s*=\s*(\S+)", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    raise RuntimeError("OPENROUTER_API_KEY not in CYOA Harvester/.env")


def generate(model: str, game_text: str, key: str, prompt: str) -> str:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": game_text[:MAX_INPUT_CHARS]},
        ],
        "temperature": 0.3,
        "max_tokens": 2500,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    last_err = None
    for attempt in (1, 2):  # один ретрай: OpenRouter кладёт ошибку в тело с HTTP 200
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r)
        if d.get("choices"):
            # content бывает null (обрыв/фильтр провайдера) — это ошибка, не ответ
            content = (d["choices"][0].get("message") or {}).get("content")
            if content and content.strip():
                return content.strip()
            last_err = (f"empty completion "
                        f"(finish_reason={d['choices'][0].get('finish_reason')!r})")
        else:
            last_err = (d.get("error") or {}).get("message") or json.dumps(d)[:200]
        if attempt == 1:
            time.sleep(5)
    raise RuntimeError(f"LLM API error ({model}): {last_err}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="google/gemma-4-31b-it")
    ap.add_argument("--prompt", default="prompt_description_v2.txt")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    key = _key()
    prompt = (PILOT / args.prompt).read_text()

    # collect work items (resumable: skip games that already have a description)
    todo = []
    for et_path in sorted(glob.glob(str(GAMES / "*" / "*" / "extracted_text.json"))):
        d = Path(os.path.dirname(et_path))
        if (d / "rich_description.txt").exists() and not args.force:
            continue
        try:
            ft = json.load(open(et_path)).get("full_text", "") or ""
        except Exception:
            continue
        if len(ft) < 200:
            continue
        todo.append((d, ft))
        if args.limit and len(todo) >= args.limit:
            break

    print(f"to generate: {len(todo)} (workers={args.workers})")
    counter = {"done": 0, "fail": 0}
    lock = threading.Lock()

    def work(item):
        d, ft = item
        gid = os.path.relpath(d, GAMES)
        try:
            desc = generate(args.model, ft, key, prompt)
        except Exception as e:
            with lock:
                counter["fail"] += 1
                print(f"  FAIL {gid}: {str(e)[:120]}")
            return
        (d / "rich_description.txt").write_text(desc)
        with lock:
            counter["done"] += 1
            n = counter["done"]
        print(f"  ok [{n}/{len(todo)}] {gid}  ({len(desc.split())} words)")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, todo))

    print(f"generated {counter['done']}, failed {counter['fail']}")


if __name__ == "__main__":
    main()
