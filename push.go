// push.go
//
// Веб-пуши (Web Push / VAPID). Ради них затевался уход с дискорда: без пуша
// сайтовый чат «догоняет» человека только когда он сам зайдёт, а дискорд — сразу.
//
// Подписки лежат в коллекции push_subscriptions (наружу не читается вообще,
// listRule/viewRule = nil; всё через эти эндпоинты под суперюзерским app.Save).
// Одна запись = одно устройство (браузер выдаёт свой endpoint на каждое).
//
// Фиче-флаг: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY в env. Ключей нет — эндпоинты
// отвечают 404, фронт прячет тумблер. Пара ключей делается командой
//
//	./dist/serve push-keys
//
// и кладётся в .env один раз: сменишь ключи — все существующие подписки
// протухнут разом, браузеры их не перевыпустят.

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
	"github.com/spf13/cobra"
)

const (
	pushSubsCol = "push_subscriptions"
	// Устройств на человека: телефон + ноут + рабочий браузер — три, пять с
	// запасом. Дальше самые старые вытесняются, иначе коллекция копит мусор от
	// каждого приватного окна.
	pushMaxPerUser = 5
	// TTL на пуш-сервисе: сутки. Сообщение в чате протухает быстрее письма —
	// уведомление «тебе ответили» через неделю только раздражает.
	pushTTL = 24 * 60 * 60
	// Тише системного звонка: чат не будильник.
	pushUrgency = webpush.UrgencyNormal
	// Не будим того, кто и так в чате: пинг presence моложе этого = человек
	// смотрит на ленту своими глазами.
	pushActiveWindow = 2 * time.Minute
	// Пауза между фоновыми пушами на одно устройство: оживший чат будит человека
	// один раз, а не на каждое сообщение. Сбрасывается, как только он зашёл
	// почитать. Адресных пушей (ответ, @упоминание) не касается.
	pushFloodWindow = 10 * time.Minute
)

func pushKeys() (pub, priv string) {
	return os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY")
}

func pushEnabled() bool {
	pub, priv := pushKeys()
	return pub != "" && priv != ""
}

// pushSubject — «кто шлёт» в VAPID JWT. Пуш-сервисы (особенно Apple) хотят
// контакт на случай, если отправитель начнёт спамить.
func pushSubject() string {
	if s := os.Getenv("VAPID_SUBJECT"); s != "" {
		return s
	}
	return "mailto:admin@cyoa.cafe"
}

// pushPayload — то, что service worker получит в событии push. Держим плоским и
// коротким: пуш-сервисы ограничивают тело ~4 КБ, и класть туда текст сообщения
// целиком незачем — приватность важнее полноты (см. spec §11).
type pushPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

// ---------------------------------------------------------------------------
// Отправка
// ---------------------------------------------------------------------------

// pushSendTo шлёт одно уведомление на одну подписку. Возвращает «подписка
// мертва» — тогда запись надо снести: браузер отозвал регистрацию (переустановка,
// очистка данных, отключённые уведомления), и она больше никогда не оживёт.
func pushSendTo(sub *core.Record, body []byte) (dead bool, err error) {
	pub, priv := pushKeys()
	s := &webpush.Subscription{
		Endpoint: sub.GetString("endpoint"),
		Keys: webpush.Keys{
			P256dh: sub.GetString("p256dh"),
			Auth:   sub.GetString("auth"),
		},
	}
	resp, err := webpush.SendNotification(body, s, &webpush.Options{
		Subscriber:      pushSubject(),
		VAPIDPublicKey:  pub,
		VAPIDPrivateKey: priv,
		TTL:             pushTTL,
		Urgency:         pushUrgency,
	})
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	// 404/410 — канонический ответ «этой подписки больше нет». Остальные коды
	// (429, 5xx) временные: подписку не трогаем, уведомление просто теряем.
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return true, fmt.Errorf("subscription gone (%d)", resp.StatusCode)
	}
	if resp.StatusCode >= 300 {
		return false, fmt.Errorf("push failed (%d)", resp.StatusCode)
	}
	return false, nil
}

// pushSendBatch рассылает пуш на конкретные подписки. Именно на подписки, а не
// на людей: у одного человека телефон может стоять на «будить на всё», а
// рабочий ноут — на «только адресное». Рассылка по userID звонила бы на обоих.
//
// Синхронная отправка на несколько устройств заблокировала бы HTTP-ответ автору
// сообщения, поэтому вызывается в горутине (см. pushAsync).
func pushSendBatch(app core.App, subs []*core.Record, p pushPayload) {
	if !pushEnabled() || len(subs) == 0 {
		return
	}
	body, err := json.Marshal(p)
	if err != nil {
		return
	}
	for _, sub := range subs {
		dead, err := pushSendTo(sub, body)
		switch {
		case dead:
			if e := app.Delete(sub); e != nil {
				app.Logger().Warn("push: delete dead sub failed", "error", e.Error())
			}
		case err != nil:
			app.Logger().Warn("push: send failed", "error", err.Error())
		default:
			sub.Set("last_ok", types.NowDateTime())
			if e := app.Save(sub); e != nil {
				app.Logger().Warn("push: last_ok save failed", "error", e.Error())
			}
		}
	}
}

// pushAsync — точка вызова из обработчиков запросов: отправка уходит в фон,
// автор сообщения не ждёт круга по пуш-сервисам. Best-effort по определению.
func pushAsync(app core.App, subs []*core.Record, p pushPayload) {
	if !pushEnabled() || len(subs) == 0 {
		return
	}
	go pushSendBatch(app, subs, p)
}

// pushSubsOfUser — все устройства человека, независимо от режима. Адресное
// уведомление («тебе ответили») режим не спрашивает: на то оно и адресное.
func pushSubsOfUser(app core.App, userID string) []*core.Record {
	if !pushEnabled() || userID == "" {
		return nil
	}
	subs, err := app.FindRecordsByFilter(pushSubsCol,
		"user = {:u}", "-created", 0, 0, dbx.Params{"u": userID})
	if err != nil {
		return nil
	}
	return subs
}

// pushToUsers — «всем устройствам этих людей». Осталась для /test и прочих
// точечных отправок, где режим устройства значения не имеет.
func pushToUsers(app core.App, userIDs []string, p pushPayload) {
	var subs []*core.Record
	for _, uid := range userIDs {
		subs = append(subs, pushSubsOfUser(app, uid)...)
	}
	pushSendBatch(app, subs, p)
}

// ---------------------------------------------------------------------------
// Кому слать: подписчики «на всё»
// ---------------------------------------------------------------------------

// pushSubsAll — устройства, выставленные на «будить на любое сообщение».
// Выкидываем устройства автора, тех, кому уже ушло адресное, и те, что прямо
// сейчас смотрят в чат.
//
// Проверка «сейчас смотрит» — поустройственная. Раньше она была по человеку, и
// открытая вкладка на ноуте затыкала пуши на телефон: с точки зрения сервера
// человек «в чате», хотя в руках у него другое устройство.
func pushSubsAll(app core.App, exclude map[string]bool) []*core.Record {
	if !pushEnabled() {
		return nil
	}
	subs, err := app.FindRecordsByFilter(pushSubsCol, "mode = 'all'", "", 0, 0)
	if err != nil {
		return nil
	}
	out := make([]*core.Record, 0, len(subs))
	for _, s := range subs {
		uid := s.GetString("user")
		if uid == "" || exclude[uid] || pushActive.active(pushDeviceKey(s.GetString("endpoint"))) {
			continue
		}
		out = append(out, s)
	}
	return out
}

// pushChatURL — куда ведёт клик по уведомлению. Пока чат живёт на скрытой
// странице-полигоне; переедет на публичный адрес — менять здесь.
const pushChatURL = "/chat-lab"

// shoutPushForMessage — пуши за одно отправленное сообщение чата.
//
// Две группы получателей с разными правилами:
//   - задетые лично (ответ, @упоминание) — будим всегда, даже если человек в
//     чате: он мог отвернуться от вкладки, а обращение адресное;
//   - подписчики «все сообщения» — только если их в чате сейчас нет.
//
// Анонимный пост остаётся анонимным и в пуше: имени автора там просто нет.
func shoutPushForMessage(app core.App, rec *core.Record, actorID string, targeted map[string]string) {
	if !pushEnabled() {
		return
	}

	author := "Anonymous"
	if actorID != "" {
		if u, err := app.FindRecordById("users", actorID); err == nil {
			if n := strings.TrimSpace(u.GetString("name")); n != "" {
				author = n
			} else if n := strings.TrimSpace(u.GetString("username")); n != "" {
				author = n
			}
		}
	}
	// Текст в теле уведомления — то, ради чего пуш и открывают. Режем коротко:
	// экран блокировки всё равно покажет полторы строки, а лишнее там висит на
	// виду у любого, кто заглянул через плечо.
	body := shoutTruncate(strings.TrimSpace(rec.GetString("text")), 90)
	if body == "" && rec.GetString("image") != "" {
		body = "sent a picture"
	}

	// Канал в заголовке: в режиме отдельных комнат без него непонятно, куда
	// возвращаться.
	//
	// members != nil — сообщение из закрытого канала. Тогда пуш (а в нём лежит
	// текст!) уходит ТОЛЬКО участникам: правило чтения коллекции постороннего в
	// закрытую комнату не пустит, но пуш идёт мимо правил, и подписчик «на всё»
	// прочитал бы чужую переписку прямо на экране блокировки.
	room := ""
	var members map[string]bool
	if chID := rec.GetString("channel"); chID != "" {
		if ch, err := app.FindRecordById(shoutChannelsCol, chID); err == nil {
			room = ch.GetString("title")
			if ch.GetBool("is_private") {
				members = map[string]bool{}
				for _, uid := range ch.GetStringSlice("members") {
					members[uid] = true
				}
			}
		} else {
			// Канал есть, но не читается — молчим целиком: лучше не доставить
			// уведомление, чем доставить его не туда.
			return
		}
	}
	allowed := func(uid string) bool { return members == nil || members[uid] }

	// Один тег на сообщение: несколько пушей подряд схлопываются в одну
	// нотификацию вместо стопки одинаковых «новое сообщение».
	for uid, ntype := range targeted {
		if !allowed(uid) {
			continue // упомянули постороннего в закрытой комнате — не наше дело
		}
		title := author + " mentioned you"
		if ntype == "shout_reply" {
			title = author + " replied to you"
		}
		if room != "" {
			title += " — " + room
		}
		pushAsync(app, pushSubsOfUser(app, uid), pushPayload{
			Title: title, Body: body, URL: pushChatURL, Tag: "shout-" + rec.Id,
		})
	}

	exclude := map[string]bool{}
	if actorID != "" {
		exclude[actorID] = true
	}
	for uid := range targeted {
		exclude[uid] = true // им уже ушло адресное
	}
	rest := pushSubsAll(app, exclude)
	if members != nil {
		kept := rest[:0]
		for _, s := range rest {
			if members[s.GetString("user")] {
				kept = append(kept, s)
			}
		}
		rest = kept
	}
	// Антифлуд — ПОСЛЕ отбора по членству в закрытом канале: иначе устройство
	// сожгло бы паузу на сообщение, которое ему всё равно не отправят.
	if len(rest) > 0 {
		kept := rest[:0]
		for _, s := range rest {
			if pushActive.allowBlast(pushDeviceKey(s.GetString("endpoint"))) {
				kept = append(kept, s)
			}
		}
		rest = kept
	}
	if len(rest) > 0 {
		title := "CYOA.CAFE chat"
		if room != "" {
			title = room + " — CYOA.CAFE"
		}
		pushAsync(app, rest, pushPayload{
			Title: title, Body: author + ": " + body, URL: pushChatURL, Tag: "shout-new",
		})
	}
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

func registerPushRoutes(app *pocketbase.PocketBase, se *core.ServeEvent) {
	g := se.Router.Group("/api/custom/push")

	// Публичный ключ VAPID нужен браузеру до всякой авторизации — на нём
	// строится PushManager.subscribe(). Ключей нет → enabled:false, и фронт
	// просто не рисует тумблер (404 тут был бы неотличим от «сервер старый»).
	g.GET("/key", func(c *core.RequestEvent) error {
		pub, _ := pushKeys()
		return c.JSON(http.StatusOK, map[string]any{
			"enabled":    pushEnabled(),
			"public_key": pub,
		})
	})

	if !pushEnabled() {
		return
	}

	// Подписка устройства. endpoint уникален (индекс в схеме), поэтому повтор —
	// это upsert: браузер переприсылает ту же подписку при каждом заходе, и
	// плодить записи нельзя.
	g.POST("/subscribe", func(c *core.RequestEvent) error {
		var in struct {
			Endpoint string `json:"endpoint"`
			P256dh   string `json:"p256dh"`
			Auth     string `json:"auth"`
			Mode     string `json:"mode"`
		}
		if err := c.BindBody(&in); err != nil {
			return c.BadRequestError("Invalid body", err)
		}
		in.Endpoint = strings.TrimSpace(in.Endpoint)
		if in.Endpoint == "" || in.P256dh == "" || in.Auth == "" {
			return c.BadRequestError("Incomplete subscription", nil)
		}
		if len(in.Endpoint) > 512 {
			return c.BadRequestError("Endpoint too long", nil)
		}
		mode := "mentions"
		if in.Mode == "all" {
			mode = "all"
		}

		rec, err := app.FindFirstRecordByFilter(pushSubsCol,
			"endpoint = {:e}", dbx.Params{"e": in.Endpoint})
		if err != nil {
			coll, e := app.FindCollectionByNameOrId(pushSubsCol)
			if e != nil {
				return c.InternalServerError("Push storage missing", e)
			}
			rec = core.NewRecord(coll)
		}
		rec.Set("user", c.Auth.Id)
		rec.Set("endpoint", in.Endpoint)
		rec.Set("p256dh", in.P256dh)
		rec.Set("auth", in.Auth)
		rec.Set("mode", mode)
		if ua := c.Request.UserAgent(); ua != "" {
			rec.Set("ua", shoutTruncate(ua, 250))
		}
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to save subscription", err)
		}
		pushTrimUser(app, c.Auth.Id, rec.Id)
		return c.JSON(http.StatusOK, map[string]any{"ok": true, "mode": mode})
	}).Bind(apis.RequireAuth())

	// Отписка. Своё удаляем, чужое молча игнорируем: сообщать «такая подписка
	// есть, но не твоя» незачем — endpoint по сути секрет.
	g.POST("/unsubscribe", func(c *core.RequestEvent) error {
		var in struct {
			Endpoint string `json:"endpoint"`
		}
		if err := c.BindBody(&in); err != nil {
			return c.BadRequestError("Invalid body", err)
		}
		if rec, err := app.FindFirstRecordByFilter(pushSubsCol,
			"endpoint = {:e}", dbx.Params{"e": strings.TrimSpace(in.Endpoint)}); err == nil {
			if rec.GetString("user") == c.Auth.Id {
				if err := app.Delete(rec); err != nil {
					return c.InternalServerError("Failed to delete subscription", err)
				}
			}
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	}).Bind(apis.RequireAuth())

	// Проверка «дошло ли вообще»: шлёт пуш самому себе. Без неё диагностика
	// пушей превращается в гадание — тихо не приходят и всё.
	g.POST("/test", func(c *core.RequestEvent) error {
		pushToUsers(app, []string{c.Auth.Id}, pushPayload{
			Title: "CYOA.CAFE",
			Body:  "Test notification — push is working.",
			URL:   "/chat-lab",
			Tag:   "push-test",
		})
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	}).Bind(apis.RequireAuth())
}

// pushTrimUser держит число устройств человека в пределах pushMaxPerUser,
// вытесняя самые старые. keepID — только что записанная подписка, её не трогаем
// даже если она почему-то оказалась старейшей.
func pushTrimUser(app core.App, userID, keepID string) {
	subs, err := app.FindRecordsByFilter(pushSubsCol,
		"user = {:u}", "-created", 0, 0, dbx.Params{"u": userID})
	if err != nil || len(subs) <= pushMaxPerUser {
		return
	}
	for _, s := range subs[pushMaxPerUser:] {
		if s.Id == keepID {
			continue
		}
		if e := app.Delete(s); e != nil {
			app.Logger().Warn("push: trim failed", "error", e.Error())
		}
	}
}

// ---------------------------------------------------------------------------
// CLI: генерация ключей
// ---------------------------------------------------------------------------

// registerPushKeysCmd добавляет `serve push-keys` — печатает свежую пару VAPID в
// формате строк .env. Отдельным скриптом это заводить не хочется: ключи нужны
// ровно тому бинарю, который потом ими подписывает.
func registerPushKeysCmd(app *pocketbase.PocketBase) {
	app.RootCmd.AddCommand(&cobra.Command{
		Use:   "push-keys",
		Short: "Сгенерировать пару ключей VAPID для веб-пушей",
		Run: func(cmd *cobra.Command, args []string) {
			priv, pub, err := webpush.GenerateVAPIDKeys()
			if err != nil {
				fmt.Println("ошибка генерации:", err)
				return
			}
			fmt.Println("# Веб-пуши: положить в .env и перезапустить сервер.")
			fmt.Println("# Смена ключей обнуляет ВСЕ существующие подписки.")
			fmt.Println("VAPID_PUBLIC_KEY=" + pub)
			fmt.Println("VAPID_PRIVATE_KEY=" + priv)
			fmt.Println("VAPID_SUBJECT=mailto:admin@cyoa.cafe")
		},
	})
}

// ---------------------------------------------------------------------------
// Учёт «человек прямо сейчас в чате»
// ---------------------------------------------------------------------------

// Пуш тому, кто смотрит на ту же ленту, — чистое раздражение (телефон в руке
// звенит о сообщении, которое уже на экране). Держим отдельную карту
// «устройство → последний ping»: presence ключуется по хешу IP и знает имя
// только у тех, кто согласился светиться в списке «кто здесь».
//
// Ключ — УСТРОЙСТВО, а не человек. По человеку не годится: открытая вкладка на
// ноуте затыкала бы пуши на телефон, лежащий в кармане. Ключ считается из
// endpoint'а подписки — он же приходит в пинге с той вкладки, что сейчас
// открыта. Устройство, которое endpoint не прислало, просто не глушится.
type pushActivity struct {
	mu    sync.Mutex
	seen  map[string]time.Time
	blast map[string]time.Time // когда устройству последний раз слали фоновый пуш
}

var pushActive = &pushActivity{
	seen:  map[string]time.Time{},
	blast: map[string]time.Time{},
}

// pushDeviceKey — короткий ключ устройства из endpoint'а подписки. Хешируем,
// чтобы не держать в памяти сырые URL пуш-сервисов (они по сути секреты).
func pushDeviceKey(endpoint string) string {
	if endpoint == "" {
		return ""
	}
	return shoutHash("pushdev", shoutSalt(), endpoint)
}

func (a *pushActivity) touch(key string) {
	if key == "" {
		return
	}
	a.mu.Lock()
	a.seen[key] = time.Now()
	// Устройство пришло в чат = человек прочитал. Снимаем паузу на фоновые
	// пуши: следующий раз, когда он отойдёт, первое же сообщение его разбудит,
	// а не будет ждать конца окна.
	delete(a.blast, key)
	// Подметаем на месте: карта маленькая, отдельный крон ради неё избыточен.
	if len(a.seen) > 500 {
		for k, t := range a.seen {
			if time.Since(t) > pushActiveWindow {
				delete(a.seen, k)
			}
		}
	}
	a.mu.Unlock()
}

// allowBlast — можно ли слать этому устройству ФОНОВЫЙ пуш (обычное сообщение
// в ленте, не адресное). Разрешает не чаще раза в pushFloodWindow и сразу же
// отмечает выдачу.
//
// Так работает Discord и так работает здравый смысл: разбудить человека стоит
// один раз, а не тридцать за оживший спор. Экономия не только его батарейки:
// каждый пуш — это отдельный HTTPS-запрос от нас к FCM на КАЖДОЕ устройство,
// и на живой ленте именно они, а не база, становятся основной нагрузкой.
// Адресные пуши (ответ, @упоминание) сюда не заходят — их не глушим никогда.
func (a *pushActivity) allowBlast(key string) bool {
	if key == "" {
		return true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if t, ok := a.blast[key]; ok && time.Since(t) < pushFloodWindow {
		return false
	}
	a.blast[key] = time.Now()
	if len(a.blast) > 500 {
		for k, t := range a.blast {
			if time.Since(t) > pushFloodWindow {
				delete(a.blast, k)
			}
		}
	}
	return true
}

func (a *pushActivity) active(key string) bool {
	if key == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	t, ok := a.seen[key]
	return ok && time.Since(t) < pushActiveWindow
}
