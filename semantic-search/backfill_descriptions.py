"""
Одноразовый backfill: заливает rich-описания в скрытое поле games.rich_description
прод-PB, чтобы истина жила в облаке, а поисковый сервер обновлялся автономно.

Что льём: те же тексты, что использует build_catalog_index.py —
rich_description.txt с диска и legacy-summary из старой games.db.
Источник `catalog` (title+description) НЕ льём — он и так выводим из записи.

Уже заполненные поля пропускаются (если без --force) — скрипт идемпотентен.

Перед массовым прогоном:
  1. снапшот записей: tools/pb_records_backup/ (страховка перед PATCH'ем)
  2. канарейка:  python backfill_descriptions.py --apply --limit 1
     → проверить сайт + что аноним поле НЕ видит
  3. масса:      python backfill_descriptions.py --apply

Требует: схема уже накачена (PB/add_rich_description_field.py --apply),
PB_SUPERUSER_* и SITE_API_URL в CYOA Harvester/.env.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from build_catalog_index import fetch_catalog, map_to_local_dirs, legacy_summaries, UA

HARVEST = Path(__file__).resolve().parent.parent


def _load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


_ENV = _load_env(HARVEST / ".env")


def _env(name: str) -> str | None:
    return _ENV.get(name)


PB_API = (_env("SITE_API_URL") or "https://cyoa.cafe/api").rstrip("/")


def _pb(method: str, path: str, data: dict | None = None, token: str | None = None) -> dict:
    headers = {"User-Agent": UA["User-Agent"], "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    req = urllib.request.Request(
        f"{PB_API}{path}",
        data=json.dumps(data).encode() if data is not None else None,
        headers=headers, method=method,
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="без флага — dry-run")
    ap.add_argument("--limit", type=int, default=0, help="канарейка: первые N")
    ap.add_argument("--force", action="store_true", help="перезаписывать заполненные")
    args = ap.parse_args()

    token = _pb("POST", "/collections/_superusers/auth-with-password",
                {"identity": _env("PB_SUPERUSER_EMAIL"),
                 "password": _env("PB_SUPERUSER_PASSWORD")})["token"]

    # текущее состояние поля (superuser видит hidden)
    filled, page = {}, 1
    while True:
        d = _pb("GET", f"/collections/games/records?perPage=200&page={page}"
                "&fields=id,rich_description", token=token)
        for it in d["items"]:
            filled[it["id"]] = bool((it.get("rich_description") or "").strip())
        if page >= d["totalPages"]:
            break
        page += 1

    catalog = fetch_catalog()
    dirs = map_to_local_dirs(catalog)
    legacy = legacy_summaries()

    todo = []
    for g in catalog:
        d = dirs.get(g["id"])
        if d and (d / "rich_description.txt").exists():
            t = (d / "rich_description.txt").read_text().strip()
            if len(t) > 100:
                todo.append((g, t, "rich"))
                continue
        if g["id"] in legacy:
            todo.append((g, legacy[g["id"]].strip(), "legacy"))

    skip_filled = 0 if args.force else sum(1 for g, *_ in todo if filled.get(g["id"]))
    if not args.force:
        todo = [x for x in todo if not filled.get(x[0]["id"])]
    if args.limit:
        todo = todo[: args.limit]

    print(f"PB: {len(filled)} games, уже заполнено {sum(filled.values())}; "
          f"к заливке {len(todo)} (пропущено заполненных: {skip_filled})")
    if not args.apply:
        for g, t, src in todo[:10]:
            print(f"  would PATCH {g['id']}  {src:6}  {g['title'][:50]}")
        print("  ... (dry-run, добавь --apply)")
        return

    failures = []
    for i, (g, text, src) in enumerate(todo, 1):
        try:
            _pb("PATCH", f"/collections/games/records/{g['id']}",
                {"rich_description": text}, token=token)
            print(f"  [{i}/{len(todo)}] {src:6} {g['title'][:55]}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:400]
            failures.append((g["id"], g["title"], e.code, body))
            print(f"  [{i}/{len(todo)}] FAIL {e.code} {g['title'][:45]} :: {body}")
        time.sleep(0.3)  # не душить прод
    print(f"done, ошибок: {len(failures)}")
    for gid, title, code, body in failures:
        print(f"  {gid}  {code}  {title[:50]}\n    {body}")


if __name__ == "__main__":
    main()
