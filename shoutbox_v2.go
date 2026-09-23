// Chat v2 delta over live v1 (shoutbox.go). Spec: wiki/components/shoutbox-v2-spec.md. Adds:
// channels (incl. private), anon toggle for logged-in users, guest delete password, image messages,
// "who's here". Separate file because v1's POST path is touched in exactly one place; everything
// else registers into /api/custom/shoutbox via registerShoutboxV2().
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
	// 8 MB (was 2; author decision 2026-09-05 — topics show pages of WIP CYOAs, which are huge). Still
	// capped: uploads go through Cloudflare (it cuts ~95 MB bodies) and every image loads for every
	// feed reader. ⚠️ Paired with maxSize of the `image` field in the PB schema: here the refusal is
	// readable, there it's "Failed to save message". Raise both.
	shoutImageMaxBytes = 8 << 20
	shoutDelPassMinLen = 3
	shoutDelPassMaxLen = 64
)

// Paired with IMG_MIME in PB/add_shoutbox_v2_schema.py; PB rejects the rest anyway, but a clear 400
// beats "Failed to save message".
var shoutImageMIME = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// All highlight state lives in MEMORY, zero DB queries. Deliberate trade: exact per-channel unread
// counts need per-user×channel read marks in the schema and grouping per ping, for the same visible
// "new" dot. Losing it on restart is fine.
type shoutChanState struct {
	mu       sync.Mutex
	lastMsg  map[string]time.Time
	recent   map[string][]int64
	mentions map[string]map[string]time.Time
}

var shoutChans = &shoutChanState{
	lastMsg:  map[string]time.Time{},
	recent:   map[string][]int64{},
	mentions: map[string]map[string]time.Time{},
}

// A mention is kept for a day; older is archaeology, not news.
const shoutMentionTTL = 24 * time.Hour

// Message times kept per channel for the pulse; also the header counter cap ("50+").
const shoutPulseKeep = 50

func (s *shoutChanState) noteMessage(chID string) {
	now := time.Now()
	s.mu.Lock()
	s.lastMsg[chID] = now
	ts := append([]int64{now.Unix()}, s.recent[chID]...)
	if len(ts) > shoutPulseKeep {
		ts = ts[:shoutPulseKeep]
	}
	s.recent[chID] = ts
	s.mu.Unlock()
}

// pulse is identical for everyone (no personal bytes), so Cloudflare serves it whole; each browser
// computes unread against its own read mark. Private channels NEVER appear: "a private room is
// active now" is itself a leak.
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

// newSince: per-topic new-message counts computed server-side (topics have no pulse — thousands of
// them, one shared edge response). Uses the caller's read marks (already merged across devices). A
// topic WITHOUT a mark is skipped on purpose: never-opened isn't "+50".
func (s *shoutChanState) newSince(ids []string, seen map[string]int64) map[string]int {
	if len(ids) == 0 || len(seen) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]int, len(ids))
	for _, id := range ids {
		at := seen[id]
		if at <= 0 {
			continue
		}
		n := 0
		for _, t := range s.recent[id] {
			if t <= at {
				break
			}
			n++
		}
		if n > 0 {
			out[id] = n
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// Seed the pulse from the DB on first request after start, else every restart zeroes everyone's
// unread counters. One query per process lifetime.
func (s *shoutChanState) seedFromDB(app core.App) {
	recs, err := app.FindRecordsByFilter(shoutboxCol, "", "-created", shoutPulseKeep*8, 0)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range recs {
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

// Clears "you were mentioned"; the "new" dot is cleared by the frontend (per-device mark).
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

// Clear mentions using read marks the ping already carries. Previously only the channel open AT the
// ping second (?ch=) cleared them — reading ten topics in 30 s and the "@"s came back a minute
// later.
func (s *shoutChanState) seenMany(userID string, seen map[string]int64) {
	if userID == "" || len(seen) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.mentions[userID]
	if m == nil {
		return
	}
	for ch := range m {
		at, ok := seen[ch]
		if !ok {
			continue
		}
		// One second of slack: the browser sets the mark by its own clock.
		if last, has := s.lastMsg[ch]; !has || at+1 >= last.Unix() {
			delete(m, ch)
		}
	}
	if len(m) == 0 {
		delete(s.mentions, userID)
	}
}

// allow = what this user may see (shoutVisibleChannels). Without the filter the ping told everyone
// about private rooms and when they were last active. /pulse had the filter from day one; the ping
// forgot it.
func (s *shoutChanState) snapshot(userID string, allow map[string]bool) (map[string]int64, []string) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	last := make(map[string]int64, len(s.lastMsg))
	for ch, t := range s.lastMsg {
		if !allow[ch] {
			continue
		}
		last[ch] = t.Unix()
	}

	var mentions []string
	if m := s.mentions[userID]; m != nil {
		for ch, t := range m {
			if now.Sub(t) >= shoutMentionTTL {
				delete(m, ch)
				continue
			}
			if !allow[ch] {
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

type shoutChannel struct {
	ID      string `json:"id"`
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Desc    string `json:"description,omitempty"`
	Private bool   `json:"is_private,omitempty"`
	// omitempty: public channels don't have these, and /channels is called from every page.
	DM      bool     `json:"is_dm,omitempty"`
	Owner   string   `json:"owner,omitempty"`
	Members []string `json:"members,omitempty"`
}

// Public to all, private to members. The rule is duplicated in the collection listRule (menu here,
// PB listing there) — they must not drift, or the menu shows a channel whose messages don't load.
// Missing channels collection = "no channels", chat falls back to one feed like v1.
func shoutVisibleChannels(app core.App, authID string) ([]shoutChannel, error) {
	// Two queries, not one + Go filter: with DMs, private channels outnumber public ones; "first 100
	// then filter" would miss your own DM. `owner = ''` = author's pinned rooms; user topics
	// (shoutbox_community.go) excluded on purpose — thousands would flood a menu requested by every
	// page.
	recs, err := app.FindRecordsByFilter(shoutChannelsCol,
		"enabled = true && is_private = false && "+shoutRoomOnlyFilter, "sort,slug", 100, 0)
	if err != nil {
		return []shoutChannel{}, nil //nolint:nilerr
	}
	if authID != "" {
		mine, err := app.FindRecordsByFilter(shoutChannelsCol,
			"enabled = true && is_private = true && members.id ?= {:u}", "sort,slug", 200, 0,
			dbx.Params{"u": authID})
		if err == nil {
			recs = append(recs, mine...)
		}
	}
	out := make([]shoutChannel, 0, len(recs))
	for _, r := range recs {
		out = append(out, shoutChanFromRecord(r))
	}
	return out, nil
}

// Separate from shoutVisibleChannels because it runs on EVERY header ping: ids only.
func shoutPrivateChannelIDs(app core.App, authID string) map[string]bool {
	if authID == "" {
		return nil
	}
	recs, err := app.FindRecordsByFilter(shoutChannelsCol,
		"enabled = true && is_private = true && members.id ?= {:u}", "", 200, 0,
		dbx.Params{"u": authID})
	if err != nil || len(recs) == 0 {
		return nil
	}
	out := make(map[string]bool, len(recs))
	for _, r := range recs {
		out[r.Id] = true
	}
	return out
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

// Empty slug = default channel (first by sort) so old clients and system posts have one. (nil, nil)
// when no channels exist → message stored with empty channel, like v1; chat must work on a bare
// schema.
func shoutResolveChannel(app core.App, slug, authID string) (*core.Record, error) {
	slug = strings.TrimSpace(strings.ToLower(slug))
	if slug == "" {
		// Same `owner = ''` as shoutVisibleChannels: a channel-less message (old client, system post)
		// must not land in someone's topic.
		recs, err := app.FindRecordsByFilter(shoutChannelsCol, "enabled = true && is_private = false && "+shoutRoomOnlyFilter, "sort,slug", 1, 0)
		if err != nil || len(recs) == 0 {
			return nil, nil //nolint:nilerr // no channels — post without one, like v1
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
		// 404 not 403: existence of a private channel is private too.
		return nil, apis.NewNotFoundError("Unknown channel", nil)
	}
	return rec, nil
}

// Stored as "<salt>:<hash>" in hidden del_pass. Per-message salt so the same password doesn't link
// a guest's posts together (not secret protection — the password lives minutes). Salt stored
// alongside, not derived from the id: the PB id only exists at Save, the hash is needed before — v1
// of this broke exactly there (hashed under an empty id, never matched).
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

var errShoutNotOwner = errors.New("not the author")

// Two doors: logged-in author (incl. anon post via hidden author_ref), or anyone with the random
// password set at send time. anon_key grants NOTHING: shared behind NAT/VPN, it's only a public
// label/antispam. Moderators use v1 /delete.
func shoutCanDeleteOwn(rec *core.Record, authID, pass string) error {
	if rec.GetString("kind") == "system" {
		return errShoutNotOwner
	}
	if authID != "" && (rec.GetString("user") == authID || rec.GetString("author_ref") == authID) {
		return nil
	}
	if h := rec.GetString("del_pass"); h != "" && shoutDelPassMatch(h, pass) {
		return nil
	}
	return errShoutNotOwner
}

// Guests pick bad passwords ("1234", ""); without an attempt counter /delete-own is a dictionary
// oracle. 5 attempts per 30 min per IP hash (author decision 2026-08-05).
const (
	shoutGuessMax    = 5
	shoutGuessWindow = 30 * time.Minute
)

type shoutGuessRec struct {
	n     int
	until time.Time
}

type shoutGuessCounter struct {
	mu   sync.Mutex
	hits map[string]shoutGuessRec
}

var shoutGuesses = &shoutGuessCounter{hits: map[string]shoutGuessRec{}}

func (g *shoutGuessCounter) blocked(key string) bool {
	if key == "" {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	r, ok := g.hits[key]
	if !ok {
		return false
	}
	if time.Now().After(r.until) {
		delete(g.hits, key)
		return false
	}
	return r.n >= shoutGuessMax
}

// The window is NOT extended per attempt, or button-mashing would become a permanent block.
func (g *shoutGuessCounter) fail(key string) {
	if key == "" {
		return
	}
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	r, ok := g.hits[key]
	if !ok || now.After(r.until) {
		g.hits[key] = shoutGuessRec{n: 1, until: now.Add(shoutGuessWindow)}
	} else {
		r.n++
		g.hits[key] = r
	}
	// In-memory map swept here instead of a dedicated ticker: few entries, rare event.
	if len(g.hits) > 500 {
		for k, v := range g.hits {
			if now.After(v.until) {
				delete(g.hits, k)
			}
		}
	}
}

// Mute key per message. Order matters: a logged-in anon post stores the real author in hidden
// author_ref — mute THEM, not anon_key, or flipping the toggle escapes the mute. Bare anon_key only
// for guests (lives a week, shoutAnonWindow, so a day mute doesn't lapse at midnight). Empty =
// system message.
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

// Logged-in mute key is "u:"+id, not the bare id; shout.muted(bareId) never matches. That's how
// mutes silently failed on reactions: the check looked right and never fired.
func shoutMutedUser(uid string) bool {
	return uid != "" && shout.muted("u:"+uid)
}

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

	// Empty authID yields exactly the public channels — the answer is shared. Key "" = messages from
	// before channels existed (they live in the default).
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

func registerShoutboxV2(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	// PERSONAL response (the caller's DMs/private rooms). Cache header set explicitly: if the edge
	// ever caches it, the next visitor gets someone else's conversation list.
	g.GET("/channels", func(c *core.RequestEvent) error {
		c.Response.Header().Set("Cache-Control", "private, no-store")
		authID := ""
		if c.Auth != nil {
			authID = c.Auth.Id
			// New moderators join the staff room on their first chat visit (membership is materialized,
			// shoutbox_staff.go).
			shoutStaffJoin(app, c.Auth)
		}
		chans, err := shoutVisibleChannels(app, authID)
		if err != nil {
			return c.InternalServerError("Failed to load channels", err)
		}
		out := map[string]any{"channels": chans}
		if cards := shoutMemberCards(app, chans); len(cards) > 0 {
			out["users"] = cards
		}
		// Last-message times so DMs sort by freshness; allowed set = the same chans, so the snapshot
		// shows only what the user sees anyway.
		shoutPulseSeedOnce.Do(func() { shoutChans.seedFromDB(app) })
		allow := map[string]bool{"": true}
		for _, ch := range chans {
			allow[ch.ID] = true
		}
		if last, _ := shoutChans.snapshot(authID, allow); len(last) > 0 {
			out["last"] = last
		}
		// Personal state (notes, pins, read marks) rides here: this response is already personal and
		// uncacheable — no extra request.
		if authID != "" {
			out["state"] = shoutStateOf(app, authID)
		}
		return c.JSON(http.StatusOK, out)
	})

	// The pulse is the ONLY request a page with closed chat makes. Byte-identical for all, so the edge
	// serves it (≈1 origin hit per 10 s). Unread is computed in the browser against its read mark —
	// computable locally, whereas a personal answer couldn't be cached. The 5 s in-memory cache is
	// insurance in case the Cloudflare cache rule is missing.
	g.GET("/pulse", func(c *core.RequestEvent) error {
		// Browser 10 s; edge may serve stale for a minute while revalidating — a second of counter
		// inaccuracy beats a thundering herd at expiry.
		c.Response.Header().Set("Cache-Control", "public, max-age=10, stale-while-revalidate=50")
		return c.JSON(http.StatusOK, shoutPulseBody(app))
	})

	g.GET("/who", func(c *core.RequestEvent) error {
		who, guests, hidden, cut := shout.whoList()
		return c.JSON(http.StatusOK, map[string]any{
			"online": shout.smoothOnline(),
			"who":    who,
			// "Others" = unnamed guests, users who hid themselves, and those cut by the list cap (normally
			// 0).
			"guests": guests,
			"hidden": hidden,
			"cut":    cut,
		})
	})

	// Deleted completely, no "deleted" placeholder (a typo shouldn't get a monument).
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
		if p.DelPass != "" && shoutGuesses.blocked(anonKey) {
			return c.TooManyRequestsError("Too many attempts. Try again in half an hour.", nil)
		}
		if err := shoutCanDeleteOwn(rec, authID, p.DelPass); err != nil {
			// Count only attempts WITH a password; refusal without one is just "not yours".
			if p.DelPass != "" {
				shoutGuesses.fail(anonKey)
			}
			// Same answer for "not yours" and "wrong password", else it's an oracle for "was this sent from
			// your IP?".
			return c.ForbiddenError("Can't delete this message", nil)
		}
		if err := app.Delete(rec); err != nil {
			return c.InternalServerError("Failed to delete message", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	})

	// "Edited" is its own field, not updated≠created (as in comments): pin/unpin also bump `updated`
	// and would mark untouched messages edited. Edit rights = delete rights. The image isn't editable
	// (that's a new message). No notifications for new @mentions on edit, or edits become a way to
	// ping people repeatedly.
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
		// Same attempt counter as delete: one door (shoutCanDeleteOwn); separate counters would double an
		// attacker's budget.
		if p.DelPass != "" && shoutGuesses.blocked(anonKey) {
			return c.TooManyRequestsError("Too many attempts. Try again in half an hour.", nil)
		}
		if err := shoutCanDeleteOwn(rec, authID, p.DelPass); err != nil {
			if p.DelPass != "" {
				shoutGuesses.fail(anonKey)
			}
			return c.ForbiddenError("Can't edit this message", nil)
		}
		if src := shoutMuteSource(rec); src != "" && shout.muted(src) {
			return c.ForbiddenError("You are muted.", nil)
		}
		text := strings.TrimSpace(p.Text)
		// Length cap follows the MESSAGE, not the editor (guest post keeps the guest cap), or editing
		// bypasses send limits.
		guestPost := rec.GetString("user") == "" && rec.GetString("author_ref") == ""
		if max := shoutLenLimit(!guestPost); utf8.RuneCountInString(text) > max {
			return apis.NewBadRequestError("Message is too long.", nil)
		}
		// Empty text only for image messages, else an edit could blank a message into an empty line.
		if text == "" && rec.GetString("image") == "" {
			return apis.NewBadRequestError("Empty message.", nil)
		}
		// Same filters as sending, or edit = post harmless, rewrite to spam. Link rule looks at the
		// message: a guest post has neither author nor author_ref (logged-in incognito may post links;
		// editing mustn't take that away).
		lower := strings.ToLower(text)
		for _, w := range shoutBlockedWords() {
			if strings.Contains(lower, w) {
				return apis.NewBadRequestError("Message rejected.", nil)
			}
		}
		if guestPost && shoutURLRe.MatchString(text) {
			return apis.NewBadRequestError("Links are for logged-in users.", nil)
		}
		rec.Set("text", text)
		rec.Set("edited", true)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to save message", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	})

	// Pin is a property of the message, not the room: visible in the "all rooms" feed where the
	// message lives; no channel field needed.
	type pinPayload struct {
		ID     string `json:"id"`
		Pinned bool   `json:"pinned"`
	}
	g.POST("/pin", func(c *core.RequestEvent) error {
		if !hasPerm(c, permChat) {
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
		wasPinned := rec.GetBool("pinned")
		rec.Set("pinned", p.Pinned)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to pin message", err)
		}
		logModAction(app, c, modAction{
			Action:     "chat.pin",
			Target:     rec.Id,
			Before:     map[string]any{"pinned": wasPinned},
			After:      map[string]any{"pinned": p.Pinned},
			Reversible: true,
		})
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	}).Bind(apis.RequireAuth())

	registerShoutboxRooms(app, g)
	registerShoutboxRoomsAdmin(app, g)
	registerShoutboxStaff(app, g)
	registerShoutboxBlocks(app, g)
	registerShoutboxPrefs(app, g)
	registerShoutboxReactions(app, g)

	registerShoutboxUserState(app, g)

	registerShoutboxCommunity(app, g)
}

// Called from POST BEFORE app.Save. A message has either `user` (normal) or `author_ref` (hidden
// "actually them"): PB never returns it; used only so the author can delete their anon post from
// any device and moderators can mute the source instead of chasing IPs.
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

	// Block closes DMs in both directions (shoutbox_blocks.go). The ONLY place sending checks blocks —
	// in public rooms it only affects what the reader sees.
	if peer := shoutDMPeer(ch, authID); peer != "" && shoutBlockBetween(app, authID, peer) {
		return apis.NewForbiddenError("This conversation is closed.", nil)
	}

	// Anon mask only in public channels: in a private room it hides nothing and breaks the place (in a
	// DM "anon" is your only peer).
	private := ch != nil && ch.GetBool("is_private")
	if isUser && in.Anon && !private {
		rec.Set("user", "")
		rec.Set("author_ref", authID)
		rec.Set("anon_key", shoutAnonKey(requestIP(c.Request)))
	}

	// The mask goes on exactly when the record has no author — same case for guests and for logged-in
	// users who just stripped their signature.
	if rec.GetString("user") == "" {
		if err := shoutApplyAnonMask(rec, in.Mask); err != nil {
			return apis.NewBadRequestError(err.Error(), nil)
		}
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

type shoutPostInput struct {
	Text    string
	ReplyTo string
	Channel string
	Anon    bool
	Mask    string
	DelPass string
	Image   *filesystem.File
}

// Two body formats: JSON (v1) and multipart with an image, told apart by Content-Type. Images only
// for logged-in users: anonymous uploads go from "meme" to "unhostable content" too fast.
func shoutReadPostInput(c *core.RequestEvent, isUser bool) (shoutPostInput, error) {
	var in shoutPostInput

	ct := c.Request.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "multipart/form-data") {
		var p struct {
			Text    string `json:"text"`
			ReplyTo string `json:"reply_to"`
			Channel string `json:"channel"`
			Anon    bool   `json:"anon"`
			Mask    string `json:"mask"`
			DelPass string `json:"del_pass"`
		}
		if err := c.BindBody(&p); err != nil {
			return in, apis.NewBadRequestError("Invalid payload", err)
		}
		in.Text, in.ReplyTo, in.Channel = p.Text, p.ReplyTo, p.Channel
		in.Anon, in.Mask, in.DelPass = p.Anon, p.Mask, p.DelPass
		return in, nil
	}

	// Cap the WHOLE body BEFORE parsing: ParseMultipartForm limits only memory and silently spills the
	// rest to temp files — a sent gigabyte lands on the droplet disk first. MaxBytesReader cuts at the
	// socket. +1 MB slack for text and multipart overhead.
	c.Request.Body = http.MaxBytesReader(c.Response, c.Request.Body, shoutImageMaxBytes+(1<<20))
	if err := c.Request.ParseMultipartForm(shoutImageMaxBytes + (1 << 20)); err != nil {
		return in, apis.NewBadRequestError("Invalid form", err)
	}
	in.Text = c.Request.FormValue("text")
	in.ReplyTo = c.Request.FormValue("reply_to")
	in.Channel = c.Request.FormValue("channel")
	in.DelPass = c.Request.FormValue("del_pass")
	in.Mask = c.Request.FormValue("mask")
	in.Anon = c.Request.FormValue("anon") == "1" || c.Request.FormValue("anon") == "true"

	fh, _, err := c.Request.FormFile("image")
	if err != nil {
		return in, nil
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
		return in, apis.NewBadRequestError("Image is too big (max 8 MB).", nil)
	}
	// The part's Content-Type is a client hint; PB has the final word (field mimeTypes checked against
	// real content on save).
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

const (
	shoutPruneBatch = 500
	// Per-run cap for the night's sake: deleting a million spam rows at once = hours of locked SQLite
	// writes. Unfinished today → continued tomorrow.
	shoutPruneMaxPerRun = 20000
)

// Batches until done, not "first 500 till tomorrow": one batch/day is less than daily inflow on a
// live chat; retention that lags inflow isn't retention.
func shoutPruneOld(app core.App) {
	cutoff := time.Now().UTC().Add(-time.Duration(shoutKeepDays) * 24 * time.Hour)
	cut := cutoff.Format("2006-01-02 15:04:05.000Z")
	total := 0
	for total < shoutPruneMaxPerRun {
		old, err := app.FindRecordsByFilter(shoutboxCol, "created < {:cut}", "created",
			shoutPruneBatch, 0, dbx.Params{"cut": cut})
		if err != nil {
			app.Logger().Warn("shoutbox: age retention query failed", "error", err.Error())
			return
		}
		if len(old) == 0 {
			break
		}
		// Offset always 0: deleted rows leave the cursor; paginating during deletion would skip every
		// other batch.
		failed := 0
		for _, r := range old {
			if err := app.Delete(r); err != nil {
				failed++
				app.Logger().Warn("shoutbox: age retention delete failed", "id", r.Id, "error", err.Error())
			}
		}
		total += len(old) - failed
		// A batch that didn't delete (permissions, broken link) comes back identical next loop — bail
		// instead of spinning.
		if failed == len(old) {
			break
		}
	}
	if total > 0 {
		app.Logger().Info("shoutbox: pruned old messages", "count", total, "older_than_days", shoutKeepDays)
	}
}
