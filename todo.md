

поправить в профиле лейкнутые игры, что бы длинный никнейм автора на спихивал символ комментов и лайков. Пусть лучше перекрывается ими.



- починить сами чертовы лайки и кэш


- сократить передаваемые данные. Вроде как раз в 5 можно урезать, сейчас запросы дублируются.

золотая подсветка карточек по принципу "топ 5%"
Может так же топ 5% и в тегах.










- оптимизировать картинки в avif.обложки и предзагрузку
 Последовательная загрузка. а то трафик размазывается на все картинки разом.














### Проблема
25 внутренних запросов в PocketBase при `expand=authors_via_games` в `SearchPage.tsx` для каждой из 25 игр увеличивают нагрузку на сервер, так как ищут авторов через JSON-поле `games` в коллекции `authors`.

- **Файл:** `src/components/Search/SearchPage.tsx`, функция `fetchGames`.
- **Поле в базе:** `games` (JSON-массив ID игр) в коллекции `authors`.
- **Суть:** PocketBase делает по одному запросу на игру для поиска связанных авторов, что неэффективно при большом числе авторов.

### Исправление
1. **Добавить поле `authors` в `Game`:**
   - В коллекции `games` создать поле `authors` (массив ID авторов).
   - Обновить запрос: убрать `expand=authors_via_games`, добавить `authors` в `fields`.
   - Кэшировать авторов на клиенте (как теги).
2. **Миграция:**
   - Добавить `authors` в схему `games` в PocketBase.
   - Перенести данные из `authors.games` в `games.authors`.
3. **Результат:** Один запрос вместо 25, снижение нагрузки.

### TODO
"Оптимизировать `expand=authors_via_games` в `SearchPage.tsx`: добавить поле `authors` в `games`, убрать `expand`, кэшировать авторов на клиенте."
















Очисти кэш JS-файлов в Cloudflare:
    Зайди в Cloudflare:
    Перейди в "Caching" > "Configuration" > "Purge Cache".
    Выбери "Custom Purge" и метод "URL":
    Укажи URL всех JS-файлов, которые нужно очистить. На основе скриншота это:
    https://www.cyoa.cafe/assets/index-QG5SPubJ.js
    https://www.cyoa.cafe/assets/CreateGame-B2TkPXEv.js
    https://www.cyoa.cafe/assets/GameDetails-DOagQJD0.css
    https://www.cyoa.cafe/assets/GameDetails-Dy4K2SP.js
    https://www.cyoa.cafe/assets/index-BO06KB5C.css
    https://www.cyoa.cafe/assets/ListItemText-BzyGWZqOAP.js
    https://www.cyoa.cafe/assets/Profile-Cm6bwFA-js








    2. Проблема с лайками: почему не обновляются и как починить
Проблема
Лайки и теги на страницах (/, /profile, /game/*) не обновляются сразу, потому что:

Данные (лайки, теги) загружаются вместе с HTML-страницей через запрос к PocketBase (gamesCollection.getList).
Cloudflare кэширует HTML-страницы на 30 минут (Edge Cache TTL), поэтому даже если лайки/теги обновились в базе данных, пользователи видят старую версию страницы до истечения 30 минут.
Решение: Вынести лайки и теги в отдельные API-запросы
Чтобы лайки и теги обновлялись сразу, нужно:

Загружать данные отдельно через API:
Вместо загрузки лайков и тегов вместе с HTML (через gamesCollection.getList) делай отдельные API-запросы для каждого game:
Для лайков: /api/custom/upvotes/{gameId}.
Для тегов: /api/custom/tags/{gameId}.
Эти запросы можно выполнять в React через fetch или axios после загрузки страницы.
Отключить кэширование API-запросов в Cloudflare:
Создай правило в Cloudflare:
Условие: http.request.uri.path matches "/api/*".
Действие: Bypass cache.
Это гарантирует, что API-запросы всегда возвращают свежие данные.
Обновить код React:
В GameCard.tsx добавь useState и useEffect для загрузки лайков и тегов:
tsx

Collapse

Unwrap

Copy
const [upvoteCount, setUpvoteCount] = useState(game.upvotes.length);
const [tags, setTags] = useState(game.expand?.tags || []);

useEffect(() => {
  const fetchData = async () => {
    const upvoteRes = await fetch(`/api/custom/upvotes/${game.id}`);
    const upvoteData = await upvoteRes.json();
    setUpvoteCount(upvoteData.count);

    const tagsRes = await fetch(`/api/custom/tags/${game.id}`);
    const tagsData = await tagsRes.json();
    setTags(tagsData);
  };
  fetchData();
}, [game.id]);
Используй upvoteCount и tags для отображения данных вместо game.upvotes.length и game.expand?.tags.
Создай API-эндпоинты на сервере:
В PocketBase настрой маршруты:
/api/custom/upvotes/{gameId} — возвращает количество лайков для игры.
/api/custom/tags/{gameId} — возвращает список тегов для игры.
Результат
HTML-страницы будут кэшироваться (например, на 30 минут), что снижает нагрузку.
Лайки и теги будут загружаться через API-запросы, которые не кэшируются, и всегда показывать свежие данные.








наладить тестирование 
https://www.lambdatest.com/
TestingBot

https://testingbot.com/members/manual/device/new?t=manual174176155258637089



https://blisk.io/
https://saucelabs.com/pricing

https://www.browserling.com/