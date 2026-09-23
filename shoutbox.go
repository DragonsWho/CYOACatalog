// Site chat (shoutbox) core: posting, anti-spam, presence, notifications. Spec:
// wiki/components/shoutbox-spec.md (desk repo). shoutbox_messages create/update/delete are
// backend-only; reads and realtime are stock PB list/subscribe (public listRule). All anti-spam
// state is in-memory (reset on restart — accepted). Feature flag SHOUTBOX_ENABLED=1; off → all
// endpoints 404, frontend hides UI. v2 fields (rooms, images, etc.) in shoutbox_v2.go.
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
	shoutboxCol      = "shoutbox_messages"
	shoutChannelsCol = "shoutbox_channels"
	// Guests 300 chars (anonymous walls of text are the first thing used to flood), logged-in 1500.
	// Upper bound comes from the `text` field in the schema (PB/add_shoutbox_v2_schema.py): don't
	// raise without a schema change or the DB cuts silently.
	shoutMaxLen     = 300
	shoutMaxLenUser = 1500
	// RETENTION IS OFF (author decision 2026-09-18). Chat history is devlog and discussion, not a log:
	// pruning silently ate conversations nobody meant to lose, unrecoverable. History: 2026-07-13
	// count cap (999 total) did most damage; 2026-08-03 + age; 2026-09-15 count removed, month kept;
	// now neither. shoutPruneOld is kept alive: re-enable only DELIBERATELY — excluding pinned
	// messages and likely per-room terms.
	shoutRetentionEnabled = false
	shoutKeepDays         = 30
	shoutMuteDuration     = 24 * time.Hour
	// "Online" = pinged within ~15 min + slack. CYOA sessions last hours without a reload. The window
	// MUST exceed the client ping interval (PRESENCE_MIN_GAP_MS in ShoutboxButton.tsx, 15 min) or live
	// readers blink out between pings — move the pair together. 15/20 is a compromise: 30/35 cut
	// requests 3× but meant "visited in the last half hour"; 10/15 was more honest but the ping runs
	// from EVERY site page.
	shoutOnlineWindow = 20 * time.Minute
	// Cap of the "who's here" list — for payload weight (piggybacks on the per-minute ping of everyone
	// with the member panel open; ~50 bytes/name). It was 60 and silently cut ALPHABETICALLY in prod
	// (default "visible" since 2026-08-05 lists every logged-in catalog reader) — the second half of
	// the alphabet vanished, not even counted in "and N anonymous". 400 with headroom; cut people are
	// now COUNTED and reported.
	shoutWhoLimit = 400

	shoutHereLimit = 24

	// The name list lives at least as long as the counter: someone away for tea must not vanish — an
	// empty list reads "I'm alone here" and chat dies.
	shoutWhoWindow = 30 * time.Minute

	// Presence entries must live at least as long as both windows above, or people silently vanish
	// while still counting as alive.
	shoutPresenceKeep = 45 * time.Minute

	shoutCollapseWin = 10 * time.Minute

	// Badge smoothing: instant online() jumps with traffic bursts (40↔300), so we publish a window
	// average.
	shoutSampleEvery  = 30 * time.Second
	shoutSmoothWindow = 10 * time.Minute

	// Dup-protection window catches only double Enter and resends over a hung network. Beyond that
	// it's normal speech ("+", "ok", "lol" repeat all evening) — suppressing them silently eats real
	// messages.
	shoutDupWindow = 10 * time.Second

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
	// Dev fallback. In prod set your own, or anon_key is recoverable from IP by brute force.
	return "shoutbox-dev-salt"
}

// Stop words from env SHOUTBOX_WORD_FILTER (author supplies the list; not in repo).
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

// anon_key is deterministic within shoutAnonWindow (one anon's lines are recognizable, the
// pseudo-name expires), untracked across windows; the salt keeps it unrecoverable from IP. v1 used
// a day (evening and night anon looked like two people); v2 uses a week (author decision
// 2026-07-31). Side effect: an anon mute holds its full 24h instead of dropping at midnight with
// the key change.
const shoutAnonWindow = 7 * 24 * time.Hour

func shoutAnonKey(ip string) string {
	bucket := time.Now().UTC().Unix() / int64(shoutAnonWindow/time.Second)
	return shoutHash(ip, shoutSalt(), strconv.FormatInt(bucket, 10))
}

type shoutWho struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar,omitempty"`
	Mod    bool   `json:"mod,omitempty"`
}

type presenceEntry struct {
	at     time.Time
	user   bool
	hidden bool
	who    shoutWho
	whoAt  time.Time
	// Separate timestamp for "where": presence updates from any page, "I'm in this topic" only from
	// chat; without it someone who left for the catalog stayed listed in the topic.
	ch   string
	chAt time.Time
}

// Time is required: without it "same text" would be blocked forever.
type lastTextEntry struct {
	text string
	at   time.Time
}

type shoutState struct {
	mu       sync.Mutex
	lastPost map[string]time.Time
	hourly   map[string][]time.Time
	lastText map[string]lastTextEntry
	mutes    map[string]time.Time
	presence map[string]presenceEntry

	onlineSamples []int

	sysID    string
	sysAt    time.Time
	sysGames []map[string]any
}

var shout = &shoutState{
	lastPost: map[string]time.Time{},
	hourly:   map[string][]time.Time{},
	lastText: map[string]lastTextEntry{},
	mutes:    map[string]time.Time{},
	presence: map[string]presenceEntry{},
}

// checkAndReserve atomically checks mute/limits/dup and reserves a slot. (0,"") ok; (200,"dup")
// silently swallow a duplicate. `muted` is also used for edits: otherwise a muted user could keep
// "posting" by rewriting their last message.
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
	if e, ok := s.lastText[source]; ok && e.text == text && now.Sub(e.at) < shoutDupWindow {
		return http.StatusOK, "dup"
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
	s.lastText[source] = lastTextEntry{text: text, at: now}
	return 0, ""
}

// unreserve: the reservation happens BEFORE the DB write (correct — the double-Enter race is
// resolved there), but without rollback any save error became silent loss: a retry within seconds
// hit the dup window, got an honest 200 ok+duplicate, and the user saw a cleared input and an empty
// feed. Release the dup window and hourly quota; lastPost (min interval) is NOT released.
func (s *shoutState) unreserve(source, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.lastText[source]; ok && e.text == text {
		delete(s.lastText, source)
	}
	if h := s.hourly[source]; len(h) > 0 {
		s.hourly[source] = h[:len(h)-1]
	}
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

// Default for registered users is VISIBLE (author decision 2026-08-05). The default used to live on
// the client chat screen, so catalog readers with chat closed counted as "hidden" (2 names for 20
// logged-in online). Clearing hidden here makes unticking chat_hidden take effect immediately.
func (s *shoutState) ping(key string, who shoutWho) {
	now := time.Now()
	s.mu.Lock()
	e := s.presence[key]
	e.at = now
	if who.ID != "" {
		e.user = true
		e.hidden = false
		e.who = who
		e.whoAt = now
	}
	s.presence[key] = e
	s.mu.Unlock()
}

// Separate from ping() on purpose: "on the site" comes from any page, "in this topic" only from an
// open chat; merging them would erase the channel on every catalog ping. Doesn't create entries.
func (s *shoutState) noteWhere(key, ch string) {
	if ch == "" {
		return
	}
	s.mu.Lock()
	if e, ok := s.presence[key]; ok {
		e.ch = ch
		e.chAt = time.Now()
		s.presence[key] = e
	}
	s.mu.Unlock()
}

func (s *shoutState) whoHere(ch string) (out []shoutWho, more int) {
	out = make([]shoutWho, 0, 8)
	if ch == "" {
		return out, 0
	}
	now := time.Now()
	s.mu.Lock()
	seen := map[string]bool{}
	for _, e := range s.presence {
		if e.ch != ch || now.Sub(e.chAt) >= shoutWhoWindow {
			continue
		}
		if e.hidden || e.who.ID == "" {
			more++
			continue
		}
		if seen[e.who.ID] {
			continue
		}
		seen[e.who.ID] = true
		out = append(out, e.who)
	}
	s.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if len(out) > shoutHereLimit {
		more += len(out) - shoutHereLimit
		out = out[:shoutHereLimit]
	}
	return out, more
}

// Clears the card and sets the flag: the card outlives the presence mark, so a hider would linger
// ~10 min otherwise.
func (s *shoutState) pingHidden(key string) {
	s.mu.Lock()
	s.presence[key] = presenceEntry{at: time.Now(), user: true, hidden: true}
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
		} else if now.Sub(e.at) >= shoutPresenceKeep {
			// Sweep by the LONGEST term: an entry out of the counter may still show in the name list.
			delete(s.presence, k)
		}
	}
	return n
}

// Visible members sorted by name (no jumping), plus the rest split into guests /
// registered-but-hidden / cut by the cap. "and 76 more" alone read as an empty hall. `cut` is
// separate on purpose: a guest is nameless, a hider chose it, a cut member is someone WE didn't
// show — merging them lies both ways.
func (s *shoutState) whoList() (out []shoutWho, guests, hidden, cut int) {
	now := time.Now()
	s.mu.Lock()
	seen := map[string]bool{}
	out = make([]shoutWho, 0, 16)
	for _, e := range s.presence {
		visible := !e.hidden && e.who.ID != "" && now.Sub(e.whoAt) < shoutWhoWindow
		if visible {
			if seen[e.who.ID] {
				continue
			}
			seen[e.who.ID] = true
			out = append(out, e.who)
			continue
		}
		// Only count those still online: the card has its own, longer lifetime.
		if now.Sub(e.at) >= shoutOnlineWindow {
			continue
		}
		if e.user {
			hidden++
		} else {
			guests++
		}
	}
	s.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if len(out) > shoutWhoLimit {
		cut = len(out) - shoutWhoLimit
		out = out[:shoutWhoLimit]
	}
	return out, guests, hidden, cut
}

// Logged-in presence key is ip+account, not ip: two people behind one router (or one person testing
// two accounts) shared one cell and overwrote each other's card. Anons stay per-IP. shoutLenLimit
// is shared by send and edit so edits can't bypass the send limit.
func shoutLenLimit(isUser bool) int {
	if isUser {
		return shoutMaxLenUser
	}
	return shoutMaxLen
}

func shoutPresenceKey(ip, authID string) string {
	h := shoutHash(ip, shoutSalt())
	if authID == "" {
		return h
	}
	return h + "|u:" + authID
}

// Sampled by a ticker (uniform in time, not tied to ping traffic). online() takes the lock itself —
// sample BEFORE taking ours.
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
	return (sum + n/2) / n
}

var shoutSamplerOnce sync.Once

const shoutSweepEvery = 5 * time.Minute

func startShoutSampler() {
	shout.sampleOnline()
	go func() {
		t := time.NewTicker(shoutSampleEvery)
		defer t.Stop()
		for range t.C {
			shout.sampleOnline()
		}
	}()
	go func() {
		t := time.NewTicker(shoutSweepEvery)
		defer t.Stop()
		for range t.C {
			shout.sweepLimits()
		}
	}()
}

// Presence sweeps itself in online(); lastPost/hourly/lastText are touched only on send, so a
// one-time poster would sit in memory until restart. Chat runs for months.
func (s *shoutState) sweepLimits() {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, t := range s.lastPost {
		if now.Sub(t) > time.Hour {
			delete(s.lastPost, k)
		}
	}
	for k, times := range s.hourly {
		keep := times[:0]
		for _, t := range times {
			if now.Sub(t) < time.Hour {
				keep = append(keep, t)
			}
		}
		if len(keep) == 0 {
			delete(s.hourly, k)
		} else {
			s.hourly[k] = keep
		}
	}
	for k, e := range s.lastText {
		if now.Sub(e.at) > shoutDupWindow {
			delete(s.lastText, k)
		}
	}
	for k, until := range s.mutes {
		if now.After(until) {
			delete(s.mutes, k)
		}
	}
}

// Unread count used to be computed here: a COUNT per ping per visitor, personal and uncacheable.
// Now the browser computes it from the shared edge-cached "pulse" (times of the last ~50 messages
// minus own read mark). The server only returns the mark (users.shoutbox_last_seen) so badges agree
// across devices.
func shoutTruncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// Empty channel is a v1 leftover (no rooms then): such messages live in the default (first public)
// room, and the frontend shows them there. Empty == default.
func shoutSameChannel(app core.App, a, b string) bool {
	if a == b {
		return true
	}
	if a != "" && b != "" {
		return false
	}
	def, err := shoutResolveChannel(app, "", "")
	if err != nil || def == nil {
		return false
	}
	return a == def.Id || b == def.Id
}

// Reply snapshot {id, name, anon_key, text} is denormalized into the reply, so the quote survives
// deletion of the original. chID = the room the REPLY goes to: you may only reply to a message in
// the same room — the snapshot copies 140 chars of someone's text, and private-room messages are
// visible only to members; without this a member could quote a private room into General just by
// replying in the wrong tab.
func shoutReplySnapshot(app core.App, parentID, chID string) map[string]any {
	rec, err := app.FindRecordById(shoutboxCol, parentID)
	if err != nil || rec.GetString("kind") == "system" {
		return nil
	}
	if !shoutSameChannel(app, rec.GetString("channel"), chID) {
		return nil
	}
	name := ""
	if uid := rec.GetString("user"); uid != "" {
		if u, e := app.FindRecordById("users", uid); e == nil {
			// Some accounts have empty name (OAuth, old records): fall back to username, or the frozen
			// snapshot would show a real person as "Anonymous" forever.
			name = u.GetString("name")
			if name == "" {
				name = u.GetString("username")
			}
		}
	}
	return map[string]any{
		"id": rec.Id,
		// Parent's author id lets the client know "this was a reply to ME" for messages outside the
		// 500-message window (names are ambiguous and change). Nothing new leaks: anonymous posts don't
		// store the author (hidden author_ref).
		"user":     rec.GetString("user"),
		"name":     name,
		"anon_key": rec.GetString("anon_key"),
		// Freeze the parent's mask too, else changing a mask would re-sign all old quotes.
		"anon_mask": rec.GetString("anon_mask"),
		"text":      shoutTruncate(rec.GetString("text"), 140),
	}
}

// Bell notifications for a new chat message: parent author (reply), @username mentions, DM partner
// (see shoutDMQuiet — one ping per conversation, not per line). Logged-in only. Best-effort. One
// notification per user, reply > mention, never to self. mentionRE shared with comments (main.go).
// Returns userID → type "personally addressed" map; push.go uses it for "someone replied" vs plain
// pushes. messageID/channelID go to notifications.shout_message/shout_channel so a bell click jumps
// to the message (same jumpTo as quote clicks). Unique @names capped so a message full of mentions
// isn't a 150-term filter.
const shoutMentionResolveMax = 20

func shoutMentionNames(text string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, 4)
	for _, m := range mentionRE.FindAllStringSubmatch(text, -1) {
		n := m[2]
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
		if len(out) >= shoutMentionResolveMax {
			break
		}
	}
	return out
}

func shoutboxNotify(app core.App, actorID, text, replyToID, messageID, channelID string) map[string]string {
	recipients := map[string]string{}
	ownerOnly := ""
	add := func(uid, ntype string) {
		if uid == "" || uid == actorID {
			return
		}
		if _, ok := recipients[uid]; ok {
			return
		}
		// Blocked author → no bell and no push (shoutbox_blocks.go). Mentioning someone who blocked you
		// is the easiest way around a block if unchecked.
		if shoutBlockExists(app, uid, actorID) {
			return
		}
		recipients[uid] = ntype
	}

	// DMs have exactly one kind of ping, "wrote to you", which suppresses reply/mention (with one
	// partner, quoting is style, not addressing).
	isDM := false
	threadOwner := ""
	if channelID != "" && actorID != "" {
		if ch, e := app.FindRecordById(shoutChannelsCol, channelID); e == nil {
			if ch.GetBool("is_dm") {
				isDM = true
				add(shoutDMPeer(ch, actorID), "shout_dm")
			} else if !ch.GetBool("is_private") {
				// User topic (public channel with owner): the owner must learn about replies in their topic
				// even unmentioned.
				threadOwner = ch.GetString("owner")
				// Anonymous topic: owner empty on purpose, author in author_ref — hidden from READERS, not from
				// us; the author still gets replies.
				if threadOwner == "" {
					threadOwner = ch.GetString("author_ref")
				}
			}
		}
	}

	if !isDM {
		if replyToID != "" {
			if r, e := app.FindRecordById(shoutboxCol, replyToID); e == nil {
				add(r.GetString("user"), "shout_reply")
			}
		}
		// All @names in ONE query (used to be one query per mention inside the send handler).
		if names := shoutMentionNames(text); len(names) > 0 {
			parts := make([]string, 0, len(names))
			params := dbx.Params{}
			for i, n := range names {
				key := "u" + strconv.Itoa(i)
				parts = append(parts, "username = {:"+key+"}")
				params[key] = n
			}
			us, e := app.FindRecordsByFilter("users", strings.Join(parts, " || "), "", len(names), 0, params)
			if e == nil {
				for _, u := range us {
					add(u.Id, "shout_mention")
				}
			}
		}
		// Topic owner AFTER addressed recipients: if already replied to personally, that wins. No new
		// notification type on purpose: notifications.type is a select field — a new value needs a prod
		// schema change. ownerOnly marks rows that get the quiet rule below; addressed pings are never
		// quieted.
		if threadOwner != "" {
			if _, had := recipients[threadOwner]; !had {
				add(threadOwner, "shout_reply")
				if _, got := recipients[threadOwner]; got {
					ownerOnly = threadOwner
				}
			}
		}
	}

	coll, err := app.FindCollectionByNameOrId("notifications")
	if err != nil {
		return recipients
	}
	for uid, ntype := range recipients {
		coalesced := ntype == "shout_dm" && !shoutChanNotifyDue(app, uid, channelID, "shout_dm")
		// A lively topic = dozens of lines per evening; one bell row per line would flood the bell. Same
		// rule as DMs: while an unread row about this topic exists (or just did), no second one.
		coalesced = coalesced || (uid == ownerOnly && !shoutChanNotifyDue(app, uid, channelID, "shout_reply"))
		n := core.NewRecord(coll)
		n.Set("recipient", uid)
		n.Set("type", ntype)
		if actorID != "" {
			n.Set("actor", actorID)
		}
		n.Set("shout_message", messageID)
		n.Set("shout_channel", channelID)
		if coalesced {
			previous, err := app.FindRecordsByFilter("notifications", "recipient={:u} && type={:t} && shout_channel={:ch}", "-created", 1, 0, dbx.Params{"u": uid, "t": ntype, "ch": channelID})
			if err == nil && len(previous) > 0 {
				n = previous[0]
				n.Set("shout_message", messageID)
			}
		}
		if e := app.RunInTransaction(func(tx core.App) error {
			msg, err := tx.FindRecordById(shoutboxCol, messageID)
			if err != nil {
				return err
			}
			if coalesced {
				n.Set("actor", actorID)
				n.Set("created", msg.GetDateTime("created"))
			}
			read := chatReadCursors(tx, uid)[channelID] >= msg.GetDateTime("created").Time().UnixMilli()
			n.Set("read", read)
			return tx.Save(n)
		}); e != nil {
			app.Logger().Warn("shoutbox: notify failed", "type", ntype, "user", uid, "error", e.Error())
		}
	}
	return recipients
}

// Silence after which a DM conversation counts as NEW and goes to the bell again. Sounds/tab titles
// are momentary; on phones (chat column usually closed) conversations get lost otherwise. One row
// per message would flood the bell.
const shoutDMQuiet = 2 * time.Hour

// Bell row due if no conversation yet, or it restarted after silence; not if an unread row for this
// channel exists. Read error → "due" (missing a DM ping is worse than an extra one). Used for DMs
// (shout_dm) and "reply in your topic" (shout_reply).
func shoutChanNotifyDue(app core.App, uid, channelID, ntype string) bool {
	if uid == "" || channelID == "" || ntype == "" {
		return false
	}
	since := types.NowDateTime().Add(-shoutDMQuiet)
	_, err := app.FindFirstRecordByFilter(
		"notifications",
		"recipient = {:u} && type = {:n} && shout_channel = {:c} && (read = false || created > {:t})",
		dbx.Params{"u": uid, "n": ntype, "c": channelID, "t": since},
	)
	return err != nil
}

// "🎲 New game" system post, or appended to a recent batch if publishes come faster than every 10
// min (the conveyor must not flood chat). Event is always {type:"new_game", games:[…]}; frontend
// renders 1 or N.
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

func registerShoutbox(app *pocketbase.PocketBase) {
	// Any games create path (queue cron, God Mode, user upload) → system post. Updates excluded.
	app.OnRecordAfterCreateSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		shoutboxSystemNewGame(app, e.Record.Id, e.Record.GetString("title"), shoutGameAuthor(app, e.Record))
		return e.Next()
	})

	app.OnRecordAfterCreateSuccess("announcements").BindFunc(func(e *core.RecordEvent) error {
		shoutboxSystemAnnouncement(app, e.Record.GetString("title"))
		return e.Next()
	})

	// Retention cron not registered at all (so it can't be run by hand from PB admin). See
	// shoutRetentionEnabled.
	if shoutRetentionEnabled {
		app.Cron().MustAdd("shoutbox_retention", "17 4 * * *", func() {
			shoutPruneOld(app)
		})
	}

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		// The feed is read via stock PB list (/api/collections/shoutbox_messages/records), which had no
		// noindex header. robots.txt Disallow is a request not to fetch, not a ban on showing: raw chat
		// JSON can still be indexed via a link.
		se.Router.BindFunc(func(c *core.RequestEvent) error {
			if strings.HasPrefix(c.Request.URL.Path, "/api/collections/shoutbox_") {
				c.Response.Header().Set("X-Robots-Tag", "noindex")
			}
			return c.Next()
		})

		g := se.Router.Group("/api/custom/shoutbox")

		if shoutboxEnabled() {
			shoutSamplerOnce.Do(startShoutSampler)
		}

		g.BindFunc(func(c *core.RequestEvent) error {
			if !shoutboxEnabled() {
				return c.NotFoundError("Not found", nil)
			}
			// Spec §11: chat is not indexed (same reasoning — Disallow isn't enough).
			c.Response.Header().Set("X-Robots-Tag", "noindex")
			return c.Next()
		})

		// GET /config and GET /presence removed 2026-09-17 (unused). Chat-enabled state comes from /pulse
		// ('disabled'); online count comes with the presence ping (POST: uncached, knows the caller).
		// Ping every 60s while the tab is active; returns online count and the caller's OWN anon_key
		// (anons see their pseudo-name) — here, not in a GET, because POST isn't edge-cached and the key
		// is per-IP. v2: registered users are VISIBLE in "who's here" by default (author decision, stated
		// three times); card built on ANY logged-in ping, catalog or chat — the list exists so there's
		// someone to DM. Opt-out = `chat_hidden` in profile, read from the account record (hides from all
		// devices at once).
		g.POST("/ping", func(c *core.RequestEvent) error {
			ip := requestIP(c.Request)
			isUser := c.Auth != nil && c.Auth.Collection().Name == "users"
			authID := ""
			who := shoutWho{}
			hideMe := false
			if isUser {
				authID = c.Auth.Id
				hideMe = c.Auth.GetBool("chat_hidden")
				who = shoutWho{
					ID:     c.Auth.Id,
					Name:   c.Auth.GetString("name"),
					Avatar: c.Auth.GetString("avatar"),
					Mod:    c.Auth.GetBool("isModerator"),
				}
				if who.Name == "" {
					who.Name = c.Auth.GetString("username")
				}
			}
			key := shoutPresenceKey(ip, authID)

			if hideMe {
				shout.pingHidden(key)
			} else {
				shout.ping(key, who)
			}
			// "THIS DEVICE is in chat now", regardless of visibility (no push for what's on screen). The
			// device identifies itself by its push endpoint; empty body (v1 client) is fine.
			var pd struct {
				Endpoint     string            `json:"endpoint"`
				ReadMessages map[string]string `json:"read_messages"`
				// Per-room read marks from THIS device ride on the ping (sent every minute anyway) —
				// cross-device read sync costs no extra request (shoutbox_user_state.go).
				Seen  map[string]int64 `json:"seen"`
				Watch []string         `json:"watch"`
			}
			bodyOK := c.BindBody(&pd) == nil
			if bodyOK && pd.Endpoint != "" {
				pushActive.touch(pushDeviceKey(pd.Endpoint))
			}
			q := c.Request.URL.Query()
			// Written only for pings from an open chat; header pings carry no channel and would leave a
			// stale "where".
			if q.Get("chat") == "1" {
				shout.noteWhere(key, q.Get("ch"))
			}
			out := map[string]any{
				"online":   shout.smoothOnline(),
				"anon_key": shoutAnonKey(ip),
			}
			// Anonymous-topic schema present? The general feed filters user topics out by channel, and
			// mentioning anon_key in that filter before the fields exist breaks the query — i.e. the feed.
			// Sent only when true (not on every ping).
			if shoutCommunityAnonReady {
				out["anon_threads"] = true
			}
			// roster=1 = member panel on screen: the list piggybacks on this response (a separate 30s poll
			// would double chat traffic for every wide-screen reader). Closed panel → nothing extra (mobile
			// savings).
			if r := q.Get("roster"); r == "1" || r == "true" {
				who, guests, hidden, cut := shout.whoList()
				out["who"] = who
				out["guests"] = guests
				out["hidden"] = hidden
				out["cut"] = cut
				if ch := q.Get("ch"); ch != "" {
					here, more := shout.whoHere(ch)
					out["here"] = here
					out["here_more"] = more
				}
			}
			// Server-side read mark: the browser computes unread from the cacheable pulse, but only the
			// server knows cross-device sync. Return the mark, not a count.
			if isUser {
				if t := c.Auth.GetDateTime("shoutbox_last_seen"); !t.IsZero() {
					out["last_seen"] = t.Time().UTC().Format(time.RFC3339)
				}
			}
			// Channel highlights only on pings from the OPEN chat (?chat=1): header pings run on every page
			// for every visitor — every byte multiplies by site traffic.
			if q.Get("chat") == "1" {

				if bodyOK {
					shoutChans.seenMany(authID, pd.Seen)
				}
				allow := map[string]bool{"": true}
				chans, _ := shoutVisibleChannels(app, authID)
				for _, ch := range chans {
					allow[ch.ID] = true
				}
				// Topics named by the screen: the gateway verifies each is really public, else a foreign id
				// would reveal when a private room was active.
				var watched []string
				if bodyOK && len(pd.Watch) > 0 {
					watched = shoutWatch.filter(app, pd.Watch)
					for _, id := range watched {
						allow[id] = true
					}
				}
				last, mentions := shoutChans.snapshot(authID, allow)
				out["channels"] = last
				// Exact new counts only for topics on screen: rooms' times ride in the pulse (browser counts);
				// topics don't fit in the pulse (see shoutChanState.newSince).
				if n := shoutChans.newSince(watched, pd.Seen); len(n) > 0 {
					out["new"] = n
				}
				if len(mentions) > 0 {
					out["mentions"] = mentions
				}
				if isUser && bodyOK {
					if reads := shoutSyncReads(app, authID, pd.Seen); len(reads) > 0 {
						out["reads"] = reads
					}
				}
			} else if isUser {
				// DMs and private rooms in the header badge: the pulse is one shared edge-cached response, so
				// private conversations can't go there — their marks come via personal uncacheable POST.
				if ids := shoutPrivateChannelIDs(app, authID); len(ids) > 0 {
					if last, _ := shoutChans.snapshot(authID, ids); len(last) > 0 {
						out["channels"] = last
					}
				}
			}
			if isUser && q.Get("chat") == "1" && q.Get("attention") == "1" {
				if len(pd.ReadMessages) > 0 && len(pd.ReadMessages) <= 100 {
					if err := chatMarkRead(app, authID, pd.ReadMessages); err == nil {
						out["read_ack"] = true
					}
				}
				if attention, err := chatAttention(app, authID); err == nil {
					out["attention"] = attention
				}
			}
			return c.JSON(http.StatusOK, out)
		})

		// users.shoutbox_last_seen is the cross-device source of truth for the badge. Written via server
		// app.Save, so the protected-field guard (OnRecordUpdateRequest) doesn't fire. Anons keep read
		// state only in localStorage.
		g.POST("/seen", func(c *core.RequestEvent) error {
			c.Auth.Set("shoutbox_last_seen", types.NowDateTime())
			if err := app.Save(c.Auth); err != nil {
				return c.InternalServerError("Failed to save read marker", err)
			}
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}).Bind(apis.RequireAuth())

		g.POST("", func(c *core.RequestEvent) error {
			isUser := c.Auth != nil && c.Auth.Collection().Name == "users"

			p, err := shoutReadPostInput(c, isUser)
			if err != nil {
				return err
			}
			text := strings.TrimSpace(p.Text)
			// An image with no caption is a legal message ("reaction").
			if text == "" && p.Image == nil {
				return c.BadRequestError("Empty message", nil)
			}
			if max := shoutLenLimit(isUser); utf8.RuneCountInString(text) > max {
				return c.BadRequestError(fmt.Sprintf("Message too long (max %d characters)", max), nil)
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

			// Dup key = text plus a random filename for image posts: otherwise two captionless image
			// reactions in a row count as one duplicate.
			dupKey := text
			if p.Image != nil {
				dupKey = text + "\x00" + p.Image.Name
			}
			// Room is part of the dup key: double-Enter is always one room; without it "+1" said in two
			// rooms lost the second. Unresolved channel id is fine here — just a map key.
			dupKey = strings.TrimSpace(p.Channel) + "\x00" + dupKey
			if status, msg := shout.checkAndReserve(source, dupKey, isUser); status != 0 {
				if msg == "dup" {
					return c.JSON(http.StatusOK, map[string]any{"ok": true, "duplicate": true})
				}
				return apis.NewApiError(status, msg, nil)
			}
			// Anything below may fail — release the reservation or a retry eats the dup window (see
			// unreserve).
			saved := false
			defer func() {
				if !saved {
					shout.unreserve(source, dupKey)
				}
			}()

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
			// v2 fields BEFORE the quote: we need the target room to decide whether the parent may be
			// quoted.
			if err := shoutApplyV2Fields(app, c, rec, p, isUser); err != nil {
				return err
			}
			replyTo := strings.TrimSpace(p.ReplyTo)
			if replyTo != "" {
				if snap := shoutReplySnapshot(app, replyTo, rec.GetString("channel")); snap != nil {
					rec.Set("reply", snap)
				} else {
					replyTo = ""
				}
			}
			if err := app.Save(rec); err != nil {
				return c.InternalServerError("Failed to save message", err)
			}
			saved = true
			// Anonymous posts carry no actor in notifications (else "X replied" would de-anonymize). Ask the
			// RECORD, not the request flag: not every room accepts a mask (shoutApplyV2Fields drops it in
			// private rooms/DMs), and going by the flag made a signed DM notify as "Anonymous" ("a stranger
			// replied to you").
			actorID := rec.GetString("user")
			chID := rec.GetString("channel")
			targeted := shoutboxNotify(app, actorID, text, replyTo, rec.Id, chID)
			// Channel highlights: all in memory — no DB query, no schema field.
			shoutChans.noteMessage(chID)
			// "Where you posted recently" has a 1-min cache, but your own line must appear there
			// immediately.
			shoutMine.forget(actorID)
			for uid := range targeted {
				shoutChans.noteMention(uid, chID)
			}
			shoutPushForMessage(app, rec, actorID, targeted)
			return c.JSON(http.StatusOK, map[string]any{"ok": true, "id": rec.Id})
		})

		// Mention autocomplete: up to 8 users; names/usernames are public anyway; minimal fields.
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
			if !hasPerm(c, permChat) {
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

		g.POST("/delete", func(c *core.RequestEvent) error {
			rec, err := requireMod(c)
			if err != nil {
				return err
			}
			msgBefore := modSnapshot(rec, "user", "author_ref", "nickname", "channel", "message", "image", "pinned", "created")
			if err := app.Delete(rec); err != nil {
				return c.InternalServerError("Failed to delete message", err)
			}
			logModAction(app, c, modAction{
				Action:     "chat.delete",
				Target:     rec.Id,
				Before:     msgBefore,
				Reversible: true,
				Note:       "hard delete; restore by re-creating the message from `before`",
			})
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}).Bind(apis.RequireAuth())

		// 24h mute, in-memory (restart clears — accepted for v1).
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
			logModAction(app, c, modAction{
				Action:     "chat.mute",
				Target:     source,
				After:      map[string]any{"muted": true, "message": rec.Id},
				Reversible: true,
				Note:       "in-memory mute for 24h; lifted by POST /unmute or a server restart",
			})
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}).Bind(apis.RequireAuth())

		g.POST("/unmute", func(c *core.RequestEvent) error {
			rec, err := requireMod(c)
			if err != nil {
				return err
			}
			if source := shoutMuteSource(rec); source != "" {
				shout.unmute(source)
				logModAction(app, c, modAction{
					Action:     "chat.unmute",
					Target:     source,
					After:      map[string]any{"muted": false, "message": rec.Id},
					Reversible: true,
				})
			}
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}).Bind(apis.RequireAuth())

		registerShoutboxV2(app, g)

		return se.Next()
	})
}
