// Web Push (VAPID) — the reason for leaving Discord possible: without push the site chat only
// reaches people when they come back. Subscriptions in push_subscriptions (never readable via API;
// list/viewRule nil; all via these endpoints with app.Save). One record = one device (endpoint).
// Feature flag: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in env; none → endpoints 404, frontend hides
// the toggle. Keys made once with `./dist/serve push-keys` into .env — CHANGING KEYS KILLS ALL
// EXISTING SUBSCRIPTIONS at once (browsers won't reissue).
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
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
	// Oldest devices evicted past this, or every private window leaves junk.
	pushMaxPerUser = 5
	// Push-service TTL one day: a week-late "someone replied" only annoys.
	pushTTL = 24 * 60 * 60
	// Addressed pushes (reply, @mention, DM) use Urgency high: FCM holds normal pushes on a dozing
	// Android until the Doze maintenance window — "someone replied" arrives 40 minutes late or never.
	pushUrgencyBulk   = webpush.UrgencyNormal
	pushUrgencyDirect = webpush.UrgencyHigh
	// Don't wake someone already watching the chat (presence ping younger than this). 10 min =
	// Discord's "push to phone when inactive N minutes".
	pushActiveWindow = 10 * time.Minute
	// Coalescing window: first message wakes immediately, later ones within the window fold into one
	// "N new".
	pushCoalesceWindow = 60 * time.Second

	pushCoalesceTick = 5 * time.Second

	pushCoalesceMax = 2000
)

func pushKeys() (pub, priv string) {
	return os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY")
}

func pushEnabled() bool {
	pub, priv := pushKeys()
	return pub != "" && priv != ""
}

func pushSubject() string {
	if s := os.Getenv("VAPID_SUBJECT"); s != "" {
		return s
	}
	return "mailto:admin@cyoa.cafe"
}

// Keep payload flat and short: push services cap bodies ~4 KB, and privacy beats completeness (spec
// §11).
type pushPayload struct {
	Sender    string `json:"-"`
	Channel   string `json:"channel,omitempty"`
	Message   string `json:"message,omitempty"`
	Created   string `json:"created,omitempty"`
	Recipient string `json:"recipient,omitempty"`
	DM        bool   `json:"dm,omitempty"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	Tag       string `json:"tag"`
	// Force bypasses the SW "chat is open" check (chatIsWatched). Only for "send test notification":
	// the button is pressed exactly while on the page, and silence then looks broken.
	Force bool `json:"force,omitempty"`
}

// Returns "subscription dead" → delete the record (browser revoked it; it never comes back).
type pushDeliveryError struct {
	status int
	after  time.Duration
}

func (e *pushDeliveryError) Error() string { return fmt.Sprintf("push failed (%d)", e.status) }
func pushRetryDelay(err error, attempt int) (time.Duration, bool) {
	var delivery *pushDeliveryError
	if errors.As(err, &delivery) {
		if delivery.status != 429 && delivery.status < 500 {
			return 0, false
		}
		if delivery.after > 0 {
			return min(delivery.after, time.Minute), true
		}
	}
	return time.Duration(1<<(attempt*2)) * time.Second, true
}

func pushUnread(app core.App, p pushPayload) bool {
	if p.Recipient == "" || p.Channel == "" || p.Created == "" {
		return true
	}
	room, err := app.FindRecordById(shoutChannelsCol, p.Channel)
	if err != nil || !room.GetBool("enabled") {
		return false
	}
	if room.GetBool("is_private") {
		allowed := false
		for _, member := range room.GetStringSlice("members") {
			if member == p.Recipient {
				allowed = true
			}
		}
		if !allowed {
			return false
		}
	}
	if p.Sender != "" && shoutBlockExists(app, p.Recipient, p.Sender) {
		return false
	}
	at, err := time.Parse("2006-01-02 15:04:05.000Z", p.Created)
	if err != nil {
		return true
	}
	return chatReadCursors(app, p.Recipient)[p.Channel] < at.UnixMilli()
}
func pushConversationURL(channel, message string) string {
	q := url.Values{"channel": {channel}}
	if message != "" {
		q.Set("message", message)
	}
	return pushChatURL + "?" + q.Encode()
}

func pushSendTo(sub *core.Record, body []byte, urgent bool) (dead bool, err error) {
	pub, priv := pushKeys()
	urgency := pushUrgencyBulk
	if urgent {
		urgency = pushUrgencyDirect
	}
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
		HTTPClient:      &http.Client{Timeout: 15 * time.Second},
		Urgency:         urgency,
	})
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	// 404/410 = subscription gone. Other codes (429, 5xx) are transient: keep the subscription, drop
	// this notification.
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return true, fmt.Errorf("subscription gone (%d)", resp.StatusCode)
	}
	if resp.StatusCode >= 300 {
		after := time.Duration(0)
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
			after = time.Duration(seconds) * time.Second
		} else if when, err := http.ParseTime(resp.Header.Get("Retry-After")); err == nil {
			after = time.Until(when)
		}
		return false, &pushDeliveryError{status: resp.StatusCode, after: after}
	}
	return false, nil
}

// Sends to SUBSCRIPTIONS, not users: a phone may be "wake on everything" while the work laptop is
// "mentions only". Called in a goroutine (pushAsync) so the author's HTTP response doesn't wait.
func pushSendBatch(app core.App, subs []*core.Record, p pushPayload, urgent bool) {
	if !pushEnabled() || len(subs) == 0 {
		return
	}
	body, err := json.Marshal(p)
	if err != nil {
		return
	}
	for _, sub := range subs {
		if !pushUnread(app, p) {
			continue
		}
		dead, err := pushSendTo(sub, body, urgent)
		for attempt := 0; err != nil && !dead && attempt < 2; attempt++ {
			delay, retry := pushRetryDelay(err, attempt)
			if !retry {
				break
			}
			time.Sleep(delay)
			if !pushUnread(app, p) {
				err = nil
				break
			}
			dead, err = pushSendTo(sub, body, urgent)
		}
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

func pushAsync(app core.App, subs []*core.Record, p pushPayload, urgent bool) {
	if !pushEnabled() || len(subs) == 0 {
		return
	}
	go pushSendBatch(app, subs, p, urgent)
}

// Addressed notifications ignore device mode — that's what addressed means.
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

func pushToUsers(app core.App, userIDs []string, p pushPayload) {
	var subs []*core.Record
	for _, uid := range userIDs {
		subs = append(subs, pushSubsOfUser(app, uid)...)
	}
	pushSendBatch(app, subs, p, true)
}

// Devices set to "wake on any message", minus the author's devices, those already sent an addressed
// push, and those watching chat right now. "Watching" is PER DEVICE: per-person let an open laptop
// tab silence the phone. prefs = this room's settings (shoutbox_prefs.go), overriding the device
// both ways: "mentions"/"mute" remove, "all" adds even a mentions-only device. bulk = may "wake on
// everything" subscribers be woken at all: yes for author rooms (a dozen, chosen deliberately); NO
// for user topics (thousands, anyone creates them — it'd mean every stranger's line wakes you). A
// topic reaches you only if you subscribed to it (prefs[uid] == "all"), which works regardless of
// bulk.
func pushSubsAll(app core.App, exclude map[string]bool, prefs map[string]string, bulk bool) []*core.Record {
	if !pushEnabled() {
		return nil
	}
	var subs []*core.Record
	if bulk {
		var err error
		subs, err = app.FindRecordsByFilter(pushSubsCol, "mode = 'all'", "", 0, 0)
		if err != nil {
			return nil
		}
	}
	out := make([]*core.Record, 0, len(subs))
	seen := map[string]bool{}
	add := func(s *core.Record) {
		uid := s.GetString("user")
		if uid == "" || exclude[uid] || seen[s.Id] {
			return
		}
		if pushActive.active(pushDeviceKey(s.GetString("endpoint"))) {
			return
		}
		seen[s.Id] = true
		out = append(out, s)
	}
	for _, s := range subs {
		if m := shoutMode(prefs[s.GetString("user")]); m == "mentions" || m == "mute" {
			continue
		}
		add(s)
	}
	left := shoutPrefsBoostMax
	for uid, m := range prefs {
		if m != "all" || exclude[uid] || left <= 0 {
			continue
		}
		left--
		for _, s := range pushSubsOfUser(app, uid) {
			add(s)
		}
	}
	return out
}

// If chat moves, change here AND CHAT_ROUTE (ShoutboxButton.tsx). Old /chat-lab redirects here, so
// pre-v2 notifications stay alive.
const pushChatURL = "/chat"

// Two recipient groups: personally addressed (reply, @mention) — always, even if in chat; "all
// messages" subscribers — only if not in chat now. Anonymous post stays anonymous in the push.
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
	body := shoutTruncate(strings.TrimSpace(rec.GetString("text")), 90)
	if body == "" && rec.GetString("image") != "" {
		body = "sent a picture"
	}

	// members != nil = private channel. The push CONTAINS TEXT and bypasses collection rules, so it
	// goes ONLY to members — otherwise an "everything" subscriber would read a private conversation on
	// their lock screen.
	room := ""
	isDM := false
	isThread := false
	var members map[string]bool
	chID := rec.GetString("channel")
	prefs := shoutPrefs.forChannel(app, chID)
	if chID != "" {
		if ch, err := app.FindRecordById(shoutChannelsCol, chID); err == nil {
			room = ch.GetString("title")
			isDM = ch.GetBool("is_dm")
			isThread = !isDM && !ch.GetBool("is_private") && shoutCommunityIsThread(ch)
			if ch.GetBool("is_private") {
				members = map[string]bool{}
				for _, uid := range ch.GetStringSlice("members") {
					members[uid] = true
				}
			}
		} else {
			// Channel exists but can't be read → send nothing: better undelivered than misdelivered.
			return
		}
	}
	allowed := func(uid string) bool { return members == nil || members[uid] }

	// One tag per room so consecutive pushes collapse into one notification.
	for uid, ntype := range targeted {
		if !allowed(uid) {
			continue
		}
		// A muted room doesn't ping by name either — otherwise mute is a half-measure.
		if shoutMode(prefs[uid]) == "mute" {
			continue
		}
		title := author + " mentioned you"
		tag := "shout-" + rec.Id
		switch ntype {
		case "shout_reply":
			title = author + " replied to you"
		case "shout_dm":
			// DMs have no "reply"/"mention", only "wrote". Tag per room so a conversation collapses into one
			// lock-screen line.
			title = author + " sent you a message"
			tag = pushRoomTag(chID)
		}
		if room != "" && ntype != "shout_dm" {
			title += " — " + room
		}
		payload := pushPayload{Title: title, Body: body, URL: pushConversationURL(chID, rec.Id), Tag: tag,
			Channel: chID, Message: rec.Id, Created: rec.GetString("created"), Recipient: uid, DM: ntype == "shout_dm", Sender: actorID}
		subs := pushSubsOfUser(app, uid)
		if ntype == "shout_dm" {
			for _, sub := range subs {
				pushMerge.queueDirect(app, sub, payload)
			}
		} else {
			pushAsync(app, subs, payload, true)
		}
	}

	exclude := map[string]bool{}
	if actorID != "" {
		exclude[actorID] = true
	}
	for uid := range targeted {
		exclude[uid] = true
	}

	// Private channel is addressed in itself: without this DMs were silent for everyone on "mentions
	// only" (the default). DMs go immediately with high urgency (like Discord DMs). A 5-person private
	// room is a conversation: coalesced like the general feed.
	if members != nil {
		for uid := range members {
			if exclude[uid] {
				continue
			}
			exclude[uid] = true
			if m := shoutMode(prefs[uid]); m == "mute" || m == "mentions" {
				continue
			}
			subs := pushSubsOfUser(app, uid)
			if isDM {
				for _, sub := range subs {
					pushMerge.queueDirect(app, sub, pushPayload{
						Title: author + " sent you a message", Body: body, URL: pushConversationURL(chID, rec.Id), Tag: pushRoomTag(chID),
						Channel: chID, Message: rec.Id, Created: rec.GetString("created"), Recipient: uid, DM: true, Sender: actorID,
					})
				}
				continue
			}
			for _, s := range subs {
				if pushActive.active(pushDeviceKey(s.GetString("endpoint"))) {
					continue
				}
				pushMerge.queue(app, s, chID, room, author, body)
			}
		}
	}

	rest := pushSubsAll(app, exclude, prefs, !isThread)
	if members != nil {
		kept := rest[:0]
		for _, s := range rest {
			if members[s.GetString("user")] {
				kept = append(kept, s)
			}
		}
		rest = kept
	}
	// Not broadcast but a buffer: first message immediately, later ones within a minute fold into "N
	// new". Membership filtering happens BEFORE, so a device doesn't spend its window on a message it
	// won't be shown.
	for _, s := range rest {
		pushMerge.queue(app, s, chID, room, author, body)
	}
}

func registerPushRoutes(app *pocketbase.PocketBase, se *core.ServeEvent) {
	g := se.Router.Group("/api/custom/push")

	// The VAPID public key is needed before any auth (PushManager.subscribe()). No keys →
	// enabled:false (a 404 would be indistinguishable from "old server").
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

	// endpoint is unique (schema index): repeats are an upsert — browsers resend the same subscription
	// on every visit.
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

	// Others' endpoints silently ignored: an endpoint is effectively a secret.
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

	g.POST("/test", func(c *core.RequestEvent) error {
		pushToUsers(app, []string{c.Auth.Id}, pushPayload{
			Title: "CYOA.CAFE",
			Body:  "Test notification — push is working.",
			URL:   pushChatURL,
			Tag:   "push-test",
			Force: true,
		})
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	}).Bind(apis.RequireAuth())
}

// keepID = the just-written subscription, never evicted.
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

// `serve push-keys`: keys belong to the binary that signs with them — no separate script.
func registerPushKeysCmd(app *pocketbase.PocketBase) {
	app.RootCmd.AddCommand(&cobra.Command{
		Use:   "push-keys",
		Short: "Generate a VAPID key pair for web push",
		Run: func(cmd *cobra.Command, args []string) {
			priv, pub, err := webpush.GenerateVAPIDKeys()
			if err != nil {
				fmt.Println("generation failed:", err)
				return
			}
			fmt.Println("# Web push: put these into .env and restart the server.")
			fmt.Println("# Changing keys invalidates ALL existing subscriptions.")
			fmt.Println("VAPID_PUBLIC_KEY=" + pub)
			fmt.Println("VAPID_PRIVATE_KEY=" + priv)
			fmt.Println("VAPID_SUBJECT=mailto:admin@cyoa.cafe")
		},
	})
}

// Don't push to someone looking at the same feed. Separate map device → last ping (presence is
// keyed by IP hash and knows names only for those visible in "who's here"). Key is the DEVICE:
// per-person let an open laptop tab silence the phone in a pocket. Derived from the subscription
// endpoint, which the open tab sends in its ping; devices that didn't send one are never silenced.
type pushActivity struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

var pushActive = &pushActivity{seen: map[string]time.Time{}}

// Hashed: raw push-service URLs are effectively secrets.
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
	if len(a.seen) > 500 {
		for k, t := range a.seen {
			if time.Since(t) > pushActiveWindow {
				delete(a.seen, k)
			}
		}
	}
	a.mu.Unlock()
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

// Coalescing replaced a crude fuse (one background push per device per 10 min, rest dropped) that
// looked broken from outside: 15 messages → one push. Now: first message immediately (else chat
// feels dead), the rest within the window fold, and at its end ONE "N new — last from X" push. Same
// cost (≤1 push/min/device), nothing lost. Key = device AND room (General and a private room don't
// merge, like Discord channels).
type pushPending struct {
	payload *pushPayload
	urgent  bool
	sub     *core.Record
	room    string
	author  string
	body    string
	n       int
}

type pushCoalescer struct {
	mu      sync.Mutex
	pend    map[string]*pushPending
	sent    map[string]time.Time
	running bool
}

var pushMerge = &pushCoalescer{
	pend: map[string]*pushPending{},
	sent: map[string]time.Time{},
}

func (c *pushCoalescer) queue(app core.App, sub *core.Record, chID, room, author, body string) {
	if sub == nil {
		return
	}
	key := pushDeviceKey(sub.GetString("endpoint")) + "|" + chID
	now := time.Now()

	c.mu.Lock()
	if t, ok := c.sent[key]; !ok || now.Sub(t) >= pushCoalesceWindow {
		c.sent[key] = now
		c.mu.Unlock()
		pushAsync(app, []*core.Record{sub}, pushPayload{
			Title: pushRoomTitle(room), Body: author + ": " + body,
			URL: pushChatURL, Tag: pushRoomTag(chID),
		}, false)
		return
	}
	p := c.pend[key]
	if p == nil {
		if len(c.pend) >= pushCoalesceMax {
			c.mu.Unlock()
			return
		}
		p = &pushPending{sub: sub, room: room}
		c.pend[key] = p
	}
	p.n++
	p.author, p.body = author, body
	c.start(app)
	c.mu.Unlock()
}

func (c *pushCoalescer) queueDirect(app core.App, sub *core.Record, payload pushPayload) {
	if sub == nil {
		return
	}
	key := pushDeviceKey(sub.GetString("endpoint")) + "|" + payload.Channel
	now := time.Now()
	c.mu.Lock()
	if t, ok := c.sent[key]; !ok || now.Sub(t) >= pushCoalesceWindow {
		c.sent[key] = now
		if previous := c.pend[key]; previous != nil {
			payload.Body = fmt.Sprintf("%d new — %s", previous.n+1, payload.Body)
		}
		delete(c.pend, key)
		c.mu.Unlock()
		pushAsync(app, []*core.Record{sub}, payload, true)
		return
	}
	p := c.pend[key]
	if p == nil {
		if len(c.pend) >= pushCoalesceMax {
			c.mu.Unlock()
			return
		}
		p = &pushPending{sub: sub}
		c.pend[key] = p
	}
	p.n++
	p.payload = &payload
	p.urgent = true
	c.start(app)
	c.mu.Unlock()
}

func (c *pushCoalescer) start(app core.App) {
	if c.running {
		return
	}
	c.running = true
	go func() {
		t := time.NewTicker(pushCoalesceTick)
		defer t.Stop()
		for range t.C {
			c.flush(app)
		}
	}()
}

// Send outside the lock: a round of push services takes seconds and would stall the whole chat.
func (c *pushCoalescer) flush(app core.App) {
	now := time.Now()
	var due []*pushPending
	var tags []string

	c.mu.Lock()
	for k, p := range c.pend {
		if now.Sub(c.sent[k]) < pushCoalesceWindow {
			continue
		}
		due = append(due, p)
		tags = append(tags, pushRoomTag(strings.SplitN(k, "|", 2)[1]))
		delete(c.pend, k)
		c.sent[k] = now
	}
	for k, t := range c.sent {
		if now.Sub(t) > pushCoalesceWindow && c.pend[k] == nil {
			delete(c.sent, k)
		}
	}
	c.mu.Unlock()

	for i, p := range due {
		if p.payload != nil {
			payload := *p.payload
			if p.n > 1 {
				payload.Body = fmt.Sprintf("%d new — %s", p.n, payload.Body)
			}
			pushAsync(app, []*core.Record{p.sub}, payload, p.urgent)
			continue
		}
		body := p.author + ": " + p.body
		if p.n > 1 {
			// Counter before text: a lock screen shows 1.5 lines and "12 new" matters more than the tail of
			// the last line.
			body = fmt.Sprintf("%d new — %s", p.n, body)
		}
		pushAsync(app, []*core.Record{p.sub}, pushPayload{
			Title: pushRoomTitle(p.room), Body: body, URL: pushChatURL, Tag: tags[i],
		}, false)
	}
}

func (c *pushCoalescer) forget(deviceKey string) {
	if deviceKey == "" {
		return
	}
	pre := deviceKey + "|"
	c.mu.Lock()
	for k := range c.pend {
		if strings.HasPrefix(k, pre) {
			delete(c.pend, k)
		}
	}
	for k := range c.sent {
		if strings.HasPrefix(k, pre) {
			delete(c.sent, k)
		}
	}
	c.mu.Unlock()
}

// Room name only (like Discord): the site is already labelled in the shade; "CYOA.CAFE" per line
// eats space.
func pushRoomTitle(room string) string {
	if room == "" {
		return "CYOA.CAFE chat"
	}
	return room
}

func pushRoomTag(chID string) string {
	if chID == "" {
		return "shout-room-main"
	}
	return "shout-room-" + chID
}
