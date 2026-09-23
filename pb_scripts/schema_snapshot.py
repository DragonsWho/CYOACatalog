#!/usr/bin/env python3
"""Write pb_schema.json: the collection schema that `make seed` builds a local DB from.

Run by the maintainer against production after schema changes (`make schema-snapshot`), then
commit the diff. Read-only on the server. The output is public, so it is sanitized: system
collections are dropped (a fresh PocketBase creates its own), OAuth2 providers and anything that
looks like a secret are stripped, timestamps are removed and keys sorted for stable diffs.

  PB_ENV_FILE=<prod .env> python3 pb_scripts/schema_snapshot.py   # prod
  python3 pb_scripts/schema_snapshot.py                          # local dev server
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pblib  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "pb_schema.json"
SECRET_KEY = re.compile(r"secret|password|apikey|api_key", re.I)


def scrub(o):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in ("created", "updated"):
                continue
            if SECRET_KEY.search(k) and isinstance(v, str) and v:
                continue  # never publish a credential, whatever collection it hides in
            out[k] = scrub(v)
        return out
    if isinstance(o, list):
        return [scrub(x) for x in o]
    return o


def main() -> None:
    url, email, password = pblib.target_from_env()
    pb = pblib.PB(url, email, password)
    cols = []
    for c in pb.collections():
        if c.get("system"):
            continue
        c = scrub(c)
        if isinstance(c.get("oauth2"), dict):
            c["oauth2"]["providers"] = []
            c["oauth2"]["enabled"] = False
        cols.append(c)
    cols.sort(key=lambda c: c["name"])
    OUT.write_text(json.dumps(cols, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"wrote {OUT.name}: {len(cols)} collections from {pb.url}")


if __name__ == "__main__":
    main()
