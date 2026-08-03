// shoutbox_v2.go
//
// Дельта чата v2 к живому v1 (shoutbox.go). Спека: wiki/components/shoutbox-v2-spec.md.
// Здесь то, чего в v1 не было: каналы (в т.ч. закрытые), анонимный тумблер для
// залогиненных, гостевой пароль на удаление своего сообщения, картинки-реакции,
// список «кто сейчас здесь».
//
// Почему отдельным файлом: v1 крутится в проде и его POST-путь трогается ровно в
// одном месте (см. shoutbox.go). Всё остальное здесь — новые роуты, которые
// регистрируются в ту же группу /api/custom/shoutbox из registerShoutboxV2().

package main

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/security"
)

const (
	shoutImageMaxBytes = 2 << 20 // 2 МБ — «реакции», а не полотна CYOA
	shoutDelPassMinLen = 3
	shoutDelPassMaxLen = 64
)

// Разрешённые типы картинок. Держим в паре со схемой PB (IMG_MIME в
// PB/add_shoutbox_v2_schema.py): PB отвергнет остальное и без нас, но внятная
// 400-ка приятнее, чем «Failed to save message».
var shoutImageMIME = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// ---------------------------------------------------------------------------
// Подсветка каналов: «тут есть новое» и «тут тебя звали»
// ---------------------------------------------------------------------------

// shoutChanState — вся подсветка живёт в ПАМЯТИ и не стоит ни одного запроса к
// базе. Это осознанный размен: точные счётчики непрочитанного по каждому каналу
// потребовали бы отметки прочтения на человека×канал в схеме и группировки по
// сообщениям на каждый пинг — а показывают ровно то же, что точка «тут новое».
// Переживёт ли состояние перезапуск сервера — неважно: подсветка отвечает на
// «что изменилось, пока меня не было», и обнулиться ей не страшно.
type shoutChanState struct {
	mu       sync.Mutex
	lastMsg  map[string]time.Time            // канал → когда там последний раз писали
	recent   map[string][]int64              // канал → времена последних сообщений (unix, новые первыми)
	mentions map[string]map[string]time.Time // юзер → канал → когда его там звали
}

var shoutChans = &shoutChanState{
	lastMsg:  map[string]time.Time{},
	recent:   map[string][]int64{},
	mentions: map[string]map[string]time.Time{},
}

// Упоминание держим сутки: если человек не заходил дольше, точка «тебя звали»
// уже не новость, а археология.
const shoutMentionTTL = 24 * time.Hour

// Сколько времён сообщений на канал держим для «пульса». Это же и потолок
// счётчика в шапке: больше — «50+», а разницы между «сто непрочитанных» и
// «двести» для человека нет никакой.
const shoutPulseKeep = 50

// noteMessage — в канале что-то написали. Пустой id = дефолтный канал (старые
// сообщения и посты без явного канала).
func (s *shoutChanState) noteMessage(chID string) {
	now := time.Now()
	s.mu.Lock()
	s.lastMsg[chID] = now
	// Новые — в голову списка: так обрезка хвоста выбрасывает самые старые.
	ts := append([]int64{now.Unix()}, s.recent[chID]...)
	if len(ts) > shoutPulseKeep {
		ts = ts[:shoutPulseKeep]
	}
	s.recent[chID] = ts
	s.mu.Unlock()
}

// pulse — времена последних сообщений по разрешённым каналам. Ответ одинаков
// для всех, кто его спросит: в нём нет ни одного персонального байта, поэтому
// его целиком отдаёт край сети (Cloudflare), а число непрочитанного каждый
// браузер считает у себя — сравнивает эти времена со своей отметкой прочтения.
//
// Закрытые каналы сюда не попадают НИКОГДА: сам факт «в закрытой комнате сейчас
// оживление» — уже утечка, а ответ по определению общий.
func (s *shoutChanState) pulse(allow map[string]bool) map[string][]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string][]int64, len(s.recent))
	for ch, ts := range s.recent {
		if !allow[ch] {
			continue
		}
		cp := make([]int64, len(ts))
		copy(cp, ts)
		out[ch] = cp
	}
	return out
}

// seedFromDB — набить «пульс» из базы при первом запросе после старта. Без него
// каждый рестарт сервера обнулял бы всем счётчик непрочитанного: состояние
// живёт в памяти. Один запрос за всё время жизни процесса.
func (s *shoutChanState) seedFromDB(app core.App) {
	recs, err := app.FindRecordsByFilter(shoutboxCol, "", "-created", shoutPulseKeep*8, 0)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range recs { // уже отсортированы «новые первыми»
		ch := r.GetString("channel")
		if len(s.recent[ch]) >= shoutPulseKeep {
			continue
		}
		t := r.GetDateTime("created").Time()
		s.recent[ch] = append(s.recent[ch], t.Unix())
		if s.lastMsg[ch].IsZero() {
			s.lastMsg[ch] = t
		}
	}
}

func (s *shoutChanState) noteMention(userID, chID string) {
	if userID == "" {
		return
	}
	s.mu.Lock()
	if s.mentions[userID] == nil {
		s.mentions[userID] = map[string]time.Time{}
	}
	s.mentions[userID][chID] = time.Now()
	s.mu.Unlock()
}

// seen — человек смотрит этот канал: гасим «тебя звали». Точку «тут новое»
// гасит сам фронт, у него для этого есть своя отметка на устройство.
func (s *shoutChanState) seen(userID, chID string) {
	if userID == "" {
		return
	}
	s.mu.Lock()
	if m := s.mentions[userID]; m != nil {
		delete(m, chID)
		if len(m) == 0 {
			delete(s.mentions, userID)
		}
	}
	s.mu.Unlock()
}

// snapshot — что отдать фронту в пинге: время последнего сообщения по каналам
// (секунды unix — короче ISO-строк втрое) и список каналов, где звали этого
// человека. Десяток каналов = пара сотен байт, и только когда открыт чат.
func (s *shoutChanState) snapshot(userID string) (map[string]int64, []string) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	last := make(map[string]int64, len(s.lastMsg))
	for ch, t := range s.lastMsg {
		last[ch] = t.Unix()
	}

	var mentions []string
	if m := s.mentions[userID]; m != nil {
		for ch, t := range m {
			if now.Sub(t) >= shoutMentionTTL {
				delete(m, ch)
				continue
			}
			mentions = append(mentions, ch)
		}
		if len(m) == 0 {
			delete(s.mentions, userID)
		}
	}
	return last, mentions
}

// ---------------------------------------------------------------------------
// Каналы
// ---------------------------------------------------------------------------

// shoutChannel — канал в том виде, в каком его видит фронт.
type shoutChannel struct {
	ID      string `json:"id"`
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Desc    string `json:"description,omitempty"`
	Private bool   `json:"is_private,omitempty"`
}

// shoutVisibleChannels — каналы, которые звонящему можно и видеть, и читать.
// Публичные — всем; закрытые — только тем, кто в members. Правило продублировано
// здесь и в listRule коллекции: тут оно формирует меню, там — режет выдачу PB.
// Расходиться им нельзя, иначе в меню будет канал, из которого не грузятся
// сообщения.
// Нет коллекции каналов (старая схема, свежий локальный стенд) — не ошибка, а
// «каналов нет»: фронт покажет одну ленту, как в v1.
func shoutVisibleChannels(app core.App, authID string) ([]shoutChannel, error) {
	recs, err := app.FindRecordsByFilter(shoutChannelsCol, "enabled = true", "sort,slug", 100, 0)
	if err != nil {
		return []shoutChannel{}, nil //nolint:nilerr
	}
	out := make([]shoutChannel, 0, len(recs))
	for _, r := range recs {
		if r.GetBool("is_private") && !shoutIsMember(r, authID) {
			continue
		}
		out = append(out, shoutChannel{
			ID:      r.Id,
			Slug:    r.GetString("slug"),
			Title:   r.GetString("title"),
			Desc:    r.GetString("description"),
			Private: r.GetBool("is_private"),
		})
	}
	return out, nil
}

func shoutIsMember(ch *core.Record, authID string) bool {
	if authID == "" {
		return false
	}
	for _, id := range ch.GetStringSlice("members") {
		if id == authID {
			return true
		}
	}
	return false
}

// shoutResolveChannel переводит slug из запроса в запись канала и заодно решает,
// имеет ли звонящий право туда писать. Пустой slug = дефолтный канал (первый по
// sort), чтобы старые клиенты и системные посты не оставались без канала.
//
// Возвращает (nil, nil), если каналов вообще нет — тогда сообщение пишется с
// пустым channel, ровно как в v1. Это не ошибка: чат должен работать и на голой
// схеме без единого канала.
func shoutResolveChannel(app core.App, slug, authID string) (*core.Record, error) {
	slug = strings.TrimSpace(strings.ToLower(slug))
	if slug == "" {
		recs, err := app.FindRecordsByFilter(shoutChannelsCol, "enabled = true && is_private = false", "sort,slug", 1, 0)
		if err != nil || len(recs) == 0 {
			return nil, nil //nolint:nilerr // нет каналов — пишем без канала, как v1
		}
		return recs[0], nil
	}
	rec, err := app.FindFirstRecordByFilter(shoutChannelsCol, "slug = {:slug}", dbx.Params{"slug": slug})
	if err != nil {
		return nil, apis.NewNotFoundError("Unknown channel", nil)
	}
	if !rec.GetBool("enabled") {
		return nil, apis.NewNotFoundError("Channel is closed", nil)
	}
	if rec.GetBool("is_private") && !shoutIsMember(rec, authID) {
		// 404, а не 403: существование закрытого канала — тоже приватная деталь.
		return nil, apis.NewNotFoundError("Unknown channel", nil)
	}
	return rec, nil
}

// ---------------------------------------------------------------------------
// Гостевой пароль на удаление
// ---------------------------------------------------------------------------

// Пароль на удаление хранится как "<соль>:<хеш>" в скрытом поле del_pass.
// Соль своя у каждого сообщения — иначе одинаковый пароль давал бы одинаковый
// хеш, и по базе можно было бы связать посты одного гостя между собой. Это не
// защита секрета (пароль одноразовый и живёт минуты), а именно развязка постов.
//
// Соль пришлось хранить рядом, а не выводить из id сообщения: id у записи PB
// появляется только в момент Save, а хеш нужен раньше — на этом первая версия и
// сломалась (пароль писался под пустой id и потом никогда не сходился).
func shoutDelPassMake(pass string) string {
	salt := security.RandomStringWithAlphabet(12, core.DefaultIdAlphabet)
	return salt + ":" + shoutHash("delpass", shoutSalt(), salt, pass)
}

func shoutDelPassMatch(stored, pass string) bool {
	salt, want, ok := strings.Cut(stored, ":")
	if !ok || salt == "" || want == "" || pass == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want),
		[]byte(shoutHash("delpass", shoutSalt(), salt, pass))) == 1
}

// ---------------------------------------------------------------------------
// Право удалить своё сообщение
// ---------------------------------------------------------------------------

var errShoutNotOwner = errors.New("not the author")

// shoutCanDeleteOwn — может ли звонящий снести это сообщение как своё.
// Три двери, в порядке убывания надёжности:
//  1. залогинен и он автор (в т.ч. автор анонимного поста — по скрытому author_ref);
//  2. анон с тем же anon_key (то есть тот же IP в пределах окна);
//  3. кто угодно, кто знает пароль, оставленный при отправке.
//
// Модератор ходит не сюда, а в v1-ручку /delete.
func shoutCanDeleteOwn(rec *core.Record, authID, anonKey, pass string) error {
	if rec.GetString("kind") == "system" {
		return errShoutNotOwner
	}
	if authID != "" && (rec.GetString("user") == authID || rec.GetString("author_ref") == authID) {
		return nil
	}
	if ak := rec.GetString("anon_key"); ak != "" && ak == anonKey {
		return nil
	}
	if h := rec.GetString("del_pass"); h != "" && shoutDelPassMatch(h, pass) {
		return nil
	}
	return errShoutNotOwner
}

// shoutMuteSource — ключ мута по сообщению: кого именно затыкает модератор.
// Порядок важен. Анонимный пост залогиненного (v2-тумблер) хранит настоящего
// автора в скрытом author_ref, и мутить надо ЕГО, а не anon_key: иначе человек
// уходит из-под мута простым выключением тумблера. Голый anon_key остаётся
// только для гостей, и он же теперь живёт неделю (shoutAnonWindow), так что
// суточный мут больше не спадает в полночь сам собой.
//
// Пустая строка = system-сообщение, мутить некого.
func shoutMuteSource(rec *core.Record) string {
	if uid := rec.GetString("user"); uid != "" {
		return "u:" + uid
	}
	if uid := rec.GetString("author_ref"); uid != "" {
		return "u:" + uid
	}
	if ak := rec.GetString("anon_key"); ak != "" {
		return "a:" + ak
	}
	return ""
}

// ---------------------------------------------------------------------------
// Пульс: один кэшируемый ответ на всех
// ---------------------------------------------------------------------------

var (
	shoutPulseSeedOnce sync.Once
	shoutPulseCache    struct {
		mu   sync.Mutex
		at   time.Time
		body map[string]any
	}
)

const shoutPulseTTL = 5 * time.Second

func shoutPulseBody(app core.App) map[string]any {
	shoutPulseCache.mu.Lock()
	defer shoutPulseCache.mu.Unlock()
	if shoutPulseCache.body != nil && time.Since(shoutPulseCache.at) < shoutPulseTTL {
		return shoutPulseCache.body
	}

	shoutPulseSeedOnce.Do(func() { shoutChans.seedFromDB(app) })

	// Пустой authID — на выходе ровно публичные каналы, что и требуется: ответ
	// общий, закрытым комнатам в нём места нет. Ключ "" — сообщения без канала
	// (написанные до появления комнат), они живут в дефолтной.
	allow := map[string]bool{"": true}
	chans, _ := shoutVisibleChannels(app, "")
	for _, ch := range chans {
		allow[ch.ID] = true
	}

	shoutPulseCache.body = map[string]any{
		"online": shout.smoothOnline(),
		"t":      shoutChans.pulse(allow),
	}
	shoutPulseCache.at = time.Now()
	return shoutPulseCache.body
}

// ---------------------------------------------------------------------------
// Роуты v2
// ---------------------------------------------------------------------------

func registerShoutboxV2(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	// Меню каналов. Аноним видит только публичные.
	g.GET("/channels", func(c *core.RequestEvent) error {
		authID := ""
		if c.Auth != nil {
			authID = c.Auth.Id
		}
		chans, err := shoutVisibleChannels(app, authID)
		if err != nil {
			return c.InternalServerError("Failed to load channels", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"channels": chans})
	})

	// «Пульс» — ЕДИНСТВЕННЫЙ запрос, который делает страница сайта с закрытым
	// чатом. Ответ одинаков для всех до последнего байта, поэтому его отдаёт
	// край сети: при миллионе посетителей до нашего сервера доходит один запрос
	// в 10 секунд, остальное разливает Cloudflare бесплатно.
	//
	// Внутри — счётчик онлайна и времена последних сообщений по публичным
	// каналам. Число непрочитанного браузер считает сам, сравнивая эти времена
	// со своей отметкой прочтения: посчитать полсотни чисел дешевле, чем сходить
	// за ответом ещё раз, а главное — считать МОЖНО у себя, а вот персональный
	// ответ пришлось бы каждому готовить отдельно и нигде нельзя было бы кэшировать.
	//
	// Пятисекундный кэш в памяти — страховка на случай, если правило кэширования
	// в Cloudflare не настроено или сброшено: без него эндпоинт всё равно стоит
	// один запрос к базе в пять секунд на весь сайт.
	g.GET("/pulse", func(c *core.RequestEvent) error {
		// Кэш браузера — 10с, край сети может ещё минуту отдавать протухший,
		// пока обновляет его в фоне: лучше секунда неточности в счётчике, чем
		// толпа запросов в origin в момент истечения кэша.
		c.Response.Header().Set("Cache-Control", "public, max-age=10, stale-while-revalidate=50")
		return c.JSON(http.StatusOK, shoutPulseBody(app))
	})

	// «Кто сейчас здесь». Отдаём и счётчик, и список видимых — фронт рисует
	// «12 онлайн» плюс имена тех, кто не спрятался.
	g.GET("/who", func(c *core.RequestEvent) error {
		return c.JSON(http.StatusOK, map[string]any{
			"online": shout.smoothOnline(),
			"who":    shout.whoList(),
		})
	})

	// Удалить своё сообщение: автор (залогиненный или по anon_key) либо гость с
	// паролем. Сообщение сносится совсем — «удалено» плашкой не оставляем, иначе
	// удаление опечатки превращается в вечный памятник ей.
	type delOwnPayload struct {
		ID      string `json:"id"`
		DelPass string `json:"del_pass"`
	}
	g.POST("/delete-own", func(c *core.RequestEvent) error {
		var p delOwnPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.ID) == "" {
			return c.BadRequestError("Missing id", err)
		}
		rec, err := app.FindRecordById(shoutboxCol, strings.TrimSpace(p.ID))
		if err != nil {
			return c.NotFoundError("Message not found", err)
		}
		authID := ""
		if c.Auth != nil {
			authID = c.Auth.Id
		}
		anonKey := shoutAnonKey(requestIP(c.Request))
		if err := shoutCanDeleteOwn(rec, authID, anonKey, p.DelPass); err != nil {
			// Одинаковый ответ на «не твоё» и «пароль не тот»: иначе ручка
			// становится оракулом «а это сообщение написано с твоего IP?».
			return c.ForbiddenError("Can't delete this message", nil)
		}
		if err := app.Delete(rec); err != nil {
			return c.InternalServerError("Failed to delete message", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	})

	// Правка своего сообщения. Пометку «изменено» держит отдельное поле, а не
	// расхождение updated с created (как у комментариев): у сообщения чата
	// updated бьёт любая служебная запись — закреп, снятие закрепа, — и лента
	// подписывала бы «(edited)» сообщения, к которым автор не притрагивался.
	// Право на правку — то же, что на удаление: свой пост, свой anon_key или
	// пароль гостя.
	//
	// Картинку правка не трогает: заменить её — это уже другое сообщение.
	// Уведомления на новые @упоминания тоже не шлём, иначе правка становится
	// способом дёргать людей сколько угодно раз одним и тем же сообщением.
	type editPayload struct {
		ID      string `json:"id"`
		Text    string `json:"text"`
		DelPass string `json:"del_pass"`
	}
	g.POST("/edit", func(c *core.RequestEvent) error {
		var p editPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.ID) == "" {
			return c.BadRequestError("Missing id", err)
		}
		rec, err := app.FindRecordById(shoutboxCol, strings.TrimSpace(p.ID))
		if err != nil {
			return c.NotFoundError("Message not found", err)
		}
		authID := ""
		if c.Auth != nil {
			authID = c.Auth.Id
		}
		anonKey := shoutAnonKey(requestIP(c.Request))
		if err := shoutCanDeleteOwn(rec, authID, anonKey, p.DelPass); err != nil {
			return c.ForbiddenError("Can't edit this message", nil)
		}
		if src := shoutMuteSource(rec); src != "" && shout.muted(src) {
			return c.ForbiddenError("You are muted.", nil)
		}
		text := strings.TrimSpace(p.Text)
		if utf8.RuneCountInString(text) > shoutMaxLen {
			return apis.NewBadRequestError("Message is too long.", nil)
		}
		// Пустой текст допустим только у сообщения с картинкой — иначе правкой
		// можно было бы стереть сообщение в ничто, оставив пустую строку в ленте.
		if text == "" && rec.GetString("image") == "" {
			return apis.NewBadRequestError("Empty message.", nil)
		}
		rec.Set("text", text)
		rec.Set("edited", true)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to save message", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	})

	// Закрепить сообщение в его комнате (модератор). Закреп — свойство самого
	// сообщения, а не комнаты: так его видно в общей ленте «все комнаты» ровно
	// там же, где оно и живёт, и не нужно отдельного поля у канала.
	type pinPayload struct {
		ID     string `json:"id"`
		Pinned bool   `json:"pinned"`
	}
	g.POST("/pin", func(c *core.RequestEvent) error {
		if !c.Auth.GetBool("isModerator") {
			return c.ForbiddenError("Moderators only", nil)
		}
		var p pinPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.ID) == "" {
			return c.BadRequestError("Missing id", err)
		}
		rec, err := app.FindRecordById(shoutboxCol, strings.TrimSpace(p.ID))
		if err != nil {
			return c.NotFoundError("Message not found", err)
		}
		rec.Set("pinned", p.Pinned)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to pin message", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	}).Bind(apis.RequireAuth())
}

// ---------------------------------------------------------------------------
// Хелперы, которые дёргает POST из shoutbox.go
// ---------------------------------------------------------------------------

// shoutApplyV2Fields навешивает на новую запись всё, что добавила v2: канал,
// анонимность залогиненного, пароль на удаление, картинку. Вызывается из
// POST-обработчика ДО app.Save.
//
// Про анонимность: у сообщения либо user (обычный пост), либо author_ref
// (скрытое поле — «на самом деле это он»). Второе поле hidden, наружу PB его не
// отдаёт; нужно оно ровно для двух вещей — чтобы человек мог снести свой
// анонимный пост с любого устройства и чтобы модератор мог замутить источник, а
// не бесконечно гоняться за IP.
func shoutApplyV2Fields(app core.App, c *core.RequestEvent, rec *core.Record, in shoutPostInput, isUser bool) error {
	authID := ""
	if isUser {
		authID = c.Auth.Id
	}

	ch, err := shoutResolveChannel(app, in.Channel, authID)
	if err != nil {
		return err
	}
	if ch != nil {
		rec.Set("channel", ch.Id)
	}

	if isUser && in.Anon {
		rec.Set("user", "")
		rec.Set("author_ref", authID)
		rec.Set("anon_key", shoutAnonKey(requestIP(c.Request)))
	}

	if p := strings.TrimSpace(in.DelPass); p != "" {
		if n := utf8.RuneCountInString(p); n < shoutDelPassMinLen || n > shoutDelPassMaxLen {
			return apis.NewBadRequestError(fmt.Sprintf(
				"Delete password must be %d–%d characters.", shoutDelPassMinLen, shoutDelPassMaxLen), nil)
		}
		rec.Set("del_pass", shoutDelPassMake(p))
	}

	if in.Image != nil {
		rec.Set("image", in.Image)
	}
	return nil
}

// shoutPostInput — то, что POST вытащил из запроса (JSON или multipart).
type shoutPostInput struct {
	Text    string
	ReplyTo string
	Channel string
	Anon    bool
	DelPass string
	Image   *filesystem.File
}

// shoutReadPostInput разбирает тело POST-а. Два формата: обычный JSON (как в v1)
// и multipart, когда к сообщению приложена картинка. Различаем по Content-Type.
//
// Картинки — только залогиненным: у анонимной загрузки файлов слишком короткий
// путь от «мемчик» до «нам прилетело то, что хостить нельзя».
func shoutReadPostInput(c *core.RequestEvent, isUser bool) (shoutPostInput, error) {
	var in shoutPostInput

	ct := c.Request.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "multipart/form-data") {
		var p struct {
			Text    string `json:"text"`
			ReplyTo string `json:"reply_to"`
			Channel string `json:"channel"`
			Anon    bool   `json:"anon"`
			DelPass string `json:"del_pass"`
		}
		if err := c.BindBody(&p); err != nil {
			return in, apis.NewBadRequestError("Invalid payload", err)
		}
		in.Text, in.ReplyTo, in.Channel = p.Text, p.ReplyTo, p.Channel
		in.Anon, in.DelPass = p.Anon, p.DelPass
		return in, nil
	}

	if err := c.Request.ParseMultipartForm(shoutImageMaxBytes + (1 << 20)); err != nil {
		return in, apis.NewBadRequestError("Invalid form", err)
	}
	in.Text = c.Request.FormValue("text")
	in.ReplyTo = c.Request.FormValue("reply_to")
	in.Channel = c.Request.FormValue("channel")
	in.DelPass = c.Request.FormValue("del_pass")
	in.Anon = c.Request.FormValue("anon") == "1" || c.Request.FormValue("anon") == "true"

	fh, _, err := c.Request.FormFile("image")
	if err != nil {
		return in, nil // картинки нет — это нормальный текстовый пост
	}
	defer fh.Close()

	if !isUser {
		return in, apis.NewForbiddenError("Images are for logged-in users.", nil)
	}
	hdrs := c.Request.MultipartForm.File["image"]
	if len(hdrs) == 0 {
		return in, nil
	}
	h := hdrs[0]
	if h.Size > shoutImageMaxBytes {
		return in, apis.NewBadRequestError("Image is too big (max 2 MB).", nil)
	}
	// Тип берём из заголовка части. Это подсказка клиента, а не истина, но
	// последнее слово всё равно за PB: у поля image в схеме свой mimeTypes,
	// который проверяется по реальному содержимому при сохранении.
	if !shoutImageMIME[h.Header.Get("Content-Type")] {
		return in, apis.NewBadRequestError("Only JPEG, PNG, GIF or WebP images.", nil)
	}
	f, err := filesystem.NewFileFromMultipart(h)
	if err != nil {
		return in, apis.NewBadRequestError("Can't read the image", err)
	}
	in.Image = f
	return in, nil
}

// ---------------------------------------------------------------------------
// Ретенция по возрасту
// ---------------------------------------------------------------------------

// shoutPruneOld сносит сообщения старше shoutKeepDays. Работает в паре со старой
// ретенцией по количеству: та держит потолок объёма, эта — обещание «сообщения
// живут месяц». Что сработает первым, то и сработает.
func shoutPruneOld(app core.App) {
	cutoff := time.Now().UTC().Add(-time.Duration(shoutKeepDays) * 24 * time.Hour)
	old, err := app.FindRecordsByFilter(shoutboxCol, "created < {:cut}", "created", 500, 0,
		dbx.Params{"cut": cutoff.Format("2006-01-02 15:04:05.000Z")})
	if err != nil {
		app.Logger().Warn("shoutbox: age retention query failed", "error", err.Error())
		return
	}
	for _, r := range old {
		if err := app.Delete(r); err != nil {
			app.Logger().Warn("shoutbox: age retention delete failed", "id", r.Id, "error", err.Error())
		}
	}
	if len(old) > 0 {
		app.Logger().Info("shoutbox: pruned old messages", "count", len(old), "older_than_days", shoutKeepDays)
	}
}
