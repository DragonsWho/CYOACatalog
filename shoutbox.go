// shoutbox.go
//
// Сайтовый мини-чат (шаутбокс). Спека: wiki/components/shoutbox-spec.md (репа-стол).
// v1: одна коллекция shoutbox_messages (create/update/delete = только бэкенд),
// чтение и реалтайм — штатные PB list/subscribe (listRule публичный).
// Всё анти-спам состояние in-memory — рестарт всё обнуляет, и это ок для v1.
//
// Фиче-флаг: env SHOUTBOX_ENABLED=1. Выключен → все эндпоинты 404, фронт прячет UI.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	shoutboxCol       = "shoutbox_messages"
	shoutChannelsCol  = "shoutbox_channels"
	shoutMaxLen       = 300
	shoutKeepMessages = 999              // ночная ретенция: потолок числа сообщений
	//                                      (короткие строки — рост объёма для SQLite
	//                                      незаметен; даёт листать историю за сутки+)
	shoutKeepDays     = 30               // ...и потолок возраста: v2 обещает «месяц»
	shoutMuteDuration = 24 * time.Hour   //
	// «Онлайн» = пинговался за последние четверть часа. Не «прямо сейчас в эту
	// секунду», и это осознанно: у нас CYOA, средняя сессия — часы за одной
	// игрой, а страница за это время не перезагружается ни разу. Пинговать чаще
	// только ради точности счётчика — платить трафиком всего сайта за цифру,
	// которую всё равно никто не сверяет по секундомеру.
	//
	// Почему 15 минут, а не полчаса, как срок «человек считается активным».
	// Присутствие живёт полчаса — это про пуши и список имён: отошедшего за чаем
	// не надо ни будить, ни вычёркивать. А счётчик стоит у иконки чата и читается
	// как «нас тут столько», поэтому в него должны попадать те, кто ещё на сайте,
	// а не все, кто заглядывал за полчаса. На сайте с текучкой (пришёл из поиска,
	// посмотрел одну игру, ушёл) разница между этими окнами — разы.
	//
	// Ниже 15 минут опускать нельзя: клиент шлёт пинг не чаще раза в 10 минут и
	// только если человек шевелился, так что при более узком окне живой читатель
	// успевал бы выпасть из счётчика в паузе между своими же пингами.
	shoutOnlineWindow = 15 * time.Minute
	shoutWhoLimit     = 60 // потолок списка «кто сейчас здесь»

	// Список имён живёт не меньше счётчика. Он отвечает на «с кем я тут сижу», и
	// человек, отошедший за чаем, из него выпадать не должен: пустой список
	// читается как «я тут один», и чат от этого умирает.
	shoutWhoWindow = 30 * time.Minute

	shoutCollapseWin  = 10 * time.Minute // system-сообщения: чаще — схлопываем в батч

	// Сглаживание бейджа: мгновенный online() скачет по всплескам трафика (40↔300),
	// поэтому наружу отдаём среднее по семплам за окно (семпл раз в интервал).
	shoutSampleEvery  = 30 * time.Second
	shoutSmoothWindow = 10 * time.Minute

	// rate-limit: минимальный интервал + потолок в час
	shoutAnonMinGap  = 15 * time.Second
	shoutAnonPerHour = 20
	shoutUserMinGap  = 5 * time.Second
	shoutUserPerHour = 60
)

var shoutURLRe = regexp.MustCompile(`(?i)(https?://|www\.)`)

func shoutboxEnabled() bool {
	v := strings.ToLower(os.Getenv("SHOUTBOX_ENABLED"))
	return v == "1" || v == "true"
}

func shoutSalt() string {
	if s := os.Getenv("SHOUTBOX_ANON_SALT"); s != "" {
		return s
	}
	// Фолбэк, чтобы дев-стенд работал без .env. На проде задать свой —
	// иначе anon_key восстановим по IP простым перебором.
	return "shoutbox-dev-salt"
}

// Стоп-слова: env SHOUTBOX_WORD_FILTER="word1,word2" (список даёт автор, не в репе).
func shoutBlockedWords() []string {
	raw := os.Getenv("SHOUTBOX_WORD_FILTER")
	if raw == "" {
		return nil
	}
	var out []string
	for _, w := range strings.Split(raw, ",") {
		if w = strings.ToLower(strings.TrimSpace(w)); w != "" {
			out = append(out, w)
		}
	}
	return out
}

func shoutHash(parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(h[:])[:16]
}

// anon_key: детерминирован в пределах окна shoutAnonWindow (реплики одного анона
// различимы, у псевдо-ника есть срок жизни), между окнами не трекается. Соль
// держит ключ невосстановимым по IP.
//
// v1 брал окно в сутки — и анон, писавший вечером и ночью, выглядел двумя
// разными людьми. v2 растянул окно до недели (решение автора 2026-07-31): ник
// живёт достаточно, чтобы собеседника узнавали, и всё ещё истекает сам собой.
// Побочный эффект — мут анона теперь держится все свои 24 часа, а не спадает в
// полночь вместе со сменой ключа.
const shoutAnonWindow = 7 * 24 * time.Hour

func shoutAnonKey(ip string) string {
	bucket := time.Now().UTC().Unix() / int64(shoutAnonWindow/time.Second)
	return shoutHash(ip, shoutSalt(), strconv.FormatInt(bucket, 10))
}

// ---------------------------------------------------------------------------
// In-memory состояние (rate-limit / муты / presence / дубль-защита / батчинг)
// ---------------------------------------------------------------------------

// shoutWho — «визитка» видимого участника для списка «кто сейчас здесь».
type shoutWho struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar,omitempty"`
	Mod    bool   `json:"mod,omitempty"`
}

type presenceEntry struct {
	at    time.Time
	who   shoutWho  // пустой ID = невидимка (считается в счётчике, в списке нет)
	whoAt time.Time // когда визитку последний раз подтверждали (у неё свой срок)
}

type shoutState struct {
	mu       sync.Mutex
	lastPost map[string]time.Time     // источник → время последнего поста
	hourly   map[string][]time.Time   // источник → посты за последний час
	lastText map[string]string        // источник → текст последнего поста (дубль-защита)
	mutes    map[string]time.Time     // "u:<id>" / "a:<anon_key>" → до какого времени мут
	presence map[string]presenceEntry // ip-hash → последний ping (+ визитка)

	onlineSamples []int // кольцо семплов online() для сглаженного бейджа

	// последний system-пост — для схлопывания батча публикаций
	sysID    string
	sysAt    time.Time
	sysGames []map[string]any
}

var shout = &shoutState{
	lastPost: map[string]time.Time{},
	hourly:   map[string][]time.Time{},
	lastText: map[string]string{},
	mutes:    map[string]time.Time{},
	presence: map[string]presenceEntry{},
}

// checkAndReserve атомарно проверяет мут/лимиты/дубль и, если всё ок, резервирует
// слот под сообщение. Возвращает (httpStatus, message) при отказе; (0, "") — ок;
// (200, "dup") — молча съесть дубль.
// muted — заткнут ли источник прямо сейчас. Нужен там, где сообщение не
// создаётся, а меняется (правка): без этой проверки замученный молча продолжал
// бы «писать», переписывая своё последнее сообщение.
func (s *shoutState) muted(source string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	until, ok := s.mutes[source]
	return ok && time.Now().Before(until)
}

func (s *shoutState) checkAndReserve(source, text string, isUser bool) (int, string) {
	minGap, perHour := shoutAnonMinGap, shoutAnonPerHour
	if isUser {
		minGap, perHour = shoutUserMinGap, shoutUserPerHour
	}
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()

	if until, ok := s.mutes[source]; ok && now.Before(until) {
		return http.StatusForbidden, "You are muted."
	}
	if s.lastText[source] == text {
		return http.StatusOK, "dup" // классика «Enter дважды» — молча ок
	}
	if last, ok := s.lastPost[source]; ok && now.Sub(last) < minGap {
		return http.StatusTooManyRequests, "You're posting too fast. Give it a few seconds."
	}
	recent := s.hourly[source][:0]
	for _, t := range s.hourly[source] {
		if now.Sub(t) < time.Hour {
			recent = append(recent, t)
		}
	}
	if len(recent) >= perHour {
		s.hourly[source] = recent
		return http.StatusTooManyRequests, "Hourly message limit reached. Take a break :)"
	}
	s.hourly[source] = append(recent, now)
	s.lastPost[source] = now
	s.lastText[source] = text
	return 0, ""
}

func (s *shoutState) mute(source string) {
	s.mu.Lock()
	s.mutes[source] = time.Now().Add(shoutMuteDuration)
	s.mu.Unlock()
}

func (s *shoutState) unmute(source string) {
	s.mu.Lock()
	delete(s.mutes, source)
	s.mu.Unlock()
}

// ping — «я на сайте», без мнения о видимости. Уже показанную визитку НЕ трогает:
// пинг из шапки идёт с каждой страницы раз в минуту и раньше затирал карточку,
// поставленную чатом. Отсюда и была жалоба «минутка — и ника нет, себя не вижу».
func (s *shoutState) ping(key string) {
	s.mu.Lock()
	e := s.presence[key]
	e.at = time.Now()
	s.presence[key] = e
	s.mu.Unlock()
}

// pingAs — пинг с «визиткой»: кого показывать в списке «кто сейчас здесь».
// Видимость — осознанное действие, поэтому её присылает только сам чат.
func (s *shoutState) pingAs(key string, who shoutWho) {
	now := time.Now()
	s.mu.Lock()
	s.presence[key] = presenceEntry{at: now, who: who, whoAt: now}
	s.mu.Unlock()
}

// pingHidden — «я на сайте и прошу меня НЕ показывать». Отдельно от ping:
// «спрятаться» и «не имею мнения» — разные вещи, иначе тумблер невидимки не
// выключался бы до истечения срока карточки.
func (s *shoutState) pingHidden(key string) {
	s.mu.Lock()
	s.presence[key] = presenceEntry{at: time.Now()}
	s.mu.Unlock()
}

func (s *shoutState) online() int {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for k, e := range s.presence {
		if now.Sub(e.at) < shoutOnlineWindow {
			n++
		} else if now.Sub(e.at) >= shoutWhoWindow {
			// Подметаем только по длинному сроку: в счётчике запись уже не
			// участвует, но её визитка ещё должна висеть в списке имён.
			delete(s.presence, k)
		}
	}
	return n
}

// who — видимые участники (те, кто прислал визитку), свежие и без дублей по id.
// Порядок — по имени, чтобы список не прыгал между запросами. Режем на
// shoutWhoLimit: в чате на 300 онлайн простыня имён бесполезна.
func (s *shoutState) whoList() []shoutWho {
	now := time.Now()
	s.mu.Lock()
	seen := map[string]bool{}
	out := make([]shoutWho, 0, 16)
	for _, e := range s.presence {
		if now.Sub(e.whoAt) >= shoutWhoWindow || e.who.ID == "" || seen[e.who.ID] {
			continue
		}
		seen[e.who.ID] = true
		out = append(out, e.who)
	}
	s.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if len(out) > shoutWhoLimit {
		out = out[:shoutWhoLimit]
	}
	return out
}

// shoutPresenceKey — под каким ключом человек живёт в карте присутствия.
// Для залогиненного это ip+аккаунт, а не один ip: дома за одним роутером сидят
// двое (или один тестирует с ноута и телефона под разными аккаунтами), и на
// голом ip-хеше они делили одну ячейку — второй затирал визитку первого.
// Аноним по-прежнему по ip: другого способа его опознать нет и не надо.
func shoutPresenceKey(ip, authID string) string {
	h := shoutHash(ip, shoutSalt())
	if authID == "" {
		return h
	}
	return h + "|u:" + authID
}

// sampleOnline снимает мгновенный online() в кольцо. Вызывается тикером раз в
// shoutSampleEvery, чтобы семплы были равномерны по времени, а не привязаны к
// трафику пингов. online() берёт лок сам — семплим ДО захвата своего лока.
func (s *shoutState) sampleOnline() {
	v := s.online()
	s.mu.Lock()
	maxN := int(shoutSmoothWindow / shoutSampleEvery)
	s.onlineSamples = append(s.onlineSamples, v)
	if len(s.onlineSamples) > maxN {
		s.onlineSamples = s.onlineSamples[len(s.onlineSamples)-maxN:]
	}
	s.mu.Unlock()
}

// smoothOnline — среднее online() за окно сглаживания (гасит скачки бейджа).
// До накопления первого семпла отдаём мгновенное значение.
func (s *shoutState) smoothOnline() int {
	s.mu.Lock()
	n := len(s.onlineSamples)
	if n == 0 {
		s.mu.Unlock()
		return s.online()
	}
	sum := 0
	for _, v := range s.onlineSamples {
		sum += v
	}
	s.mu.Unlock()
	return (sum + n/2) / n // округление к ближайшему
}

// Один фоновый семплер на процесс.
var shoutSamplerOnce sync.Once

func startShoutSampler() {
	shout.sampleOnline() // первый семпл сразу, чтобы бейдж не стартовал с нуля
	go func() {
		t := time.NewTicker(shoutSampleEvery)
		defer t.Stop()
		for range t.C {
			shout.sampleOnline()
		}
	}()
}

// shoutUnreadSince — сколько сообщений создано позже since (бейдж непрочитанного).
// Таблица держится ретенцией на ≤shoutKeepMessages строк, так что COUNT по
// индексу created — копеечный даже на пике пингов; per-user джойнов нет. Пустой
// since (клиент без отметки / первый визит) → 0. since нормализуем через
// ParseDateTime, чтобы ISO-'T' от клиента и пробел в формате PB сравнивались верно.
func shoutUnreadSince(app *pocketbase.PocketBase, since string) int {
	if since == "" {
		return 0
	}
	dt, err := types.ParseDateTime(since)
	if err != nil || dt.IsZero() {
		return 0
	}
	n, err := app.CountRecords(shoutboxCol, dbx.NewExp("created > {:since}", dbx.Params{"since": dt.String()}))
	if err != nil {
		return 0
	}
	return int(n)
}

// shoutUnreadForAuth — непрочитанные для звонящего с учётом того, кто он.
// Для залогиненного источник истины — серверное поле users.shoutbox_last_seen
// (двигается эндпоинтом /seen при чтении чата): прочитал на ПК — бейдж гаснет и
// на телефоне. Пустое поле (ещё не читал) или аноним → since от клиента
// (localStorage), т.е. прежнее поведение. c.Auth заполнен, только если запрос
// принёс валидный токен (ping публичный, но фронт-SDK шлёт Authorization).
func shoutUnreadForAuth(app *pocketbase.PocketBase, c *core.RequestEvent) int {
	since := c.Request.URL.Query().Get("since")
	if c.Auth != nil && c.Auth.Collection().Name == "users" {
		if dt := c.Auth.GetDateTime("shoutbox_last_seen"); !dt.IsZero() {
			since = dt.String()
		}
	}
	return shoutUnreadSince(app, since)
}

// ---------------------------------------------------------------------------
// Ответы (reply) и уведомления (mentions/reply)
// ---------------------------------------------------------------------------

// shoutTruncate режет строку до n рун (rune-safe), добавляя многоточие.
func shoutTruncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// shoutReplySnapshot — денормализованный снимок сообщения-родителя для цитаты в
// ответе: {id, name, anon_key, text}. Живёт в самом ответе, поэтому цитата не
// ломается после удаления/ретенции оригинала. name — имя залогиненного автора
// (для анона пусто → фронт возьмёт псевдо-ник по anon_key). System-посты и
// пропавших родителей не цитируем (nil).
func shoutReplySnapshot(app core.App, parentID string) map[string]any {
	rec, err := app.FindRecordById(shoutboxCol, parentID)
	if err != nil || rec.GetString("kind") == "system" {
		return nil
	}
	name := ""
	if uid := rec.GetString("user"); uid != "" {
		if u, e := app.FindRecordById("users", uid); e == nil {
			// У части аккаунтов name пустое (OAuth, старые записи). Без запасного
			// username в снимке остаётся пустая строка, и цитата живого человека
			// показывалась бы как «Anonymous» — снимок замораживается навсегда,
			// потом уже не починить.
			name = u.GetString("name")
			if name == "" {
				name = u.GetString("username")
			}
		}
	}
	return map[string]any{
		"id":       rec.Id,
		"name":     name,
		"anon_key": rec.GetString("anon_key"),
		"text":     shoutTruncate(rec.GetString("text"), 140),
	}
}

// shoutboxNotify раскидывает уведомления колокольчика за только что отправленное
// сообщение чата: автору сообщения-родителя (ответ) и упомянутым через @username
// (упоминание). Уведомляются только залогиненные (у анонов нет стабильного
// username). Best-effort — ошибки логируем, постинг не блокируем. Дедуп: один
// юзер — одно уведомление, ответ приоритетнее упоминания; себе не шлём.
// mentionRE и правила @username общие с комментариями (main.go).
// Возвращает карту «кого задело лично» (userID → тип) — по ней push.go решает,
// кому слать веб-пуш с пометкой «тебе ответили», а кому — обычное «новое
// сообщение». Карта считается даже если коллекции notifications нет.
func shoutboxNotify(app core.App, actorID, text, replyToID string) map[string]string {
	recipients := map[string]string{} // userID -> type; первая запись побеждает
	add := func(uid, ntype string) {
		if uid == "" || uid == actorID {
			return
		}
		if _, ok := recipients[uid]; ok {
			return
		}
		recipients[uid] = ntype
	}

	if replyToID != "" {
		if r, e := app.FindRecordById(shoutboxCol, replyToID); e == nil {
			add(r.GetString("user"), "shout_reply")
		}
	}
	for _, m := range mentionRE.FindAllStringSubmatch(text, -1) {
		u, e := app.FindFirstRecordByFilter("users", "username = {:u}", dbx.Params{"u": m[2]})
		if e != nil {
			continue
		}
		add(u.Id, "shout_mention")
	}

	coll, err := app.FindCollectionByNameOrId("notifications")
	if err != nil {
		return recipients
	}
	for uid, ntype := range recipients {
		n := core.NewRecord(coll)
		n.Set("recipient", uid)
		n.Set("type", ntype)
		if actorID != "" {
			n.Set("actor", actorID)
		}
		n.Set("read", false)
		if e := app.Save(n); e != nil {
			app.Logger().Warn("shoutbox: notify failed", "type", ntype, "user", uid, "error", e.Error())
		}
	}
	return recipients
}

// ---------------------------------------------------------------------------
// Системные сообщения (анти-«пустая комната»)
// ---------------------------------------------------------------------------

// shoutboxSystemNewGame постит «🎲 New game» (или дописывает игру в свежий батч,
// если публикации идут чаще раза в 10 минут — конвейер не должен заливать чат).
// Событие всегда {type:"new_game", games:[{id,title,author}]}; фронт сам решает,
// как рендерить 1 или N. Best-effort: любая ошибка — лог и выход.
func shoutboxSystemNewGame(app core.App, gameID, title, author string) {
	if !shoutboxEnabled() {
		return
	}
	game := map[string]any{"id": gameID, "title": title, "author": author}

	shout.mu.Lock()
	batchID := shout.sysID
	batchOK := batchID != "" && time.Since(shout.sysAt) < shoutCollapseWin
	shout.mu.Unlock()

	if batchOK {
		if rec, err := app.FindRecordById(shoutboxCol, batchID); err == nil {
			shout.mu.Lock()
			shout.sysGames = append(shout.sysGames, game)
			games := append([]map[string]any{}, shout.sysGames...)
			shout.mu.Unlock()
			rec.Set("event", map[string]any{"type": "new_game", "games": games})
			rec.Set("text", fmt.Sprintf("%d new games", len(games)))
			if err := app.Save(rec); err != nil {
				app.Logger().Warn("shoutbox: batch update failed", "error", err.Error())
			}
			return
		}
		// запись удалили модераторы/ретенция — начинаем новый батч
	}

	coll, err := app.FindCollectionByNameOrId(shoutboxCol)
	if err != nil {
		app.Logger().Warn("shoutbox: collection missing, system post skipped")
		return
	}
	rec := core.NewRecord(coll)
	rec.Set("kind", "system")
	rec.Set("text", fmt.Sprintf("New game: %s by %s", title, author))
	rec.Set("event", map[string]any{"type": "new_game", "games": []map[string]any{game}})
	if err := app.Save(rec); err != nil {
		app.Logger().Warn("shoutbox: system post failed", "error", err.Error())
		return
	}
	shout.mu.Lock()
	shout.sysID, shout.sysAt = rec.Id, time.Now()
	shout.sysGames = []map[string]any{game}
	shout.mu.Unlock()
}

func shoutboxSystemAnnouncement(app core.App, title string) {
	if !shoutboxEnabled() {
		return
	}
	coll, err := app.FindCollectionByNameOrId(shoutboxCol)
	if err != nil {
		return
	}
	rec := core.NewRecord(coll)
	rec.Set("kind", "system")
	rec.Set("text", "Announcement: "+title)
	rec.Set("event", map[string]any{"type": "announcement", "title": title})
	if err := app.Save(rec); err != nil {
		app.Logger().Warn("shoutbox: announcement post failed", "error", err.Error())
	}
}

// Имя первого автора игры — для system-сообщения. Best-effort.
func shoutGameAuthor(app core.App, gameRec *core.Record) string {
	if ids := gameRec.GetStringSlice("authors"); len(ids) > 0 {
		if a, err := app.FindRecordById("authors", ids[0]); err == nil {
			if n := a.GetString("name"); n != "" {
				return n
			}
		}
	}
	return "unknown"
}

// ---------------------------------------------------------------------------
// Регистрация: роуты, хуки, ретенция
// ---------------------------------------------------------------------------

func registerShoutbox(app *pocketbase.PocketBase) {
	// Новая игра в каталоге (крон очереди, God-Mode, юзер-аплоад — любой путь
	// создания games) → system-сообщение. Update-публикации сюда не попадают.
	app.OnRecordAfterCreateSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		shoutboxSystemNewGame(app, e.Record.Id, e.Record.GetString("title"), shoutGameAuthor(app, e.Record))
		return e.Next()
	})

	app.OnRecordAfterCreateSuccess("announcements").BindFunc(func(e *core.RecordEvent) error {
		shoutboxSystemAnnouncement(app, e.Record.GetString("title"))
		return e.Next()
	})

	// Ночная ретенция: два потолка сразу — по количеству (объём БД) и по возрасту
	// (обещание «сообщения живут месяц», см. текст «Про этот чат»). Срабатывает
	// тот, что жёстче на текущем трафике.
	app.Cron().MustAdd("shoutbox_retention", "17 4 * * *", func() {
		old, err := app.FindRecordsByFilter(shoutboxCol, "", "-created", 500, shoutKeepMessages)
		if err != nil {
			return // коллекции нет / выключено — тихо выходим
		}
		for _, r := range old {
			if err := app.Delete(r); err != nil {
				app.Logger().Warn("shoutbox: retention delete failed", "id", r.Id, "error", err.Error())
			}
		}
		shoutPruneOld(app)
	})

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		g := se.Router.Group("/api/custom/shoutbox")

		if shoutboxEnabled() {
			shoutSamplerOnce.Do(startShoutSampler)
		}

		// Выключенная фича неотличима от несуществующей.
		g.BindFunc(func(c *core.RequestEvent) error {
			if !shoutboxEnabled() {
				return c.NotFoundError("Not found", nil)
			}
			// Спека §11: чат не индексируется. robots.txt закрывает весь /api/,
			// но Disallow — просьба не ходить, а не запрет показывать: ссылку на
			// голый JSON с сообщениями всё равно можно скормить индексу.
			c.Response.Header().Set("X-Robots-Tag", "noindex")
			return c.Next()
		})

		// Конфиг для фронта: жив ли шаутбокс + сколько народу онлайн.
		g.GET("/config", func(c *core.RequestEvent) error {
			return c.JSON(http.StatusOK, map[string]any{"enabled": true, "online": shout.smoothOnline()})
		})

		g.GET("/presence", func(c *core.RequestEvent) error {
			return c.JSON(http.StatusOK, map[string]any{"online": shout.smoothOnline()})
		})

		// Пинг раз в 60с пока вкладка активна; заодно вернём онлайн для бейджа
		// и СВОЙ anon_key звонящего — фронт показывает анону его псевдо-ник.
		// Именно тут, а не в GET /config: POST не кэшируется, а ключ per-IP.
		//
		// v2: залогиненный может прислать ?visible=1 — тогда он попадает в список
		// «кто сейчас здесь». По умолчанию НЕ виден: показаться — осознанное
		// действие, спрятаться — состояние по умолчанию.
		//
		// Видимостей ТРИ, а не две. `visible=1` — покажи меня, `visible=0` —
		// спрячь, параметра нет вовсе — «мнения не имею»: так пингует шапка с
		// любой страницы сайта, и трогать чужую карточку она не должна.
		g.POST("/ping", func(c *core.RequestEvent) error {
			ip := requestIP(c.Request)
			isUser := c.Auth != nil && c.Auth.Collection().Name == "users"
			authID := ""
			if isUser {
				authID = c.Auth.Id
			}
			key := shoutPresenceKey(ip, authID)

			switch v := c.Request.URL.Query().Get("visible"); {
			case (v == "1" || v == "true") && isUser:
				who := shoutWho{
					ID:     c.Auth.Id,
					Name:   c.Auth.GetString("name"),
					Avatar: c.Auth.GetString("avatar"),
					Mod:    c.Auth.GetBool("isModerator"),
				}
				if who.Name == "" {
					who.Name = c.Auth.GetString("username")
				}
				shout.pingAs(key, who)
			case v == "0" || v == "false":
				shout.pingHidden(key)
			default:
				shout.ping(key)
			}
			// Отметка «ЭТО УСТРОЙСТВО прямо сейчас в чате» — независимо от
			// видимости в списке: невидимку тоже незачем будить пушем о
			// сообщении, которое у него на экране.
			//
			// Устройство называет себя endpoint'ом своей пуш-подписки. Тело
			// необязательное: клиент v1 шлёт пустой пинг, и это нормально —
			// без подписки глушить всё равно нечего.
			var pd struct {
				Endpoint string `json:"endpoint"`
			}
			if err := c.BindBody(&pd); err == nil && pd.Endpoint != "" {
				pushActive.touch(pushDeviceKey(pd.Endpoint))
			}
			out := map[string]any{
				"online":   shout.smoothOnline(),
				"unread":   shoutUnreadForAuth(app, c),
				"anon_key": shoutAnonKey(ip),
			}
			// Отметка прочтения с СЕРВЕРА: непрочитанное фронт теперь считает сам
			// по кэшируемому «пульсу», но межустройственную синхронизацию («прочитал
			// на ноуте — погасло на телефоне») знает только сервер. Отдаём отметку,
			// а не результат подсчёта: число — дело браузера, база тут ни при чём.
			if isUser {
				if t := c.Auth.GetDateTime("shoutbox_last_seen"); !t.IsZero() {
					out["last_seen"] = t.Time().UTC().Format(time.RFC3339)
				}
			}
			// Подсветку каналов возит только пинг ОТКРЫТОГО чата (?chat=1).
			// Пинг из шапки идёт с каждой страницы у каждого посетителя — там
			// каждый лишний байт умножается на весь трафик сайта.
			if q := c.Request.URL.Query(); q.Get("chat") == "1" {
				// Открытый канал человек прямо сейчас читает — гасим «тебя звали».
				if ch := q.Get("ch"); ch != "" {
					shoutChans.seen(authID, ch)
				}
				last, mentions := shoutChans.snapshot(authID)
				out["channels"] = last
				if len(mentions) > 0 {
					out["mentions"] = mentions
				}
			}
			return c.JSON(http.StatusOK, out)
		})

		// Отметка «прочитал до сейчас» для залогиненного: двигает поле
		// users.shoutbox_last_seen — источник истины бейджа между устройствами
		// (прочитал на одном — гаснет на всех). Пишем серверным app.Save, поэтому
		// гард протектед-полей (OnRecordUpdateRequest) не срабатывает. Анонимы сюда
		// не ходят — у них read-состояние живёт только в localStorage.
		g.POST("/seen", func(c *core.RequestEvent) error {
			c.Auth.Set("shoutbox_last_seen", types.NowDateTime())
			if err := app.Save(c.Auth); err != nil {
				return c.InternalServerError("Failed to save read marker", err)
			}
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}).Bind(apis.RequireAuth())

		// Создать сообщение. Авторизация опциональна: гость = аноним.
		// v2: тело может быть и JSON, и multipart (когда приложена картинка);
		// разбор и новые поля — в shoutbox_v2.go.
		g.POST("", func(c *core.RequestEvent) error {
			isUser := c.Auth != nil && c.Auth.Collection().Name == "users"

			p, err := shoutReadPostInput(c, isUser)
			if err != nil {
				return err
			}
			text := strings.TrimSpace(p.Text)
			// Сообщение из одной картинки без подписи — законное («реакция»).
			if text == "" && p.Image == nil {
				return c.BadRequestError("Empty message", nil)
			}
			if utf8.RuneCountInString(text) > shoutMaxLen {
				return c.BadRequestError(fmt.Sprintf("Message too long (max %d characters)", shoutMaxLen), nil)
			}

			ip := requestIP(c.Request)

			var source, anonKey string
			if isUser {
				source = "u:" + c.Auth.Id
			} else {
				anonKey = shoutAnonKey(ip)
				source = "a:" + anonKey
				if shoutURLRe.MatchString(text) {
					return c.BadRequestError("Links are for logged-in users.", nil)
				}
			}

			lower := strings.ToLower(text)
			for _, w := range shoutBlockedWords() {
				if strings.Contains(lower, w) {
					return c.BadRequestError("Message rejected.", nil)
				}
			}

			// Ключ дубль-защиты — текст, но у поста с картинкой к нему
			// подмешано случайное имя файла: иначе две картинки-реакции подряд
			// (обе с пустой подписью) считались бы повтором одного сообщения.
			dupKey := text
			if p.Image != nil {
				dupKey = text + "\x00" + p.Image.Name
			}
			if status, msg := shout.checkAndReserve(source, dupKey, isUser); status != 0 {
				if msg == "dup" {
					return c.JSON(http.StatusOK, map[string]any{"ok": true, "duplicate": true})
				}
				return apis.NewApiError(status, msg, nil)
			}

			coll, err := app.FindCollectionByNameOrId(shoutboxCol)
			if err != nil {
				return c.InternalServerError("Shoutbox storage missing", err)
			}
			rec := core.NewRecord(coll)
			rec.Set("kind", "user")
			rec.Set("text", text)
			if isUser {
				rec.Set("user", c.Auth.Id)
			} else {
				rec.Set("anon_key", anonKey)
			}
			// Ответ: денормализуем снимок родителя в само сообщение (пустой
			// reply_to или пропавший родитель → просто обычное сообщение).
			replyTo := strings.TrimSpace(p.ReplyTo)
			if replyTo != "" {
				if snap := shoutReplySnapshot(app, replyTo); snap != nil {
					rec.Set("reply", snap)
				} else {
					replyTo = "" // родителя нет — уведомление об ответе не шлём
				}
			}
			// v2: канал, анонимность залогиненного, пароль на удаление, картинка.
			if err := shoutApplyV2Fields(app, c, rec, p, isUser); err != nil {
				return err
			}
			if err := app.Save(rec); err != nil {
				return c.InternalServerError("Failed to save message", err)
			}
			// Колокольчик: автору родителя (ответ) + упомянутым (@username).
			// У анонимного поста актор не указывается — иначе уведомление
			// «вам ответил X» само же и снимало бы анонимность.
			actorID := ""
			if isUser && !p.Anon {
				actorID = c.Auth.Id
			}
			targeted := shoutboxNotify(app, actorID, text, replyTo)
			// Подсветка каналов в интерфейсе: где что-то новое и где кого звали.
			// Всё в памяти — ни запроса к базе, ни поля в схеме.
			chID := rec.GetString("channel")
			shoutChans.noteMessage(chID)
			for uid := range targeted {
				shoutChans.noteMention(uid, chID)
			}
			// Веб-пуш: лично задетым — всегда, подписчикам «на всё» — если их
			// сейчас нет в чате. Уходит в фон, ответ автору не ждёт.
			shoutPushForMessage(app, rec, actorID, targeted)
			return c.JSON(http.StatusOK, map[string]any{"ok": true, "id": rec.Id})
		})

		// Автодополнение упоминаний: до 8 юзеров по подстроке username/name.
		// Имена и юзернеймы и так публичны (видны в чате/комментариях), отдаём
		// минимум полей. Гейт shoutboxEnabled — общий для группы (см. выше).
		g.GET("/users", func(c *core.RequestEvent) error {
			q := strings.TrimSpace(c.Request.URL.Query().Get("q"))
			if utf8.RuneCountInString(q) < 1 {
				return c.JSON(http.StatusOK, map[string]any{"users": []any{}})
			}
			users, err := app.FindRecordsByFilter(
				"users", "username ~ {:q} || name ~ {:q}", "username", 8, 0,
				dbx.Params{"q": q},
			)
			if err != nil {
				return c.JSON(http.StatusOK, map[string]any{"users": []any{}})
			}
			out := make([]map[string]any, 0, len(users))
			for _, u := range users {
				out = append(out, map[string]any{
					"id":       u.Id,
					"name":     u.GetString("name"),
					"username": u.GetString("username"),
					"avatar":   u.GetString("avatar"),
				})
			}
			return c.JSON(http.StatusOK, map[string]any{"users": out})
		})

		type idPayload struct {
			ID string `json:"id"`
		}
		requireMod := func(c *core.RequestEvent) (*core.Record, error) {
			if !c.Auth.GetBool("isModerator") {
				return nil, apis.NewForbiddenError("Moderators only", nil)
			}
			p := new(idPayload)
			if err := c.BindBody(p); err != nil || p.ID == "" {
				return nil, apis.NewBadRequestError("Missing id", err)
			}
			rec, err := app.FindRecordById(shoutboxCol, p.ID)
			if err != nil {
				return nil, apis.NewNotFoundError("Message not found", err)
			}
			return rec, nil
		}

		// Жёсткое удаление сообщения (модератор).
		g.POST("/delete", func(c *core.RequestEvent) error {
			rec, err := requireMod(c)
			if err != nil {
				return err
			}
			if err := app.Delete(rec); err != nil {
				return c.InternalServerError("Failed to delete message", err)
			}
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}).Bind(apis.RequireAuth())

		// Мут источника сообщения на 24ч (модератор). In-memory: рестарт снимает —
		// осознанно дёшево для v1. Анон при смене суток получает новый anon_key и
		// выходит из-под мута раньше — известное ограничение спеки.
		g.POST("/mute", func(c *core.RequestEvent) error {
			rec, err := requireMod(c)
			if err != nil {
				return err
			}
			source := shoutMuteSource(rec)
			if source == "" {
				return c.BadRequestError("System messages have no author to mute", nil)
			}
			shout.mute(source)
			app.Logger().Info("shoutbox: muted", "source", source, "by", c.Auth.Id, "message", rec.Id)
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}).Bind(apis.RequireAuth())

		// Снять мут с источника сообщения (модератор). Идемпотентно.
		g.POST("/unmute", func(c *core.RequestEvent) error {
			rec, err := requireMod(c)
			if err != nil {
				return err
			}
			if source := shoutMuteSource(rec); source != "" {
				shout.unmute(source)
			}
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}).Bind(apis.RequireAuth())

		registerShoutboxV2(app, g)

		return se.Next()
	})
}
