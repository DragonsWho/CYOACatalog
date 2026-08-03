# Semantic search v2 — выкат и обновление

Замена `cyoa_embendings/` (256 dim, FAISS) на новый индекс
(gemini-embedding-001 @ 1536, desc-only, numpy). Порт тот же — 8100,
nginx и фронт не трогаем. `id` в ответе — настоящий PocketBase record id.

**Истина — в PB:** rich-описания хранятся в скрытом поле
`games.rich_description` (анониму не отдаётся, трафик сайта не растёт).
Сервер раз в сутки сам сверяется с каталогом и доэмбеддивает новое —
ручной reindex после публикаций НЕ нужен.

## Состав

| Файл | Что это |
|---|---|
| `server.py` | FastAPI `/api/semantic-search` + `/healthz` + автосинк раз в SYNC_HOURS |
| `build_catalog_index.py` | первичная сборка индекса с локальных рипов (уже сделана) |
| `backfill_descriptions.py` | одноразовая заливка описаний в PB (584 шт: rich+legacy) |
| `../../PB/add_rich_description_field.py` | накатка скрытого поля (games + game_pipeline_state) |
| `index/catalog_vecs.npy` + `index/catalog_meta.json` | сам индекс (row-aligned, с хэшами текстов) |
| `Makefile` / `semantic-search-v2.service` | деплой-обвязка |

## Порядок выката (делает автор)

```bash
# 1. Схема: скрытое поле в games и game_pipeline_state
python PB/add_rich_description_field.py            # dry-run
python PB/add_rich_description_field.py --apply

# 2. (страховка) снапшот записей games: tools/pb_records_backup/

# 3. Backfill описаний в PB — канарейка, проверка, масса
cd "CYOA Harvester/embed_pilot"
python backfill_descriptions.py --apply --limit 1
#   → проверить: сайт жив, аноним поле НЕ видит:
#   curl -s 'https://cyoa.cafe/api/collections/games/records?perPage=1' | grep -c rich_description  → 0
python backfill_descriptions.py --apply            # ~5 мин (584 PATCH)

# 4. Сервер
make deploy-setup    # один раз: venv + systemd-юнит
# на сервере: cp /root/semantic-search/.env /root/semantic-search-v2/.env
#   (нужны GOOGLE_API_KEY и EMAIL/PASSWORD — оба уже там)
make deploy          # код + индекс
make switchover      # гасит старый сервис, включает v2, curl /healthz
make rollback        # откат на старый, если что
```

Проверка UI: `https://cyoa.cafe/semantic-search` — карточки открываются
по `/game/<id>`. `/healthz` показывает `last_sync` после первого синка.

## Как живёт дальше (автономно)

- Дрип-фид публикует игру → у неё в PB есть `rich_description`
  (пайплайн прикладывает; для игр без него — fallback на title+описание,
  игра всё равно ищется) → ночной синк сервера сам её доэмбеддит.
- Удалённые из каталога игры выпадают из индекса при том же синке.
- Предохранитель: если за один синк меняется >20% текстов (признак
  проблем со схемой/кредами) — синк отменяется, в журнале ABORT;
  осознанно форсировать: `SYNC_FORCE=1`.
- Ручки: `SYNC_HOURS` (0 = выключить синк), `EMBED_MIN_INTERVAL`.
- Лог запросов: `queries.tsv` рядом с сервером (UTC, запрос, топ-1).

`build_catalog_index.py`/`make reindex` остаются для пересборки с локальных
рипов (например после массовой перегенерации описаний) — для повседневных
новых игр не нужны.

## Пайплайн (сделано 2026-06-12)

s06b стейджит `rich_description` в game_pipeline_state (если у игры есть
`<local_dir>/rich_description.txt`), Go-воркер копирует его в games при
publish (только непустое — пустой стейджинг не затирает backfill каталога).
Требует редеплоя Go-бинаря (делает автор).

Генерация тоже встроена: s04_describe после metadata.json best-effort
генерит rich_description.txt (тот же промпт `prompt_description_v2.txt`,
модель `RICH_DESCRIPTION_MODEL`, дефолт платная gemma-4-31b-it — однородность
корпуса). Провал генерации НЕ валит шаг: игра без файла ищется по fallback
(title+каталожное описание), ночной синк подхватит rich при появлении.
`gen_descriptions.py` остаётся массовым/backfill-инструментом.
