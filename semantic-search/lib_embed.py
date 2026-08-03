"""
Embedding helper for the semantic-search pilot.

- Talks to Google `gemini-embedding-001` over plain REST (no SDK dependency).
- Disk-caches every vector keyed by (model, dim, task_type, sha1(text)) so a
  re-run never re-pays for text we've already embedded.
- Uses batchEmbedContents to amortise round-trips.

Key is read from CYOA Harvester/.env (GEMINI_API_KEY) or
cyoa_embendings_old/.env (GOOGLE_API_KEY) — both verified working.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.request
import urllib.error
from pathlib import Path

import numpy as np

MODEL = os.environ.get("EMBED_MODEL", "gemini-embedding-001")
PILOT_DIR = Path(__file__).resolve().parent
CACHE_DIR = PILOT_DIR / "cache_vectors"
CACHE_DIR.mkdir(exist_ok=True)

_BASE = "https://generativelanguage.googleapis.com/v1beta"

# Free-tier pacing: keep under ~100 contents/min. Each batchEmbedContents
# content counts individually toward the per-minute quota. Servers embedding
# single user queries override this via EMBED_MIN_INTERVAL.
_MIN_INTERVAL = float(os.environ.get("EMBED_MIN_INTERVAL", "35"))
_last_call = 0.0


def _read_keys() -> list[str]:
    here = PILOT_DIR.parent
    candidates = [
        (PILOT_DIR / ".env", "GOOGLE_API_KEY"),   # deployed server
        (here / ".env", "GEMINI_API_KEY"),
        (here.parent / "cyoa_embendings_old" / ".env", "GOOGLE_API_KEY"),
    ]
    keys = []
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if os.environ.get(name):
            keys.append(os.environ[name])
    for path, name in candidates:
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            m = re.match(rf"\s*{name}\s*=\s*(\S+)", line)
            if m:
                k = m.group(1).strip().strip('"').strip("'")
                if k not in keys:
                    keys.append(k)
    if not keys:
        raise RuntimeError("No GEMINI_API_KEY / GOOGLE_API_KEY found in .env files")
    return keys


# Two keys = two independent Google projects = two independent quotas.
# Round-robin across them so each key sees a request only every ~2 batches,
# halving per-minute/token pressure.
_KEYS = _read_keys()
_key_idx = 0


def _cache_path(text: str, dim: int, task: str) -> Path:
    h = hashlib.sha1(f"{MODEL}|{dim}|{task}|{text}".encode()).hexdigest()
    return CACHE_DIR / f"{h}.npy"


def _post(path: str, body: dict, retries: int = 12) -> dict:
    global _last_call, _key_idx
    data = json.dumps(body).encode()
    for attempt in range(retries):
        gap = _MIN_INTERVAL - (time.time() - _last_call)
        if gap > 0:
            time.sleep(gap)
        _last_call = time.time()
        key = _KEYS[_key_idx % len(_KEYS)]
        _key_idx += 1
        url = f"{_BASE}/{path}?key={key}"
        try:
            req = urllib.request.Request(
                url, data=data, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            code = e.code
            msg = e.read()[:300]
            if code in (429, 500, 503) and attempt < retries - 1:
                wait = 90 if code == 429 else 2 ** attempt * 5
                print(f"  [embed] {code}, retry in {wait}s ({msg[:80]})")
                time.sleep(wait)
                continue
            raise RuntimeError(f"embed HTTP {code}: {msg}")
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt * 5)
                continue
            raise
    raise RuntimeError("embed: exhausted retries")


def embed_texts(
    texts: list[str], dim: int = 1536, task: str = "RETRIEVAL_DOCUMENT",
    batch: int = 30,
) -> np.ndarray:
    """Embed a list of texts → (n, dim) L2-normalised float32 array. Cached."""
    out: list[np.ndarray | None] = [None] * len(texts)
    todo: list[int] = []
    for i, t in enumerate(texts):
        cp = _cache_path(t, dim, task)
        if cp.exists():
            out[i] = np.load(cp)
        else:
            todo.append(i)

    for start in range(0, len(todo), batch):
        idxs = todo[start:start + batch]
        body = {
            "requests": [
                {
                    "model": f"models/{MODEL}",
                    "content": {"parts": [{"text": texts[i]}]},
                    "outputDimensionality": dim,
                    "taskType": task,
                }
                for i in idxs
            ]
        }
        resp = _post(f"models/{MODEL}:batchEmbedContents", body)
        embs = resp["embeddings"]
        for j, i in enumerate(idxs):
            v = np.asarray(embs[j]["values"], dtype=np.float32)
            v = v / (np.linalg.norm(v) + 1e-12)  # cosine via dot product
            np.save(_cache_path(texts[i], dim, task), v)
            out[i] = v
        print(f"  [embed] {start + len(idxs)}/{len(todo)} new vectors")

    return np.vstack([o for o in out])


def embed_query(text: str, dim: int = 1536) -> np.ndarray:
    return embed_texts([text], dim=dim, task="RETRIEVAL_QUERY")[0]
