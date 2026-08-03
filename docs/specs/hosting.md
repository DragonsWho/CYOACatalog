

# 📖 Архитектура: CYOA Cafe Game Hosting

## 1. Обзор

Мини-хостинг статических HTML/JS/CSS игр, встроенный в основной бэкенд CYOA Cafe. Пользователи загружают ZIP-архив с файлами игры, файлы распаковываются и сохраняются в Cloudflare R2, раздаются через персональные поддомены вида `username.cyoa.cafe`.

По духу — аналог Neocities, но без встроенного редактора и без цензуры NSFW-контента.

```
Загрузка:
  Браузер → POST /api/hosting/upload (ZIP + metadata)
         → main.go (hosting.go) валидация + распаковка в RAM
         → S3 PutObject → Cloudflare R2 bucket
         → PocketBase record (метаданные)

Раздача:
  Браузер → https://dragons_whore.cyoa.cafe/my-game/index.html
         → Cloudflare CDN (cache hit 99%+, Edge TTL 365 дней)
         → [cache miss] → Cloudflare Tunnel → PocketBase (:8090)
              → hosting.go middleware видит поддомен
              → S3 GetObject из R2
              → ответ с Cache-Control: immutable
              → Cloudflare кэширует на год

Лендинг:
  Браузер → https://dragons_whore.cyoa.cafe/
         → Автосгенерированный HTML со списком игр автора
         → Или кастомная homepage (если загружен slug "_home")
```

## 2. Файловая структура

```
/root/cyoa-cafe/
├── main.go              # Основной PocketBase бэкенд
│                        # Содержит: registerHostingRoutes(app) — один вызов
│
├── hosting.go           # ВСЁ про хостинг: ~500 строк
│   ├── Константы        # maxZipSize, maxFiles, maxUserGames, baseDomain
│   ├── newR2Client()    # Инициализация S3-клиента для R2
│   ├── Валидация        # isValidSlug(), allowedExtensions
│   ├── Hosting slug     # deriveHostingSlug(), ensureHostingSlug()
│   ├── Поддомены        # extractSubdomain() — парсинг Host header
│   ├── Кэш              # lookupCache — in-memory TTL кэш (5 мин)
│   ├── ZIP обработка    # findCommonPrefix(), processZipToR2()
│   ├── R2 операции      # cleanupR2() — удаление по префиксу
│   ├── Раздача          # serveFromR2() — отдача файлов с заголовками
│   ├── Лендинг          # handleLanding() — HTML страница автора
│   ├── Хелперы          # formatBytes(), isMod(), makeGameURL(), r2Prefix()
│   └── registerHostingRoutes()  # Регистрация всех роутов
│
├── reserved.go          # Список зарезервированных поддоменов (~200 имён)
│                        # map[string]bool: www, forum, brew, admin, ...
│
├── .env                 # Переменные окружения (включая R2 ключи)
│
├── pb_data/
│   └── data.db          # SQLite — коллекция hosted_games здесь
│
└── src/
    └── pages/
        └── Hosting.tsx  # UI страница загрузки/управления играми
```

## 3. Переменные окружения (.env)

```env
# R2 Storage (Cloudflare)
R2_ACCOUNT_ID=<cloudflare_account_id>       # Из R2 API Token endpoint URL
R2_ACCESS_KEY_ID=<access_key>               # R2 API Token
R2_SECRET_ACCESS_KEY=<secret_key>           # R2 API Token
R2_BUCKET_NAME=cyoa-cafe-hosting            # Имя бакета в R2

# Существующие переменные (не трогать)
TURNSTILE_SECRET_KEY=...
NODE_ENV=development|production
PB_LOG_LEVEL=...
```

Если R2 переменные не заданы — хостинг автоматически отключается, в логе появится `[hosting] WARNING: R2 env vars not set, hosting disabled`. Остальной сайт работает нормально.

## 4. PocketBase: коллекция `hosted_games`

### Поля

| Поле | Тип | Required | Описание |
|---|---|---|---|
| `owner` | Relation → users | ✅ | Владелец. Cascade delete. |
| `slug` | Text (3-60) | ✅ | URL-slug игры. Pattern: `^[a-z0-9\-]+$`. Спецзначение: `_home` = кастомная homepage |
| `title` | Text | ✅ | Название игры |
| `description` | Text | | Описание |
| `version` | Number | | Инкрементируется при каждом update |
| `size_bytes` | Number | | Суммарный размер файлов |
| `file_count` | Number | | Количество файлов |
| `status` | Select | | `active` / `hidden` / `blocked` |
| `entry_point` | Text | | Главный файл (всегда `index.html`) |
| `mod_note` | Text | | Причина скрытия/блок��ровки (для модераторов) |
| `hidden_at` | Text | | Дата скрытия (ISO, для сортировки в очереди модерации) |

### Индексы

```
UNIQUE INDEX idx_owner_slug ON hosted_games (owner, slug)
```

Один пользователь не может иметь две игры с одинаковым slug.

### API Rules

```
List/View:    ""                              (публичный)
Create:       @request.auth.id != ""          (любой залогиненный)
Update:       @request.auth.id = owner        (только владелец)
Delete:       @request.auth.id = owner        (только владелец)
```

Фактическое создание/удаление идёт через кастомные Go-эндпоинты, не через стандартный PB CRUD.

## 5. PocketBase: поле `hosting_slug` в коллекции `users`

| Поле | Тип | Описание |
|---|---|---|
| `hosting_slug` | Text (3-60) | Поддомен пользователя. Pattern: `^[a-z0-9_\-]+$` |

```
UNIQUE INDEX idx_hosting_slug ON users (hosting_slug)
```

Генерируется автоматически из `username` при первом использовании хостинга:
- `Dragons_Whore` → `dragons_whore`
- Точки заменяются на дефисы
- Проверяется на зарезервированные имена
- Проверяется уникальность (при коллизии добавляется `-2`, `-3`...)

## 6. Cloudflare R2

### Бакет

```
Имя:      cyoa-cafe-hosting
Регион:   Auto
```

### Структура хранения

```
cyoa-cafe-hosting/
└── games/                              # r2PathPrefix = "games/"
    ├── dragons_whore/                  # hosting_slug пользователя
    │   ├── my-cool-game/              # slug игры
    │   │   ├── index.html
    │   │   ├── style.css
    │   │   ├── game.js
    │   │   └── assets/
    │   │       ├── bg.avif
    │   │       └── music.mp3
    │   └── _home/                     # кастомная homepage (опционально)
    │       └── index.html
    └── another_user/
        └── adventure/
            └── index.html
```

R2 ключ формируется как: `games/{hosting_slug}/{game_slug}/{filepath}`

### API-токен

```
Permissions:  Object Read & Write
Scope:        Только бакет cyoa-cafe-hosting
```

### Лимиты бесплатного тира

| Параметр | Лимит |
|---|---|
| Хранение | 10 GB |
| Чтения (Class B) | 10M/мес |
| Записи (Class A) | 1M/мес |

При cache hit rate 99%+ чтения из R2 минимальны.

## 7. Cloudflare: DNS и Tunnel

### DNS-записи

```
*.cyoa.cafe    CNAME   <tunnel-id>.cfargotunnel.com    Proxied ☁️
cyoa.cafe      CNAME   <tunnel-id>.cfargotunnel.com    Proxied ☁️
forum          CNAME   <tunnel-id>.cfargotunnel.com    Proxied ☁️
brew           CNAME   <tunnel-id>.cfargotunnel.com    Proxied ☁️
```

Wildcard `*.cyoa.cafe` покрывается бесплатным Universal SSL (один уровень вложенности).

### Tunnel: Public Hostnames

**Порядок правил ВАЖЕН — конкретные выше, wildcard внизу:**

```
1. cyoa.cafe          → http://localhost:8090    (PocketBase, основной сайт)
2. forum.cyoa.cafe    → http://localhost:8000    (Nginx → Flarum)
3. brew.cyoa.cafe     → http://localhost:8095    (CYOABrew SPA)
4. *.cyoa.cafe        → http://localhost:8090    (PocketBase, хостинг игр)
```

Правило 4 (wildcard) стоит ПОСЛЕДНИМ. Cloudflare Tunnel проверяет правила сверху вниз, первое совпадение побеждает. Поэтому `forum.cyoa.cafe` попадает в правило 2 (Flarum), а `random_user.cyoa.cafe` проваливается до правила 4 (PocketBase).

PocketBase на `:8090` получает ВСЕ запросы к `*.cyoa.cafe`. Middleware в `hosting.go` анализирует `Host` header и решает:
- `cyoa.cafe` → `extractSubdomain()` возвращает `""` → `e.Next()` → стандартный PocketBase (SPA, API)
- `forum.cyoa.cafe` → зарезервировано → `""` → `e.Next()` (но сюда запрос и не дойдёт, Tunnel отправит в Flarum)
- `dragons_whore.cyoa.cafe` → `"dragons_whore"` → хостинг обрабатывает

### Cache Rules

```
Rule 1: "User Landing Pages"
  When:  hostname does NOT contain "cyoa.cafe" exactly
         AND hostname does NOT equal "forum.cyoa.cafe"
         AND hostname does NOT equal "brew.cyoa.cafe"
         AND URI Path equals "/"
  Then:  Edge TTL 5 minutes
         (лендинг обновляется при добавлении/удалении игр)

Rule 2: "User Game Files"
  When:  hostname does NOT equal "cyoa.cafe"
         AND hostname does NOT equal "forum.cyoa.cafe"
         AND hostname does NOT equal "brew.cyoa.cafe"
         AND URI Path does NOT equal "/"
  Then:  Edge TTL 365 days
         (файлы игр immutable, при обновлении делается purge)
```

Или упрощённый вариант (одно правило):

```
Rule: "Hosted Games Cache"
  When:  hostname does NOT equal "cyoa.cafe"
         AND hostname does NOT equal "forum.cyoa.cafe"
         AND hostname does NOT equal "brew.cyoa.cafe"
  Then:  Eligible for cache, Edge TTL 365 days
```

## 8. API-эндпоинты хостинга

### Пользовательские

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| `POST` | `/api/hosting/upload` | Да | Загрузить ZIP → новая игра |
| `POST` | `/api/hosting/update/{id}` | Да (owner) | Перезалить файлы (version++) |
| `DELETE` | `/api/hosting/games/{id}` | Да (owner) | Мягкое удаление → status=hidden |
| `GET` | `/api/hosting/my-games` | Да | Список игр + hosting_slug + homepage URL |

### Модераторские

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| `GET` | `/api/hosting/mod/queue` | Мод | Все hidden + blocked игры |
| `POST` | `/api/hosting/mod/block/{id}?reason=...` | Мод | Заблокировать (файлы остаются) |
| `POST` | `/api/hosting/mod/restore/{id}` | Мод | Восстановить → active |
| `DELETE` | `/api/hosting/mod/purge/{id}` | Мод | ОКОНЧАТЕЛЬНО удалить файлы из R2 и запись |

### Раздача (через поддомены, не через API)

| URL | Что происходит |
|---|---|
| `https://{slug}.cyoa.cafe/` | Лендинг: список игр или кастомная homepage |
| `https://{slug}.cyoa.cafe/{game}/` | index.html игры |
| `https://{slug}.cyoa.cafe/{game}/{path}` | Любой файл игры |
| `https://cyoa.cafe/play/{username}/{game}/{path}` | Legacy-редирект 301 → поддомен |

## 9. Как работает middleware роутинга

```go
// В registerHostingRoutes(), внутри app.OnServe():

se.Router.BindFunc(func(e *core.RequestEvent) error {
    // 1. Берём Host header
    host := e.Request.Host  // например: "dragons_whore.cyoa.cafe"

    // 2. (dev only) Подмена через ?_host= для локального тестирования
    if NODE_ENV == "development" && _host != "" { host = _host }

    // 3. Извлекаем поддомен
    sub := extractSubdomain(host)
    //    "dragons_whore.cyoa.cafe" → "dragons_whore"
    //    "cyoa.cafe"               → ""  (основной домен)
    //    "forum.cyoa.cafe"         → ""  (зарезервировано)

    // 4. Если не поддомен → пропускаем дальше, PocketBase обработает
    if sub == "" { return e.Next() }

    // 5. Это поддомен → парсим путь и раздаём
    //    /           → handleLanding()
    //    /game/      → serveFromR2(index.html)
    //    /game/x.js  → serveFromR2(x.js)
})
```

## 10. Статусы игр и жизненный цикл

```
                upload
    ┌──────────────────────────► active ◄──────────────┐
    │                              │                     │
    │                    автор     │ DELETE       мод     │ restore
    │                              ▼                     │
    │                           hidden ──────────────────┤
    │                              │                     │
    │                    мод       │ block                │
    │                              ▼                     │
    │                           blocked ─────────────────┘
    │                              │
    │                    мод       │ purge
    │                              ▼
    │                         ╔═══════════╗
    │                         ║  УДАЛЕНО  ║  (R2 файлы удалены, запись удалена)
    │                         ╚═══════════╝
    │
    │  active:   Игра раздаётся, видна в лендинге
    │  hidden:   Автор "удалил". Файлы в R2 ОСТАЮТСЯ. Мод решает.
    │  blocked:  Мод заблокировал. Файлы в R2 ОСТАЮТСЯ.
    │  purged:   Мод окончательно удалил. Ничего не осталось.
```

**Ключевой принцип:** пользователь НЕ может удалить файлы. Только скрыть. Модератор решает: мусор (purge) или ценная игра (restore).

## 11. Безопасность

| Угроза | Защита |
|---|---|
| **JS кража токенов** | Каждый пользователь = отдельный origin (`user.cyoa.cafe` ≠ `cyoa.cafe`). JS из игры не видит куки/localStorage основного сайта |
| **Path traversal** | `filepath.Clean()` + проверка `..` + R2 prefix-ключи |
| **Опасные файлы** | Белый список расширений (HTML, CSS, JS, изображения, шрифты, аудио, видео, WASM) |
| **ZIP bomb** | `io.LimitReader` на размер ZIP + проверка `UncompressedSize64` + лимит файлов |
| **Перезапись чужих файлов** | R2 путь = `games/{hosting_slug}/{slug}/...`, проверка ownership в PB |
| **DDoS на origin** | Cloudflare Cache (immutable, 365 дней), Cache Reserve |
| **Iframe clickjacking** | CSP `frame-ancestors` разрешает только `cyoa.cafe` |
| **Захват системных поддоменов** | `reserved.go` — ~200 зарезервированных имён |
| **Подмена поддомена через `_host`** | Только в `NODE_ENV=development` |

## 12. Лимиты

| Параметр | Значение | Где настраивается |
|---|---|---|
| Макс. размер ZIP | 200 MB | `hosting.go` → `maxZipSize` |
| Макс. файлов в ZIP | 10 000 | `hosting.go` → `maxFiles` |
| Макс. игр на аккаунт | 10 | `hosting.go` → `maxUserGames` |
| Допустимые расширения | html, css, js, json, png, jpg, gif, webp, avif, ico, svg, woff/woff2, ttf, otf, mp3, ogg, wav, mp4, webm, wasm, map, xml, txt, htm, eot | `hosting.go` → `allowedExtensions` |
| Длина slug | 3-60 символов | `hosting.go` → `isValidSlug()` + PB field validation |
| Символы slug | `a-z`, `0-9`, `-` | `hosting.go` → `isValidSlug()` |
| Символы hosting_slug | `a-z`, `0-9`, `-`, `_` | `hosting.go` → `extractSubdomain()` + PB field pattern |
| Кэш lookup в памяти | 5 минут TTL | `hosting.go` → `lookupCache` |
| Лендинг Cache-Control | 5 минут | `hosting.go` → `handleLanding()` |
| Файлы Cache-Control | 1 год, immutable | `hosting.go` → `serveFromR2()` |

## 13. Go-зависимост�� (для хостинга)

```
github.com/aws/aws-sdk-go-v2
github.com/aws/aws-sdk-go-v2/config
github.com/aws/aws-sdk-go-v2/credentials
github.com/aws/aws-sdk-go-v2/service/s3
```

Установка: `go get github.com/aws/aws-sdk-go-v2/...`

## 14. Фронтенд

### Hosting.tsx

Страница `/hosting` — доступна только залогиненным. Содержит:
- Форму загрузки (title, slug, description, ZIP файл)
- Авто-генерацию slug из title
- Список загруженных игр с URL, размером, версией, статусом
- Кнопку мягкого удаления (скрытия)
- Ссылку на homepage пользователя

API ответ `GET /api/hosting/my-games` возвращает:
```json
{
  "hosting_slug": "dragons_whore",
  "homepage": "https://dragons_whore.cyoa.cafe/",
  "games": [
    {
      "id": "abc123",
      "slug": "my-game",
      "title": "My Game",
      "url": "https://dragons_whore.cyoa.cafe/my-game/",
      "version": 2,
      "size_bytes": 1048576,
      "file_count": 42,
      "status": "active",
      ...
    }
  ]
}
```

**Важно:** `games` — это массив внутри объекта, не сам массив. Фронтенд должен делать `data.games.map(...)`, не `data.map(...)`.

## 15. Локальное тестирование

Поддомены не работают на localhost. Используется `?_host=` трюк (только в development):

```bash
# Лендинг
curl "http://localhost:8090/?_host=dragons_whore.cyoa.cafe"

# Файл игры
curl "http://localhost:8090/my-game/index.html?_host=dragons_whore.cyoa.cafe"

# API (работает как обычно, без _host)
curl -X POST http://localhost:8090/api/hosting/upload ...
curl http://localhost:8090/api/hosting/my-games ...

# Основной сайт (без _host → PocketBase как обычно)
curl http://localhost:8090/api/health
curl http://localhost:8090/
```

## 16. Массовая загрузка (Python)

Скрипт `bulk_upload.py` — лежит отдельно, не на сервере.

```bash
python bulk_upload.py ./games_folder/
```

Структура:
```
games_folder/
├── game-slug-1/       # имя папки = slug
│   ├── index.html     # обязательно
│   └── ...
├── game-slug-2/
│   └── index.html
```

Скрипт: логинится → для каждой подпапки создаёт ZIP в памяти → POST /api/hosting/upload → следующая.

## 17. Кэширование: полная цепочка

```
Запрос: https://user.cyoa.cafe/game/style.css

1. Браузер
   Cache-Control: max-age=31536000, immutable
   → Если файл в браузерном кэше и не старше года → НЕ ДЕЛАЕТ ЗАПРОС ВООБЩЕ

2. Cloudflare CDN Edge
   Cache Rule: Edge TTL 365 days
   → Если файл в edge кэше → Возвращает cf-cache-status: HIT
   → НЕ обращается к origin

3. Cloudflare Cache Reserve (R2-backed, $5/мес)
   → Если вытеснен из edge, но есть в Reserve → возвращает
   → Текущий hit rate: 99.41%

4. Origin (PocketBase → R2 GetObject)
   → Только ~0.5% запросов доходят сюда
   → in-memory кэш (5 мин TTL) для проверки "игра active?"
   → S3 GetObject из Cloudflare R2
   → Ответ с immutable заголовками → Cloudflare кэширует

При обновлении игры (update endpoint):
   → lookupCache.drop() — сбрасываем in-memory
   → TODO: Cloudflare API cache purge для URL игры
```
 