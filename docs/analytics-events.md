# Analytics events

Two independent systems track behaviour on cyoa.cafe:

1. **Google Analytics 4** (`G-G0CC5DZ5ZZ`) — custom events for "what did people
   do". Emitted through `src/utils/analytics.ts` (+ real-playtime via
   `src/utils/useGamePlaytime.ts`).
2. **First-party view counter** — a same-origin counter that ad-blockers can't
   drop (important on an NSFW audience). Frontend `src/utils/gameViews.ts`,
   backend `view_counter.go`. Currently surfaced only on `/moderator/stats`.

---

## 1. GA4 custom events

| Event | Params | Fires when |
|-------|--------|-----------|
| `search` | `source` (header/catalog), `has_query`, `tag_count`, `author_count` | full catalog search submitted (header bar) |
| `semantic_search` | `source` (page/catalog), `query_len` | natural-language search run |
| `tab_switch` | `tab` | catalog tab changed (recent/top/liked/tags/random/similar/semantic) |
| `filter_toggle` | `mode` (sfw/nsfw/all) | content filter changed |
| `tag_vote` | `game_id`, `tag_id`, `action` | tag vote cast (upvote/downvote/clear) |
| `game_upvote` | `game_id`, `active` | game like toggled |
| `comment_post` | `game_id`, `is_reply` | comment or reply posted |
| `comment_like` | `active` | comment like toggled |
| `cheat_build_saved` | `game_id`, `is_public` | a build saved from inside a hosted game |
| `game_play` | `game_id`, `hosted` | an interactive game view becomes actively played (once per view) |
| `game_heartbeat` | `game_id`, `seconds`, `hosted` | every ~15s of *engaged* play + a final partial slice |

Pre-existing events kept as-is: `page_view` (manual, App/GameDetails),
`select_content` (game page), `shoutbox_opened`, `shoutbox_posted`.

### Why `game_heartbeat` exists

GA's built-in engagement timer only counts activity on the **top** document. An
interactive CYOA runs in an iframe, so once the player clicks in, GA sees nothing
and every `/game/*` page reports ~15s regardless of real playtime. `game_heartbeat`
measures "tab visible AND window focused" ourselves (`document.hasFocus()` stays
true when focus is inside the iframe) and reports it in slices.

**Real playtime per game = SUM(`game_heartbeat.seconds`) grouped by `game_id`.**

### One-time GA admin setup — register custom dimensions

Event params only show up in the standard reports once registered. In GA4:
**Admin → Custom definitions → Custom dimensions → Create**, scope = *Event*:

| Dimension name | Event parameter |
|----------------|-----------------|
| Game | `game_id` |
| Hosted | `hosted` |
| Search source | `source` |
| Catalog tab | `tab` |
| Filter mode | `mode` |
| Tag action | `action` |

(In **Explore** and the **BigQuery export** these params are queryable without
registering — registration is only for the canned reports.)

Recommended: enable **Admin → BigQuery Links** for raw event-level analysis of
the silent audience (free tier).

---

## 2. First-party view counter

- **Write:** `POST /api/custom/games/{id}/view` (public, validates the game
  exists). Frontend pings it once per browser session per game from
  `GameDetails` via `recordGameView()` (sessionStorage dedup).
- **Read (moderator only):** `GET /api/custom/mod/game-views?limit=N` → top games
  by count joined with title. Rendered at `/moderator/stats`.
- **Storage:** additive `game_views` collection `{game (unique), count, updated}`,
  auto-created on server boot. Increment is an atomic SQL `count = count + 1`.

⚠️ **Before prod:** first boot after deploy creates the `game_views` collection.
That is the only schema change in this feature and it never alters existing
collections. The counter is not shown in the public UI yet — only `/moderator/stats`.

---

## 3. Подробная инструкция по настройке GA (по-русски, с нуля)

Ты уже вставила на сайт GA4 (тег `G-G0CC5DZ5ZZ`), и сами события после деплоя
начнут прилетать в Google автоматически — **код уже всё шлёт**. Но чтобы Google
показывал их в удобных отчётах (а не только в сыром потоке), надо один раз руками
зайти в консоль и кое-что «объявить». Ниже — что, где и зачем. Порядок не критичен,
но удобнее идти сверху вниз.

### Важно понять три вещи заранее

1. **Событие (event)** — это факт «что-то произошло»: поиск, лайк, heartbeat игры.
   Наш код шлёт их сам, регистрировать события НЕ надо, они появятся сами.
2. **Параметр (parameter)** — доп. данные внутри события: у `tag_vote` есть
   `game_id`, `action` и т.д. Они тоже прилетают сами, но чтобы Google **показывал
   их в таблицах** — параметр надо один раз «зарегистрировать как custom dimension»
   (см. шаг 2). Это и есть главная ручная настройка.
3. **Данные идут с задержкой.** В отчётах новое событие может появиться через
   24–48 часов. Есть только одно место, где всё видно **сразу** — Realtime и
   DebugView (шаг 4). Не пугайся, если в первый день отчёты пустые.

---

### Шаг 0. Как войти и не потеряться

1. Открой <https://analytics.google.com>, войди тем же Google-аккаунтом, что и
   раньше.
2. Слева внизу — шестерёнка **Admin (Администратор)**. Почти вся настройка там.
3. Экран Admin поделён на 2 колонки: **Account** (аккаунт) и **Property**
   (ресурс/сайт). Нам почти всегда нужна **правая колонка — Property**. Убедись,
   что вверху правой колонки выбран ресурс cyoa.cafe.

---

### Шаг 1. Пометить ключевые события как «конверсии» (по желанию, но полезно)

Это чтобы Google считал важные действия отдельно (например, «сохранил билд»,
«поиграл в игру»).

1. Admin → правая колонка → **Events (События)**.
2. Дождись, пока в списке появятся наши события (после деплоя и первых заходов
   людей — обычно на след. день). Это `search`, `game_play`, `tag_vote` и т.д.
3. Напротив нужного события есть тумблер **«Mark as key event / Пометить как
   ключевое событие»** — включи для тех, что считаешь важными (советую: `game_play`,
   `cheat_build_saved`, `comment_post`, `tag_vote`).

Если события ещё не появились — просто вернись сюда через день. Этот шаг можно
пропустить, на сбор данных он не влияет.

---

### Шаг 2. ⭐ ГЛАВНОЕ: зарегистрировать параметры (Custom dimensions)

Без этого шага параметры прилетают, но в таблицах ты их не увидишь — только общее
число событий. Делается один раз на каждый параметр.

1. Admin → правая колонка → **Custom definitions (Специальные определения)**.
2. Вкладка **Custom dimensions** → синяя кнопка **Create custom dimension
   (Создать)**.
3. Заполни поля:
   - **Dimension name** — любое понятное имя (напр. `Game`).
   - **Scope (Область)** — выбери **Event (Событие)**. Это важно.
   - **Description** — можно оставить пустым.
   - **Event parameter** — сюда ВПИШИ ТОЧНОЕ имя параметра из таблицы ниже
     (напр. `game_id`). Регистр и подчёркивания важны.
4. Save. Повтори для каждой строки таблицы:

   | Dimension name (имя, любое) | Event parameter (вписать точно) |
   |------------------------------|----------------------------------|
   | Game                         | `game_id`                        |
   | Hosted                       | `hosted`                         |
   | Search source                | `source`                         |
   | Catalog tab                  | `tab`                            |
   | Filter mode                  | `mode`                           |
   | Tag action                   | `action`                         |

   Отдельно, чтобы считать **реальное время в игре**, заведи ещё одну —
   **как метрику, не dimension**:
   - вкладка **Custom metrics** → **Create custom metric**;
   - Metric name: `Play seconds`; Scope: Event; Event parameter: `seconds`;
     Unit of measurement: **Standard** (или Seconds, если будет в списке).

⏳ У Google лимит: 50 custom dimensions и 50 custom metrics на ресурс — нам хватает
с огромным запасом.

---

### Шаг 3. Как потом смотреть эти данные — отчёт Exploration

Стандартные отчёты (левое меню «Reports») показывают в основном страницы и число
людей. Чтобы копаться в наших параметрах — нужен раздел **Explore (Исследования)**.

1. Левое меню → **Explore (Исследования)** → **Blank / Пустой**.
2. Слева колонки **Dimensions** и **Metrics** с плюсиком **+**. Нажми **+** у
   Dimensions → найди и добавь, например, `Game` (это наша custom dimension из
   шага 2) и `Event name`. Нажми **+** у Metrics → добавь `Event count` и
   `Play seconds`.
3. Перетащи `Game` в поле **Rows**, `Event count`/`Play seconds` — в **Values**.
4. Сверху можно поставить фильтр по конкретному событию (напр. `Event name` =
   `game_heartbeat`), чтобы увидеть суммарное время игры по каждой игре.

Пример полезных исследований:
- **Топ игр по реальному времени:** Rows = `Game`, фильтр `Event name` =
  `game_heartbeat`, Values = `Play seconds` (сумма). Это то самое «сколько реально
  играют», чего GA сам не показывал.
- **Чем пользуются:** Rows = `Event name`, Values = `Event count` — видно
  соотношение поиска/лайков/голосований/комментов.
- **Семантический vs обычный поиск:** фильтр `Event name` содержит `search`,
  Rows = `Event name` + `Search source`.

---

### Шаг 4. Проверить, что события реально долетают (сразу, без ожидания)

Чтобы не гадать день, работает ли всё:

- **Realtime (В реальном времени):** левое меню → **Reports → Realtime**. Зайди
  на сайт в другой вкладке, поищи, лайкни — в течение ~минуты события должны
  всплыть в карточке «Event count by Event name».
- **DebugView (для детальной отладки):** Admin → **DebugView**. Показывает поток
  событий одного отладочного устройства с параметрами. Чтобы твой браузер туда
  попал — проще всего поставить расширение **Google Analytics Debugger** и включить
  его, либо открыть сайт с `?debug_mode=1`. Тогда видно каждое событие и все его
  параметры (game_id, seconds и т.д.) — удобно убедиться, что данные правильные.

---

### Шаг 5. (Рекомендую) Включить экспорт в BigQuery — бесплатно

Это даёт доступ к **сырым событиям** и возможность считать что угодно SQL-запросами,
без ограничений интерфейса. Для NSFW-аудитории, которую режет адблок, это самый
честный слой данных.

1. Admin → правая колонка → **BigQuery links (Связи с BigQuery)** → **Link**.
2. Следуй мастеру (нужен Google Cloud проект — мастер поможет создать бесплатный).
   Выбери **Daily** экспорт (бесплатный тариф).

Это опционально и требует немного возни с Google Cloud — можно отложить. Все базовые
вопросы («сколько играют», «чем пользуются») закрываются шагами 2–3 без BigQuery.

---

### Короткая шпаргалка «что вообще делать»

1. Задеплоить (это делаешь ты) → события начнут копиться.
2. Один раз: Admin → Custom definitions → создать 6 dimensions + 1 metric из шага 2.
3. Проверить в Realtime, что события летят (шаг 4).
4. Через день-два смотреть данные через Explore (шаг 3).
5. По желанию: пометить ключевые события (шаг 1) и включить BigQuery (шаг 5).

Если что-то не находится по названию — интерфейс GA бывает на русском и на
английском; в скобках я дал оба варианта названий кнопок.
