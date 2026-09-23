// User-created threads ("thread chat"): anyone can open a topic with tag stripes, message count,
// likes; the topic list lives apart from the author's pinned rooms. Handlers on
// /api/custom/shoutbox; frontend routes /chat/threads (index) and /chat/t/<slug> (topic) in
// App.tsx.
package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
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
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/security"
)

const (
	// Topics per user per day, SLIDING 24h window (a calendar day can be gamed at midnight). Was 3; 10
	// because people started rationing topics.
	shoutCommunityPerDay  = 10
	shoutCommunityPerPage = 30
	shoutCommunityPerMax  = 50
	shoutCommunitySideMax = 12
	shoutCommunityPinsMax = 10

	// Site-wide pins: 3 (it's a shelf every visitor sees).
	shoutCommunitySitePinsMax = 3

	shoutCommunityTitleMax = 100
	shoutCommunityDescMax  = 200
	shoutCommunityTagsMax  = 3
	// Mirrors the op_text field max; longer than a reply (1500) on purpose.
	shoutCommunityOpMax = 4000
	// Mirrors maxSelect of op_images.
	shoutCommunityOpImagesMax  = 5
	shoutCommunityTopReactsMax = 4
)

const shoutCommunityActiveWindow = 7 * 24 * time.Hour

// "Is a user topic" condition kept in ONE place so SQL and PB filters can't drift. Empty owner
// excludes author rooms; is_private excludes DMs/private rooms. A var, not a const: anonymous
// topics have an empty owner by design (author in author_ref, shoutbox_anon.go), so the condition
// gains an anon_key clause only once those fields exist — mentioning a missing column breaks the
// whole query.
var shoutCommunityWhereSQL = `c.enabled = 1 AND c.is_private = 0 AND c.is_dm = 0 AND c.owner != ''`

var shoutCommunityAnonReady bool

var shoutCommunityAuthorSQL = `c.owner = {:u}`

// Inverse for PB filters: "author's pinned ROOM, not someone's topic". Empty owner alone stopped
// being enough once anonymous topics existed — they showed up in the room side menu (author found
// it 2026-09-16).
var shoutRoomOnlyFilter = "owner = ''"

// Check all three anon fields at once: half a schema = a topic that can be neither signed nor
// returned to its author.
func shoutCommunityInitAnon(app core.App) {
	coll, err := app.FindCollectionByNameOrId(shoutChannelsCol)
	if err != nil || coll == nil {
		return
	}
	for _, f := range []string{"anon_key", "anon_mask", "author_ref"} {
		if coll.Fields.GetByName(f) == nil {
			return
		}
	}
	shoutCommunityAnonReady = true
	shoutCommunityWhereSQL = `c.enabled = 1 AND c.is_private = 0 AND c.is_dm = 0 AND (c.owner != '' OR c.anon_key != '')`
	shoutCommunityAuthorSQL = `(c.owner = {:u} OR c.author_ref = {:u})`
	shoutRoomOnlyFilter = "owner = '' && anon_key = ''"
}

// Topics reuse the room `title` field; raise its max once at startup or PB rejects the record
// before our own check.
func shoutCommunityEnsureTitleMax(app core.App) {
	coll, err := app.FindCollectionByNameOrId(shoutChannelsCol)
	if err != nil || coll == nil {
		return
	}
	field, ok := coll.Fields.GetByName("title").(*core.TextField)
	if !ok || field.Max == 0 || field.Max >= shoutCommunityTitleMax {
		return
	}
	field.Max = shoutCommunityTitleMax
	if err := app.Save(coll); err != nil {
		log.Printf("shoutbox community: failed to raise thread title limit to %d: %v", shoutCommunityTitleMax, err)
	}
}

// A topic has an author: open (owner) or hidden (anon_key set). Five checks in this file use this —
// must not drift.
func shoutCommunityIsThread(rec *core.Record) bool {
	if rec == nil {
		return false
	}
	if rec.GetString("owner") != "" {
		return true
	}
	return shoutCommunityAnonReady && rec.GetString("anon_key") != ""
}

// Exactly one content tag (sfw/nsfw) is REQUIRED — the site-header filter hangs on it; an unmarked
// topic would be invisible to all or visible to all.
var (
	shoutCommunityRating = map[string]bool{"sfw": true, "nsfw": true}
	shoutCommunityExtra  = map[string]bool{"flood": true, "wip": true, "question": true}
)

// Separate from shoutChannel: half the fields are counters a channel must not have (see channelLast
// in shoutboxApi.ts).
type shoutCommunityRoom struct {
	ID     string   `json:"id"`
	Slug   string   `json:"slug"`
	Title  string   `json:"title"`
	Desc   string   `json:"description,omitempty"`
	Owner  string   `json:"owner"`
	Tags   []string `json:"tags"`
	OpText string   `json:"op_text,omitempty"`
	// File names, not URLs: the frontend builds URLs via pb.files so the storage domain lives in one
	// place. OpImage (first image only) stays for frontends already shipped before the list existed.
	OpImage  string   `json:"op_image,omitempty"`
	OpImages []string `json:"op_images,omitempty"`
	Created  int64    `json:"created"`
	Msgs     int      `json:"msgs"`
	LastAt   int64    `json:"last_at"`
	Likes    int      `json:"likes"`
	Liked    bool     `json:"liked,omitempty"`
	// omitempty by meaning: hidden topics never appear in normal lists; only /community/room and
	// /community/moderate carry it.
	Hidden  bool `json:"hidden,omitempty"`
	SitePin int  `json:"site_pin,omitempty"`
	// Two reaction shapes, not a dup: OpTop (3–4 most frequent + counts, what list rows draw; full
	// maps would be ~100 ids × 30 rows) and OpReactions (full map, only in the single-topic response).
	OpTop       []shoutCommunityReact `json:"op_top,omitempty"`
	OpReactions map[string][]string   `json:"op_reactions,omitempty"`
	Anon        bool                  `json:"anon,omitempty"`
	AnonKey     string                `json:"anon_key,omitempty"`
	Mask        string                `json:"mask,omitempty"`
	// "This is my topic": derivable from owner for normal topics, not for anonymous ones (real author
	// never leaves the server). Personal — must never appear in shared cached lists (authID empty
	// there).
	Mine bool `json:"mine,omitempty"`
}

type shoutCommunityReact struct {
	Name  string `json:"n"`
	Count int    `json:"c"`
	Mine  bool   `json:"m,omitempty"`
}

type shoutCommunityAgg struct {
	ID     string `db:"id"`
	Msgs   int    `db:"msgs"`
	LastAt string `db:"last_at"`
	Likes  int    `db:"likes"`
}

// Raw SQL, not FindRecordsByFilter: "by last reply" order lives in the messages feed, not the room
// record; PB filters can't express it and doing it in Go means loading every topic.
type shoutCommunityFilter struct {
	Order string
	Tag   string
	// nsfw filter comes from the THREE-position site-header switch (sfw/all/nsfw); a "hide" boolean
	// lied in nsfw position.
	Rating string
	// Title-only search on purpose: searching message text = full-text index over the site's biggest
	// table.
	Q string
	// "Mine" always uses c.Auth.Id, never a query param — otherwise it's "show all topics of that
	// person", which we didn't design.
	Owner string
	// nil vs empty slice DIFFER: nil = no restriction, empty = nothing matches ("Mine" for someone who
	// never posted).
	IDs    []string
	Window time.Duration
}

func shoutCommunitySpan(v string) time.Duration {
	switch v {
	case "month":
		return 30 * 24 * time.Hour
	case "year":
		return 365 * 24 * time.Hour
	default:
		return 7 * 24 * time.Hour
	}
}

// Query-string input enters SQL ONLY as bound parameters or constants chosen from it. Tag names and
// sort words are never interpolated (injection).
func shoutCommunitySQL(f shoutCommunityFilter) (where, having, orderBy string, params dbx.Params) {
	params = dbx.Params{}
	where = shoutCommunityWhereSQL
	// Tags are a JSON array; match with quotes so "nsfw" never matches a tag that merely starts the
	// same.
	switch f.Rating {
	case "sfw":
		where += ` AND (c.tags IS NULL OR c.tags NOT LIKE '%"nsfw"%')`
	case "nsfw":
		where += ` AND c.tags LIKE '%"nsfw"%'`
	}
	if shoutCommunityExtra[f.Tag] || shoutCommunityRating[f.Tag] {
		where += ` AND c.tags LIKE {:tag}`
		params["tag"] = `%"` + f.Tag + `"%`
	}
	if f.Q != "" {
		// Escape LIKE metacharacters: "100%" would match everything, "_" any letter.
		esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(f.Q)
		where += ` AND c.title LIKE {:q} ESCAPE '\'`
		params["q"] = "%" + esc + "%"
	}
	if f.Owner != "" {
		where += ` AND c.owner = {:own}`
		params["own"] = f.Owner
	}
	if f.IDs != nil {
		if len(f.IDs) == 0 {
			// Guaranteed-empty query rather than short-circuit: `total` is counted by ANOTHER query with the
			// same condition and they must agree.
			where += ` AND 1 = 0`
		} else {
			marks := make([]string, 0, len(f.IDs))
			for i, id := range f.IDs {
				key := fmt.Sprintf("mid%d", i)
				params[key] = id
				marks = append(marks, "{:"+key+"}")
			}
			where += ` AND c.id IN (` + strings.Join(marks, ",") + `)`
		}
	}
	since := ""
	if f.Window > 0 {
		since = time.Now().Add(-f.Window).UTC().Format("2006-01-02 15:04:05.000Z")
	}
	switch f.Order {
	case "active":
		// A new opening post is activity too: sort by the same COALESCE the activity window uses, or a
		// fresh unanswered thread sinks below all replied-to ones.
		orderBy = "COALESCE(MAX(m.created), c.created) DESC, c.created DESC"
		if since != "" {
			having = "COALESCE(MAX(m.created), c.created) >= {:since}"
			params["since"] = since
		}
	case "top":
		orderBy = "likes DESC, c.created DESC"
		if since != "" {
			where += ` AND c.created >= {:since}`
			params["since"] = since
		}
	default:
		orderBy = "c.created DESC"
	}
	return where, having, orderBy, params
}

func shoutCommunityPage(app core.App, f shoutCommunityFilter, limit, offset int) ([]shoutCommunityAgg, error) {
	where, having, orderBy, params := shoutCommunitySQL(f)
	params["lim"], params["off"] = limit, offset
	sql := `
		SELECT c.id AS id,
		       COUNT(m.id) AS msgs,
		       COALESCE(MAX(m.created), '') AS last_at,
		       COALESCE(json_array_length(NULLIF(c.likers, '')), 0) AS likes
		  FROM shoutbox_channels c
		  LEFT JOIN shoutbox_messages m ON m.channel = c.id
		 WHERE ` + where + `
		 GROUP BY c.id`
	if having != "" {
		sql += `
		HAVING ` + having
	}
	sql += `
		 ORDER BY ` + orderBy + `
		 LIMIT {:lim} OFFSET {:off}`

	out := []shoutCommunityAgg{}
	if err := app.DB().NewQuery(sql).Bind(params).All(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func shoutCommunityCount(app core.App, f shoutCommunityFilter) (int, error) {
	where, having, _, params := shoutCommunitySQL(f)
	delete(params, "lim")
	delete(params, "off")
	inner := `
		SELECT c.id
		  FROM shoutbox_channels c
		  LEFT JOIN shoutbox_messages m ON m.channel = c.id
		 WHERE ` + where + `
		 GROUP BY c.id`
	if having != "" {
		inner += `
		HAVING ` + having
	}
	var n struct {
		N int `db:"n"`
	}
	if err := app.DB().NewQuery(`SELECT COUNT(*) AS n FROM (` + inner + `)`).Bind(params).One(&n); err != nil {
		return 0, err
	}
	return n.N, nil
}

// Re-order by the page's aggs: FindRecordsByIds returns its own order.
func shoutCommunityFill(app core.App, aggs []shoutCommunityAgg, authID string) []shoutCommunityRoom {
	if len(aggs) == 0 {
		return []shoutCommunityRoom{}
	}
	ids := make([]string, 0, len(aggs))
	for _, a := range aggs {
		ids = append(ids, a.ID)
	}
	recs, err := app.FindRecordsByIds(shoutChannelsCol, ids)
	if err != nil {
		return []shoutCommunityRoom{}
	}
	byID := make(map[string]*core.Record, len(recs))
	for _, r := range recs {
		byID[r.Id] = r
	}
	out := make([]shoutCommunityRoom, 0, len(aggs))
	for _, a := range aggs {
		r, ok := byID[a.ID]
		if !ok {
			continue
		}
		out = append(out, shoutCommunityFromRecord(r, a, authID))
	}
	return out
}

// Ties broken by name, else equal-count reactions swap places on every refresh.
func shoutCommunityTopReacts(r *core.Record, authID string) []shoutCommunityReact {
	reactions := shoutReactionsField(r, "op_reactions")
	if len(reactions) == 0 {
		return nil
	}
	out := make([]shoutCommunityReact, 0, len(reactions))
	for name, uids := range reactions {
		if len(uids) == 0 {
			continue
		}
		mine := false
		if authID != "" {
			for _, u := range uids {
				if u == authID {
					mine = true
					break
				}
			}
		}
		out = append(out, shoutCommunityReact{Name: name, Count: len(uids), Mine: mine})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > shoutCommunityTopReactsMax {
		out = out[:shoutCommunityTopReactsMax]
	}
	return out
}

func shoutCommunityFromRecord(r *core.Record, a shoutCommunityAgg, authID string) shoutCommunityRoom {
	likers := r.GetStringSlice("likers")
	room := shoutCommunityRoom{
		ID:       r.Id,
		Slug:     r.GetString("slug"),
		Title:    r.GetString("title"),
		Desc:     r.GetString("description"),
		Owner:    r.GetString("owner"),
		Tags:     r.GetStringSlice("tags"),
		OpTop:    shoutCommunityTopReacts(r, authID),
		OpText:   r.GetString("op_text"),
		OpImages: shoutCommunityOpImages(r),
		Created:  r.GetDateTime("created").Time().Unix(),
		Msgs:     a.Msgs,
		Likes:    len(likers),
		Hidden:   !r.GetBool("enabled"),
		SitePin:  r.GetInt("site_pin"),
	}
	// author_ref is NEVER sent out — only compared with the caller.
	if room.Owner == "" && shoutCommunityAnonReady {
		if key := r.GetString("anon_key"); key != "" {
			room.Anon = true
			room.AnonKey = key
			room.Mask = r.GetString("anon_mask")
		}
	}
	if authID != "" && (room.Owner == authID ||
		(room.Anon && r.GetString("author_ref") == authID)) {
		room.Mine = true
	}
	if room.Tags == nil {
		room.Tags = []string{}
	}
	if len(room.OpImages) > 0 {
		room.OpImage = room.OpImages[0]
	}
	// Unparseable date → 0: a missing date is less harmful to a list than a 500.
	if a.LastAt != "" {
		if t, err := time.Parse("2006-01-02 15:04:05.000Z", a.LastAt); err == nil {
			room.LastAt = t.Unix()
		}
	}
	if authID != "" {
		for _, id := range likers {
			if id == authID {
				room.Liked = true
				break
			}
		}
	}
	return room
}

func shoutCommunityOwnerCards(app core.App, rooms []shoutCommunityRoom) map[string]map[string]any {
	ids := map[string]bool{}
	for _, r := range rooms {
		if r.Owner != "" {
			ids[r.Owner] = true
		}
	}
	if len(ids) == 0 {
		return nil
	}
	list := make([]string, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	recs, err := app.FindRecordsByIds("users", list)
	if err != nil {
		return nil
	}
	out := make(map[string]map[string]any, len(recs))
	for _, u := range recs {
		name := u.GetString("name")
		if name == "" {
			name = u.GetString("username")
		}
		out[u.Id] = map[string]any{"id": u.Id, "name": name, "avatar": u.GetString("avatar")}
	}
	return out
}

// "Where you posted recently": no topic subscriptions (topics are quick and disposable; nobody
// prunes subscription lists). An LRU by own posts instead.
const (
	shoutCommunityMineMax = 10
	shoutCommunityMineCap = 20
	// Cap on own recent messages scanned; without it the query groups a user's whole history
	// (thousands of rows for ten ids).
	shoutCommunityMineScan = 300
	shoutCommunityPostedN  = 30
	shoutCommunityMineTTL  = 60 * time.Second
)

type shoutCommunityMineRow struct {
	ID     string `db:"id"`
	MineAt string `db:"mine_at"`
}

// Relies on the (`user`, `created`) index in shoutbox_messages (PB/add_shoutbox_msg_user_index.py);
// without it this is a full table scan per topic-screen open.
func shoutCommunityMineIDs(app core.App, uid string, limit int) ([]string, error) {
	rows := []shoutCommunityMineRow{}
	sql := `
		SELECT channel AS id, MAX(created) AS mine_at
		  FROM (SELECT channel, created
		          FROM shoutbox_messages
		         WHERE user = {:u} AND channel != ''
		         ORDER BY created DESC
		         LIMIT {:scan})
		 GROUP BY channel
		 ORDER BY mine_at DESC
		 LIMIT {:lim}`
	params := dbx.Params{"u": uid, "scan": shoutCommunityMineScan, "lim": limit}
	if err := app.DB().NewQuery(sql).Bind(params).All(&rows); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out, nil
}

// Two caps: own topics are few, replies are everywhere — equal caps would drown your topics in
// others'.
const (
	shoutCommunityMineOwnN = 10
	shoutCommunityMineInN  = 20
)

func shoutCommunityOwnedIDs(app core.App, uid string, limit int) ([]string, error) {
	rows := []shoutCommunityMineRow{}
	sql := `
		SELECT c.id AS id, c.created AS mine_at
		  FROM shoutbox_channels c
		 WHERE ` + shoutCommunityWhereSQL + ` AND ` + shoutCommunityAuthorSQL + `
		 ORDER BY c.created DESC
		 LIMIT {:lim}`
	if err := app.DB().NewQuery(sql).Bind(dbx.Params{"u": uid, "lim": limit}).All(&rows); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out, nil
}

// "Mine" = topics I created AND topics I replied in (people lose the one they replied in last week,
// not their own).
func shoutCommunityMineSet(app core.App, uid string) ([]string, error) {
	own, err := shoutCommunityOwnedIDs(app, uid, shoutCommunityMineOwnN)
	if err != nil {
		return nil, err
	}
	in, err := shoutCommunityMineIDs(app, uid, shoutCommunityMineInN)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(own)+len(in))
	out := make([]string, 0, len(own)+len(in))
	for _, id := range append(own, in...) {
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

func shoutCommunityAggsByIDs(app core.App, ids []string) ([]shoutCommunityAgg, error) {
	if len(ids) == 0 {
		return []shoutCommunityAgg{}, nil
	}
	params := dbx.Params{}
	marks := make([]string, 0, len(ids))
	for i, id := range ids {
		key := fmt.Sprintf("id%d", i)
		params[key] = id
		marks = append(marks, "{:"+key+"}")
	}
	sql := `
		SELECT c.id AS id,
		       COUNT(m.id) AS msgs,
		       COALESCE(MAX(m.created), '') AS last_at,
		       COALESCE(json_array_length(NULLIF(c.likers, '')), 0) AS likes
		  FROM shoutbox_channels c
		  LEFT JOIN shoutbox_messages m ON m.channel = c.id
		 WHERE ` + shoutCommunityWhereSQL + `
		   AND c.id IN (` + strings.Join(marks, ", ") + `)
		 GROUP BY c.id
		 ORDER BY last_at DESC, c.created DESC`
	out := []shoutCommunityAgg{}
	if err := app.DB().NewQuery(sql).Bind(params).All(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// Personal cache in memory, not at the edge (response contains "I liked").
type shoutMineCache struct {
	mu   sync.Mutex
	data map[string]shoutMineEntry
}

type shoutMineEntry struct {
	at   time.Time
	body map[string]any
}

var shoutMine = &shoutMineCache{data: map[string]shoutMineEntry{}}

func (c *shoutMineCache) get(uid string) (map[string]any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.data[uid]
	if !ok || time.Since(e.at) > shoutCommunityMineTTL {
		return nil, false
	}
	return e.body, true
}

func (c *shoutMineCache) put(uid string, body map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.data) > 500 {
		for k, e := range c.data {
			if time.Since(e.at) > shoutCommunityMineTTL {
				delete(c.data, k)
			}
		}
		if len(c.data) > 500 {
			c.data = map[string]shoutMineEntry{}
		}
	}
	c.data[uid] = shoutMineEntry{at: time.Now(), body: body}
}

// Your own post must appear in the section immediately — forget() on write.
func (c *shoutMineCache) forget(uid string) {
	if uid == "" {
		return
	}
	c.mu.Lock()
	delete(c.data, uid)
	c.mu.Unlock()
}

func (c *shoutMineCache) reset() {
	c.mu.Lock()
	c.data = map[string]shoutMineEntry{}
	c.mu.Unlock()
}

// "New here" dots on topics: rooms are highlighted wholesale (a dozen, the ping carries all marks).
// Topics number thousands, so the FRONTEND names the ~20 it's drawing and the ping answers only for
// them.
const (
	// The frontend must name topics in BOTH places dots appear (side column + index page); an unnamed
	// topic gets silence, which the frontend reads as "nothing new".
	shoutWatchMax = 48
	shoutWatchTTL = 5 * time.Minute
)

type shoutWatchGate struct {
	mu   sync.Mutex
	seen map[string]shoutWatchVerdict
}

type shoutWatchVerdict struct {
	at time.Time
	ok bool
}

var shoutWatch = &shoutWatchGate{seen: map[string]shoutWatchVerdict{}}

func (g *shoutWatchGate) filter(app core.App, ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	if len(ids) > shoutWatchMax {
		ids = ids[:shoutWatchMax]
	}
	now := time.Now()
	var ask []string
	verdict := make(map[string]bool, len(ids))

	g.mu.Lock()
	if len(g.seen) > 4000 {
		for k, v := range g.seen {
			if now.Sub(v.at) > shoutWatchTTL {
				delete(g.seen, k)
			}
		}
	}
	for _, id := range ids {
		if v, ok := g.seen[id]; ok && now.Sub(v.at) <= shoutWatchTTL {
			verdict[id] = v.ok
			continue
		}
		ask = append(ask, id)
	}
	g.mu.Unlock()

	if len(ask) > 0 {
		good := map[string]bool{}
		if recs, err := app.FindRecordsByIds(shoutChannelsCol, ask); err == nil {
			for _, r := range recs {
				if r.GetBool("enabled") && !r.GetBool("is_private") &&
					!r.GetBool("is_dm") && shoutCommunityIsThread(r) {
					good[r.Id] = true
				}
			}
		}
		g.mu.Lock()
		for _, id := range ask {
			// Cache refusals too, or probing foreign ids hits the DB every ping.
			g.seen[id] = shoutWatchVerdict{at: now, ok: good[id]}
			verdict[id] = good[id]
		}
		g.mu.Unlock()
	}

	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if verdict[id] {
			out = append(out, id)
		}
	}
	return out
}

// op_image may come as a string (maxSelect 1) or a list (records from before the schema edit) —
// handle both. shoutCommunityMulti checks the collection schema (op_images present?), not values.
func shoutCommunityMulti(r *core.Record) bool {
	coll := r.Collection()
	return coll != nil && coll.Fields.GetByName("op_images") != nil
}

// Until the author adds site_pin by hand (PB/add_shoutbox_site_pin.py), PB silently drops writes to
// it — the whole site-pin feature must collapse to "doesn't exist". Chat must work before that.
func shoutCommunitySitePinOn(app core.App) bool {
	coll, err := app.FindCollectionByNameOrId(shoutChannelsCol)
	return err == nil && coll != nil && coll.Fields.GetByName("site_pin") != nil
}

// A number, not a checkbox: its value is the display order (higher = first).
func shoutCommunitySitePinIDs(app core.App) []string {
	if !shoutCommunitySitePinOn(app) {
		return nil
	}
	type row struct {
		ID string `db:"id"`
	}
	out := []row{}
	sql := `
		SELECT c.id AS id
		  FROM shoutbox_channels c
		 WHERE ` + shoutCommunityWhereSQL + `
		   AND COALESCE(c.site_pin, 0) > 0
		 ORDER BY c.site_pin DESC, c.created DESC
		 LIMIT {:lim}`
	if err := app.DB().NewQuery(sql).Bind(dbx.Params{"lim": shoutCommunitySitePinsMax}).All(&out); err != nil {
		return nil
	}
	ids := make([]string, 0, len(out))
	for _, r := range out {
		ids = append(ids, r.ID)
	}
	return ids
}

func shoutCommunitySitePinned(app core.App, authID string) []shoutCommunityRoom {
	ids := shoutCommunitySitePinIDs(app)
	if len(ids) == 0 {
		return []shoutCommunityRoom{}
	}
	aggs, err := shoutCommunityAggsByIDs(app, ids)
	if err != nil {
		return []shoutCommunityRoom{}
	}
	// Site-pin order is set by hand; don't re-sort by freshness.
	pos := make(map[string]int, len(ids))
	for i, id := range ids {
		pos[id] = i
	}
	sort.SliceStable(aggs, func(i, j int) bool { return pos[aggs[i].ID] < pos[aggs[j].ID] })
	return shoutCommunityFill(app, aggs, authID)
}

// Fallback to the old single op_image field: every topic from before the schema edit stores its
// image only there.
func shoutCommunityOpImages(r *core.Record) []string {
	if list := r.GetStringSlice("op_images"); len(list) > 0 {
		return list
	}
	if one := shoutCommunityOpImageName(r); one != "" {
		return []string{one}
	}
	return []string{}
}

func shoutCommunityOpImageName(r *core.Record) string {
	if v := r.GetString("op_image"); v != "" {
		return v
	}
	if list := r.GetStringSlice("op_image"); len(list) > 0 {
		return list[0]
	}
	return ""
}

func shoutCommunityPreview(op string) string {
	// Image markers stay out of the list preview ("[img2]" mid-sentence).
	flat := strings.Join(strings.Fields(shoutCommunityImgToken.ReplaceAllString(op, " ")), " ")
	if utf8.RuneCountInString(flat) <= shoutCommunityDescMax {
		return flat
	}
	runes := []rune(flat)
	return strings.TrimSpace(string(runes[:shoutCommunityDescMax-1])) + "…"
}

// `[img1]`…`[img5]` = position in the image list, not filename (names change on re-upload).
var shoutCommunityImgToken = regexp.MustCompile(`\[img[1-9][0-9]?\]`)

func shoutCommunityFormImage(c *core.RequestEvent, field string) (*filesystem.File, error) {
	fh, _, err := c.Request.FormFile(field)
	if err != nil {
		return nil, nil
	}
	defer fh.Close()

	hdrs := c.Request.MultipartForm.File[field]
	if len(hdrs) == 0 {
		return nil, nil
	}
	h := hdrs[0]
	if h.Size > shoutImageMaxBytes {
		return nil, apis.NewBadRequestError("Image is too big (max 8 MB).", nil)
	}
	if !shoutImageMIME[h.Header.Get("Content-Type")] {
		return nil, apis.NewBadRequestError("Only JPEG, PNG, GIF or WebP images.", nil)
	}
	f, err := filesystem.NewFileFromMultipart(h)
	if err != nil {
		return nil, apis.NewBadRequestError("Can't read the image", err)
	}
	return f, nil
}

func shoutCommunityFormImages(c *core.RequestEvent, field string) ([]*filesystem.File, error) {
	if c.Request.MultipartForm == nil {
		return nil, nil
	}
	hdrs := c.Request.MultipartForm.File[field]
	if len(hdrs) > shoutCommunityOpImagesMax {
		return nil, apis.NewBadRequestError("Too many images (max 5).", nil)
	}
	out := make([]*filesystem.File, 0, len(hdrs))
	for _, h := range hdrs {
		if h.Size > shoutImageMaxBytes {
			return nil, apis.NewBadRequestError("Image is too big (max 8 MB).", nil)
		}
		if !shoutImageMIME[h.Header.Get("Content-Type")] {
			return nil, apis.NewBadRequestError("Only JPEG, PNG, GIF or WebP images.", nil)
		}
		f, err := filesystem.NewFileFromMultipart(h)
		if err != nil {
			return nil, apis.NewBadRequestError("Can't read the image", err)
		}
		out = append(out, f)
	}
	return out, nil
}

// Moving an old topic image from op_image to op_images needs a NEW file: the same file referenced
// by two fields gets deleted by PB when removed from either.
func shoutCommunityCloneFile(app core.App, rec *core.Record, name string) (*filesystem.File, error) {
	fsys, err := app.NewFilesystem()
	if err != nil {
		return nil, err
	}
	defer fsys.Close()
	r, err := fsys.GetReader(rec.BaseFilesPath() + "/" + name)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	b, err := io.ReadAll(io.LimitReader(r, shoutImageMaxBytes+1))
	if err != nil {
		return nil, err
	}
	// Keep the original name: its prefix carries image size (640x480_…) used by the frontend to
	// reserve space; PB appends its own random suffix.
	return filesystem.NewFileFromBytes(b, name)
}

// Cap the WHOLE body before parsing (ParseMultipartForm limits memory only, not disk; see
// shoutReadPostInput).
func shoutCommunityParseForm(c *core.RequestEvent) error {
	ceiling := int64(shoutImageMaxBytes)*shoutCommunityOpImagesMax + (1 << 20)
	c.Request.Body = http.MaxBytesReader(c.Response, c.Request.Body, ceiling)
	if err := c.Request.ParseMultipartForm(ceiling); err != nil {
		return apis.NewBadRequestError("Invalid form", err)
	}
	return nil
}

func shoutCommunityFormTags(c *core.RequestEvent) []string {
	out := []string{}
	for _, v := range c.Request.Form["tags"] {
		for _, part := range strings.Split(v, ",") {
			if t := strings.TrimSpace(part); t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

type shoutCommunityOpInput struct {
	Room  string
	Title string
	Tags  []string
	Text  string
	Image *filesystem.File
	// Separate remove flag: "field absent" and "remove the image" are different intents.
	DropImage bool

	Images []*filesystem.File
	Order  []string
	// Order set = Order is the ENTIRE future list; absent items leave. Without the flag, "field
	// absent" and "remove all" would look the same.
	ImagesSet bool

	// Anonymity only at CREATION: a published topic was read with the author's name; hiding it
	// retroactively is a promise we can't keep.
	Anon bool
	Mask string
}

func shoutCommunityReadOp(c *core.RequestEvent) (shoutCommunityOpInput, error) {
	var in shoutCommunityOpInput
	if !strings.HasPrefix(c.Request.Header.Get("Content-Type"), "multipart/form-data") {
		var p struct {
			Room      string   `json:"room"`
			Title     string   `json:"title"`
			Tags      []string `json:"tags"`
			OpText    string   `json:"op_text"`
			DropImage bool     `json:"drop_image"`
			OpOrder   []string `json:"op_order"`
			ImagesSet bool     `json:"op_images_set"`
			Anon      bool     `json:"anon"`
			Mask      string   `json:"mask"`
		}
		if err := c.BindBody(&p); err != nil {
			return in, apis.NewBadRequestError("Bad request", err)
		}
		in.Room, in.Title, in.Tags = p.Room, p.Title, p.Tags
		in.Text, in.DropImage = p.OpText, p.DropImage
		in.Order, in.ImagesSet = p.OpOrder, p.ImagesSet
		in.Anon, in.Mask = p.Anon, p.Mask
		return in, nil
	}
	if err := shoutCommunityParseForm(c); err != nil {
		return in, err
	}
	in.Room = c.Request.FormValue("room")
	in.Title = c.Request.FormValue("title")
	in.Tags = shoutCommunityFormTags(c)
	in.Text = c.Request.FormValue("op_text")
	in.DropImage = c.Request.FormValue("drop_image") == "1"
	in.Anon = c.Request.FormValue("anon") == "1"
	in.Mask = c.Request.FormValue("mask")
	img, err := shoutCommunityFormImage(c, "op_image")
	if err != nil {
		return in, err
	}
	in.Image = img
	imgs, err := shoutCommunityFormImages(c, "op_images_new")
	if err != nil {
		return in, err
	}
	in.Images = imgs
	in.ImagesSet = c.Request.FormValue("op_images_set") == "1"
	for _, v := range c.Request.Form["op_order"] {
		for _, part := range strings.Split(v, ",") {
			if t := strings.TrimSpace(part); t != "" {
				in.Order = append(in.Order, t)
			}
		}
	}
	return in, nil
}

func shoutCommunityApplyOp(app core.App, rec *core.Record, in shoutCommunityOpInput) error {
	text := strings.TrimSpace(in.Text)
	if utf8.RuneCountInString(text) > shoutCommunityOpMax {
		return apis.NewBadRequestError("The opening post is too long.", nil)
	}
	rec.Set("op_text", text)
	rec.Set("description", shoutCommunityPreview(text))
	return shoutCommunityApplyImages(app, rec, in)
}

// Contract is "whole list", not add/remove: images are placed by [imgN] markers and partial edits
// desync from the text on the first two-tab race.
func shoutCommunityApplyImages(app core.App, rec *core.Record, in shoutCommunityOpInput) error {
	legacy := shoutCommunityOpImageName(rec)

	if !shoutCommunityMulti(rec) {
		switch {
		case len(in.Images) > 0:
			rec.Set("op_image", in.Images[0])
		case in.Image != nil:
			rec.Set("op_image", in.Image)
		case in.DropImage:
			rec.Set("op_image", nil)
		}
		return nil
	}

	cur := rec.GetStringSlice("op_images")

	if !in.ImagesSet {
		// Old shipped frontend knows one image and sends no order: touch only position 1, or a text edit
		// in an old tab deletes images it can't see.
		one := in.Image
		if one == nil && len(in.Images) > 0 {
			one = in.Images[0]
		}
		switch {
		case one != nil:
			rest := cur
			if len(rest) > 0 {
				rest = rest[1:]
			}
			next := make([]any, 0, len(rest)+1)
			next = append(next, one)
			for _, n := range rest {
				if len(next) >= shoutCommunityOpImagesMax {
					break
				}
				next = append(next, n)
			}
			rec.Set("op_images", next)
		case in.DropImage:
			if len(cur) > 0 {
				rest := make([]any, 0, len(cur)-1)
				for _, n := range cur[1:] {
					rest = append(rest, n)
				}
				rec.Set("op_images", rest)
			}
		default:
			return nil
		}
		if legacy != "" {
			rec.Set("op_image", nil)
		}
		return nil
	}

	known := make(map[string]bool, len(cur))
	for _, n := range cur {
		known[n] = true
	}
	next := make([]any, 0, shoutCommunityOpImagesMax)
	used := 0
	for _, tok := range in.Order {
		if len(next) >= shoutCommunityOpImagesMax {
			break
		}
		switch {
		case tok == "*":
			if used < len(in.Images) {
				next = append(next, in.Images[used])
				used++
			}
		case known[tok]:
			next = append(next, tok)
		case tok == legacy && legacy != "":
			f, err := shoutCommunityCloneFile(app, rec, legacy)
			if err != nil {
				return apis.NewInternalServerError("Can't move the image", err)
			}
			next = append(next, f)
		}
	}
	// Files not mentioned in the order go to the end: losing a just-uploaded image to a form desync is
	// the worst outcome.
	for ; used < len(in.Images) && len(next) < shoutCommunityOpImagesMax; used++ {
		next = append(next, in.Images[used])
	}
	rec.Set("op_images", next)
	if legacy != "" {
		rec.Set("op_image", nil)
	}
	return nil
}

func shoutCommunityAggOne(app core.App, id string) shoutCommunityAgg {
	agg := shoutCommunityAgg{ID: id}
	var row struct {
		Msgs   int    `db:"msgs"`
		LastAt string `db:"last_at"`
	}
	err := app.DB().NewQuery(`
		SELECT COUNT(id) AS msgs, COALESCE(MAX(created), '') AS last_at
		  FROM shoutbox_messages WHERE channel = {:id}`).
		Bind(dbx.Params{"id": id}).One(&row)
	if err == nil {
		agg.Msgs, agg.LastAt = row.Msgs, row.LastAt
	}
	return agg
}

// Find by id OR slug: the topic list uses ids, the chat feed uses slugs (shoutResolveChannel); a
// handler knowing only one misses on direct links (happened once).
func shoutCommunityFindPublic(app core.App, key string) *core.Record {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	rec, err := app.FindRecordById(shoutChannelsCol, key)
	if err != nil || rec == nil {
		rec, err = app.FindFirstRecordByFilter(shoutChannelsCol, "slug = {:s}",
			dbx.Params{"s": strings.ToLower(key)})
		if err != nil || rec == nil {
			return nil
		}
	}
	// DMs and private rooms are never reachable via these handlers ("read the header" would leak their
	// name/description). Author rooms are allowed (see shoutCommunityFindPublic).
	if rec.GetBool("is_dm") || rec.GetBool("is_private") {
		return nil
	}
	return rec
}

// STRICTLY user topics (owner != ""): likes, moderation, site pins — where an author room makes no
// sense or is dangerous.
func shoutCommunityFind(app core.App, key string) *core.Record {
	rec := shoutCommunityFindPublic(app, key)
	if rec == nil || !shoutCommunityIsThread(rec) {
		return nil
	}
	return rec
}

// Moderator may edit because the opening post is seen by everyone.
func shoutCommunityCanEditOp(c *core.RequestEvent, rec *core.Record) bool {
	if c.Auth == nil {
		return false
	}
	if o := rec.GetString("owner"); o != "" && o == c.Auth.Id {
		return true
	}
	// Anonymous topic: owner empty, authorship only via hidden author_ref — without this branch the
	// author couldn't fix a typo.
	if shoutCommunityAnonReady && rec.GetString("owner") == "" &&
		rec.GetString("author_ref") != "" && rec.GetString("author_ref") == c.Auth.Id {
		return true
	}
	if c.Auth.Collection() != nil && c.Auth.Collection().Name == core.CollectionNameSuperusers {
		return true
	}
	// Chat moderator specifically (mod_perms.go capabilities): a moderator assigned to game cards may
	// not edit others' topics; plain isModerator bypassed that split.
	return hasPerm(c, permChat)
}

func shoutCommunityCleanTags(in []string) ([]string, string) {
	seen := map[string]bool{}
	rating := ""
	extra := []string{}
	for _, raw := range in {
		t := strings.ToLower(strings.TrimSpace(raw))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		switch {
		case shoutCommunityRating[t]:
			if rating != "" && rating != t {
				return nil, "Pick either SFW or NSFW, not both."
			}
			rating = t
		case shoutCommunityExtra[t]:
			extra = append(extra, t)
		default:
			return nil, "Unknown tag: " + t
		}
	}
	if rating == "" {
		return nil, "Mark the room as SFW or NSFW."
	}
	if len(extra) > shoutCommunityTagsMax-1 {
		return nil, "Too many tags."
	}
	// Content tag first, rest alphabetical, so color stripes stay recognizable.
	sort.Strings(extra)
	return append([]string{rating}, extra...), ""
}

func registerShoutboxCommunity(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	shoutCommunityEnsureTitleMax(app)
	shoutCommunityInitAnon(app)

	// Side-column list cache is shared (identical for everyone; no "liked" there). 15s so opening chat
	// in three tabs costs one query.
	g.GET("/community/side", func(c *core.RequestEvent) error {
		c.Response.Header().Set("Cache-Control", "public, max-age=15")
		// By CREATION date, not last reply: the column is "what's new" and mustn't jump on every reply to
		// an old topic. No freshness window — a quiet week must still show something.
		aggs, err := shoutCommunityPage(app,
			shoutCommunityFilter{Order: "new"}, shoutCommunitySideMax, 0)
		if err != nil {
			// Missing tags/likers fields (schema not applied) = "no topics", not an error; production chat
			// must not fail.
			return c.JSON(http.StatusOK, map[string]any{"rooms": []shoutCommunityRoom{}})
		}
		rooms := shoutCommunityFill(app, aggs, "")
		return c.JSON(http.StatusOK, map[string]any{"rooms": rooms})
	})

	// Pins + "where you posted" in ONE handler: drawn as one block; two requests would show two
	// moments in time (different reply counts for the same topic).
	g.GET("/community/mine", func(c *core.RequestEvent) error {
		c.Response.Header().Set("Cache-Control", "private, no-store")
		uid := c.Auth.Id
		limit := shoutCommunityMineMax
		if n, err := strconv.Atoi(c.Request.URL.Query().Get("limit")); err == nil && n > 0 {
			limit = min(n, shoutCommunityMineCap)
		}
		cacheable := limit == shoutCommunityMineMax
		if cacheable {
			if body, ok := shoutMine.get(uid); ok {
				return c.JSON(http.StatusOK, body)
			}
		}

		// Pins come from shared state (same as pinned DMs); non-topic ids are dropped by the query
		// itself.
		st := shoutStateOf(app, uid)
		pinIDs := make([]string, 0, len(st.Pins))
		pinIDs = append(pinIDs, st.Pins...)
		pinAggs, err := shoutCommunityAggsByIDs(app, pinIDs)
		if err != nil {
			return c.InternalServerError("Failed to load pinned threads", err)
		}
		// Pins keep the user's drag order.
		pinPos := make(map[string]int, len(pinIDs))
		for i, id := range pinIDs {
			pinPos[id] = i
		}
		sort.SliceStable(pinAggs, func(i, j int) bool {
			return pinPos[pinAggs[i].ID] < pinPos[pinAggs[j].ID]
		})
		if len(pinAggs) > shoutCommunityPinsMax {
			pinAggs = pinAggs[:shoutCommunityPinsMax]
		}
		pinned := map[string]bool{}
		for _, a := range pinAggs {
			pinned[a.ID] = true
		}

		mineIDs, err := shoutCommunityMineIDs(app, uid, max(limit+len(pinAggs), shoutCommunityPostedN))
		if err != nil {
			return c.InternalServerError("Failed to load recent threads", err)
		}
		mineAggs, err := shoutCommunityAggsByIDs(app, mineIDs)
		if err != nil {
			return c.InternalServerError("Failed to load recent threads", err)
		}
		recent := make([]shoutCommunityAgg, 0, limit)
		for _, a := range mineAggs {
			if pinned[a.ID] || len(recent) >= limit {
				continue
			}
			recent = append(recent, a)
		}

		// The personal "I posted here" flag can't go into /community/list: that response is identical for
		// all and edge-cached; one personal byte would kill the cache.
		posted := mineIDs
		if len(posted) > shoutCommunityPostedN {
			posted = posted[:shoutCommunityPostedN]
		}

		body := map[string]any{
			"pins":   shoutCommunityFill(app, pinAggs, uid),
			"recent": shoutCommunityFill(app, recent, uid),
			"posted": posted,
		}
		if cacheable {
			shoutMine.put(uid, body)
		}
		return c.JSON(http.StatusOK, body)
	}).Bind(apis.RequireAuth())

	// Site pins are a separate handler (needed by guests; /community/mine is auth-only). Personal
	// `liked` field → not edge-cached.
	g.GET("/community/pinned", func(c *core.RequestEvent) error {
		c.Response.Header().Set("Cache-Control", "private, no-store")
		authID := ""
		if c.Auth != nil {
			authID = c.Auth.Id
		}
		rooms := shoutCommunitySitePinned(app, authID)
		out := map[string]any{
			"rooms":   rooms,
			"enabled": shoutCommunitySitePinOn(app),
		}
		if cards := shoutCommunityOwnerCards(app, rooms); len(cards) > 0 {
			out["users"] = cards
		}
		return c.JSON(http.StatusOK, out)
	})

	g.GET("/community/list", func(c *core.RequestEvent) error {
		c.Response.Header().Set("Cache-Control", "private, no-store")
		authID := ""
		if c.Auth != nil {
			authID = c.Auth.Id
		}
		q := c.Request.URL.Query()
		page, _ := strconv.Atoi(q.Get("page"))
		if page < 1 {
			page = 1
		}
		per, _ := strconv.Atoi(q.Get("per"))
		if per < 1 {
			per = shoutCommunityPerPage
		}
		if per > shoutCommunityPerMax {
			per = shoutCommunityPerMax
		}
		// nsfw filtering on the server: client-side removal left holes (30 per page became random).
		rating := strings.ToLower(strings.TrimSpace(q.Get("rating")))
		if rating != "sfw" && rating != "nsfw" {
			rating = ""
		}
		// Fallback for old frontends that only send hide=nsfw.
		if rating == "" && q.Get("hide") == "nsfw" {
			rating = "sfw"
		}

		// Length-capped (goes into LIKE); single-letter search rejected (matches everything, looks
		// broken).
		needle := strings.TrimSpace(q.Get("q"))
		if utf8.RuneCountInString(needle) < 2 {
			needle = ""
		}
		if utf8.RuneCountInString(needle) > shoutCommunityTitleMax {
			needle = string([]rune(needle)[:shoutCommunityTitleMax])
		}
		f := shoutCommunityFilter{
			Order:  q.Get("sort"),
			Tag:    strings.ToLower(strings.TrimSpace(q.Get("tag"))),
			Rating: rating,
			Q:      needle,
		}
		if authID != "" && q.Get("mine") == "1" {
			ids, err := shoutCommunityMineSet(app, authID)
			if err != nil {
				return c.InternalServerError("Failed to load your threads", err)
			}
			// Assign even when empty: nil IDs means "no restriction" — an empty answer would become "show
			// all".
			f.IDs = ids
		}
		switch f.Order {
		case "active":
			f.Window = shoutCommunityActiveWindow
		case "top":
			f.Window = shoutCommunitySpan(q.Get("span"))
		}
		// Searching drops the activity window: the window guards the FEED against necrobumping, but
		// search is exactly "find that old topic"; silent omission reads as "doesn't exist".
		if f.Q != "" {
			f.Window = 0
		}

		total, err := shoutCommunityCount(app, f)
		if err != nil {
			return c.InternalServerError("Failed to load threads", err)
		}
		aggs, err := shoutCommunityPage(app, f, per, (page-1)*per)
		if err != nil {
			return c.InternalServerError("Failed to load threads", err)
		}
		rooms := shoutCommunityFill(app, aggs, authID)
		out := map[string]any{"rooms": rooms, "page": page, "per": per, "total": total}
		if cards := shoutCommunityOwnerCards(app, rooms); len(cards) > 0 {
			out["users"] = cards
		}
		return c.JSON(http.StatusOK, out)
	})

	g.POST("/community/rooms", func(c *core.RequestEvent) error {
		in, err := shoutCommunityReadOp(c)
		if err != nil {
			return err
		}
		// Muted users are fully silent: otherwise a mute is bypassed by creating a topic whose header
		// everyone sees.
		authID := ""
		if c.Auth != nil {
			authID = c.Auth.Id
		}
		anonKey := shoutAnonKey(requestIP(c.Request))
		if authID == "" {
			in.Anon = true
			if !shoutCommunityAnonReady {
				return c.InternalServerError("Anonymous threads are not available yet", nil)
			}
			if in.Image != nil || len(in.Images) > 0 {
				return c.BadRequestError("Sign in to attach images to a thread.", nil)
			}
		}
		if authID != "" && shoutMutedUser(authID) {
			return c.ForbiddenError("You are muted.", nil)
		}
		title := strings.TrimSpace(in.Title)
		if n := utf8.RuneCountInString(title); n < 3 || n > shoutCommunityTitleMax {
			return c.BadRequestError(fmt.Sprintf("Title must be 3–%d characters.", shoutCommunityTitleMax), nil)
		}
		tags, why := shoutCommunityCleanTags(in.Tags)
		if why != "" {
			return c.BadRequestError(why, nil)
		}

		// Daily quota counted from the DB, not memory (24h window; a restart must not hand out fresh
		// quotas).
		since := time.Now().Add(-24 * time.Hour).UTC().Format("2006-01-02 15:04:05.000Z")
		// Anonymous topics count toward the same quota (a mask isn't a second set of rights).
		quota := "anon_key = {:u} && owner = '' && author_ref = '' && is_dm = false && is_private = false && created >= {:since}"
		quotaID := anonKey
		if authID != "" {
			quota = "owner = {:u} && is_dm = false && is_private = false && created >= {:since}"
			if shoutCommunityAnonReady {
				quota = "(owner = {:u} || author_ref = {:u}) && is_dm = false && is_private = false && created >= {:since}"
			}
			quotaID = authID
		}
		mine, qerr := app.FindRecordsByFilter(shoutChannelsCol, quota,
			"", shoutCommunityPerDay+1, 0,
			dbx.Params{"u": quotaID, "since": since})
		// Can't count → don't create. A read error used to mean "unlimited" — crashing this query was the
		// way around the limit.
		if qerr != nil {
			return c.InternalServerError("Failed to check your daily limit", qerr)
		}
		if len(mine) >= shoutCommunityPerDay {
			return c.BadRequestError(fmt.Sprintf(
				"You've created %d threads today. Try again tomorrow.",
				shoutCommunityPerDay), nil)
		}

		coll, cerr := app.FindCollectionByNameOrId(shoutChannelsCol)
		if cerr != nil {
			return c.InternalServerError("Channels storage missing", cerr)
		}
		rec := core.NewRecord(coll)
		// "c-" prefix so topic URLs can't be confused with author rooms ("general") or private rooms
		// ("room-…"). Random, not from the title (people can type anyone's title).
		rec.Set("slug", "c-"+security.RandomStringWithAlphabet(16, "abcdefghijklmnopqrstuvwxyz0123456789"))
		rec.Set("title", title)
		rec.Set("tags", tags)
		if err := shoutCommunityApplyOp(app, rec, in); err != nil {
			return err
		}
		// sort between pinned rooms (10..100) and private rooms (500): unused by the topic list, but the
		// chat menu and admin sort by it.
		rec.Set("sort", 300)
		rec.Set("enabled", true)
		rec.Set("is_private", false)
		rec.Set("is_dm", false)
		rec.Set("owner", authID)
		// Anonymous topic: NO author in the record at all (real one in hidden author_ref); reader sees
		// anon_key (same as this IP's messages) + mask. "Not stored", not "hidden in our response": the
		// browser reads channel records directly from PB via subscription, so masking only our own
		// response would leak.
		if in.Anon {
			if !shoutCommunityAnonReady {
				return c.InternalServerError("Anonymous threads are not available yet", nil)
			}
			rec.Set("owner", "")
			if authID != "" {
				rec.Set("author_ref", authID)
			}
			rec.Set("anon_key", anonKey)
			if err := shoutApplyAnonMask(rec, in.Mask); err != nil {
				return apis.NewBadRequestError(err.Error(), nil)
			}
		}
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to create room", err)
		}
		// Creating a topic is itself "new here": highlights are computed from last message time, a new
		// topic has none (the OP lives on the room record), so without this the dot waited for the first
		// reply.
		shoutChans.noteMessage(rec.Id)
		return c.JSON(http.StatusOK, map[string]any{
			"room": shoutCommunityFromRecord(rec, shoutCommunityAgg{ID: rec.Id}, authID),
		})
	})

	g.GET("/community/room", func(c *core.RequestEvent) error {
		c.Response.Header().Set("Cache-Control", "private, no-store")
		authID := ""
		if c.Auth != nil {
			authID = c.Auth.Id
		}
		// Author rooms have headers too: #general used to show no description at all.
		rec := shoutCommunityFindPublic(app, c.Request.URL.Query().Get("room"))
		if rec == nil {
			return c.NotFoundError("Unknown room", nil)
		}
		// Hidden topic doesn't exist for readers; a moderator with `chat` sees it (hide without restore =
		// deletion).
		if !rec.GetBool("enabled") && !hasPerm(c, permChat) {
			return c.NotFoundError("Unknown room", nil)
		}
		room := shoutCommunityFromRecord(rec, shoutCommunityAggOne(app, rec.Id), authID)
		room.OpReactions = shoutReactionsField(rec, "op_reactions")
		out := map[string]any{"room": room}
		if cards := shoutCommunityOwnerCards(app, []shoutCommunityRoom{room}); len(cards) > 0 {
			out["users"] = cards
		}
		return c.JSON(http.StatusOK, out)
	})

	// Only text and images editable: title and tags are fixed after creation — people found and linked
	// the topic by them; a swapped title turns links into bait.
	g.POST("/community/op", func(c *core.RequestEvent) error {
		in, err := shoutCommunityReadOp(c)
		if err != nil {
			return err
		}
		key := in.Room
		if key == "" {
			key = c.Request.URL.Query().Get("room")
		}
		rec := shoutCommunityFindPublic(app, key)
		if rec == nil {
			return c.NotFoundError("Unknown room", nil)
		}
		if !shoutCommunityCanEditOp(c, rec) {
			return c.ForbiddenError("Not your topic.", nil)
		}
		// Muted users can't rewrite their topic header either (else they'd post what got them muted).
		if shoutMutedUser(c.Auth.Id) {
			return c.ForbiddenError("You are muted.", nil)
		}
		if err := shoutCommunityApplyOp(app, rec, in); err != nil {
			return err
		}
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to save", err)
		}
		return c.JSON(http.StatusOK, map[string]any{
			"room": shoutCommunityFromRecord(rec, shoutCommunityAggOne(app, rec.Id), c.Auth.Id),
		})
	}).Bind(apis.RequireAuth())

	// Topic moderation (title/tags edit, hide/restore) — deliberately not given to topic authors (see
	// /community/op); moderators use it to fix bait titles and wrong tags (rating first).
	type modRoomPayload struct {
		Room  string   `json:"room"`
		Title string   `json:"title"`
		Tags  []string `json:"tags"`
		// Pointer, not bool: "not sent" ≠ "sent false"; a title-only edit must not silently unhide.
		Hidden  *bool `json:"hidden"`
		SitePin *int  `json:"site_pin"`
	}
	g.POST("/community/moderate", func(c *core.RequestEvent) error {
		// `chat` permission, not the moderator flag (see shoutCommunityCanEditOp). hasPerm also covers
		// superuser and unauthenticated (c.Auth == nil used to crash the handler here).
		if !hasPerm(c, permChat) {
			return c.ForbiddenError("You don't have the \"chat\" moderator permission.", nil)
		}
		var p modRoomPayload
		if err := c.BindBody(&p); err != nil {
			return c.BadRequestError("Bad request", err)
		}
		rec := shoutCommunityFind(app, strings.TrimSpace(p.Room))
		if rec == nil {
			return c.NotFoundError("Unknown room", nil)
		}
		// User topics only; author rooms live in the rooms admin with their own rules and cap.
		if !shoutCommunityIsThread(rec) || rec.GetBool("is_dm") || rec.GetBool("is_private") {
			return c.BadRequestError("Not a thread.", nil)
		}
		before := modSnapshot(rec, "title", "tags", "enabled", "site_pin")

		if t := strings.TrimSpace(p.Title); t != "" {
			if n := utf8.RuneCountInString(t); n < 3 || n > shoutCommunityTitleMax {
				return c.BadRequestError(fmt.Sprintf("Title must be 3–%d characters.", shoutCommunityTitleMax), nil)
			}
			rec.Set("title", t)
		}
		// Empty tag set = "don't touch": the rating tag is mandatory.
		if len(p.Tags) > 0 {
			tags, why := shoutCommunityCleanTags(p.Tags)
			if why != "" {
				return c.BadRequestError(why, nil)
			}
			rec.Set("tags", tags)
		}
		if p.Hidden != nil {
			rec.Set("enabled", !*p.Hidden)
		}
		if p.SitePin != nil {
			if !shoutCommunitySitePinOn(app) {
				return c.BadRequestError("Site pins are not enabled yet.", nil)
			}
			v := *p.SitePin
			if v < 0 {
				v = 0
			}
			// Cap checked BEFORE writing, excluding this topic: re-weighting an existing pin must always
			// work; a fourth pin must not.
			if v > 0 && rec.GetInt("site_pin") == 0 {
				if len(shoutCommunitySitePinIDs(app)) >= shoutCommunitySitePinsMax {
					return c.BadRequestError(
						fmt.Sprintf("All %d site pins are taken.", shoutCommunitySitePinsMax), nil)
				}
			}
			rec.Set("site_pin", v)
		}
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to save", err)
		}
		// A hidden topic must leave "where you posted" immediately — that cache doesn't know about it.
		if p.Hidden != nil {
			shoutMine.reset()
		}
		logModAction(app, c, modAction{
			Action:     "chat_thread_moderate",
			Target:     rec.Id,
			Before:     before,
			After:      modSnapshot(rec, "title", "tags", "enabled", "site_pin"),
			Reversible: true,
			Note:       rec.GetString("slug"),
		})
		return c.JSON(http.StatusOK, map[string]any{
			"room": shoutCommunityFromRecord(rec, shoutCommunityAggOne(app, rec.Id), c.Auth.Id),
		})
	}).Bind(apis.RequireAuth())

	// Like is a toggle: one button, one request (two requests per click desync when one fails).
	type likePayload struct {
		Room string `json:"room"`
	}
	g.POST("/community/like", func(c *core.RequestEvent) error {
		var p likePayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.Room) == "" {
			return c.BadRequestError("Missing room", err)
		}
		if shoutMutedUser(c.Auth.Id) {
			return c.ForbiddenError("You are muted.", nil)
		}
		// Same lock as reactions: read-modify-write of the likers array loses one of two concurrent
		// likes. Take the lock BEFORE reading.
		shoutReactMu.Lock()
		defer shoutReactMu.Unlock()

		rec, err := app.FindRecordById(shoutChannelsCol, strings.TrimSpace(p.Room))
		if err != nil {
			return c.NotFoundError("Unknown room", err)
		}
		// Likes only on user topics: otherwise this accepted a pinned room id or a DM id — letting you
		// write yourself into someone's private conversation record.
		if rec.GetBool("is_dm") || rec.GetBool("is_private") || !shoutCommunityIsThread(rec) {
			return c.NotFoundError("Unknown room", nil)
		}

		likers := rec.GetStringSlice("likers")
		kept := make([]string, 0, len(likers)+1)
		liked := false
		for _, id := range likers {
			if id == c.Auth.Id {
				liked = true
				continue
			}
			kept = append(kept, id)
		}
		if !liked {
			kept = append(kept, c.Auth.Id)
		}
		rec.Set("likers", kept)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to save", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"likes": len(kept), "liked": !liked})
	}).Bind(apis.RequireAuth())

	// OP reactions are a separate handler only because the map lives in another collection/field;
	// parsing, caps and toggling are shared from shoutbox_reactions.go.
	type opReactPayload struct {
		Room  string `json:"room"`
		Emoji string `json:"emoji"`
	}
	g.POST("/community/react", func(c *core.RequestEvent) error {
		var p opReactPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.Room) == "" {
			return c.BadRequestError("Missing room", err)
		}
		name, err := shoutReactValidName(p.Emoji)
		if err != nil {
			if errors.Is(err, errShoutReactPackDown) {
				return apis.NewApiError(http.StatusServiceUnavailable, err.Error(), nil)
			}
			return c.BadRequestError(err.Error(), nil)
		}
		if shoutMutedUser(c.Auth.Id) {
			return c.ForbiddenError("You are muted.", nil)
		}

		shoutReactMu.Lock()
		defer shoutReactMu.Unlock()

		// User topics only — same reason as likes (DM ids).
		rec := shoutCommunityFindPublic(app, strings.TrimSpace(p.Room))
		if rec == nil || !rec.GetBool("enabled") {
			return c.NotFoundError("Unknown room", nil)
		}
		// Field may be missing (PB/add_shoutbox_op_reactions.py not run) → 503, not "saved": PB silently
		// drops the write and the user would see their reaction until F5.
		if rec.Collection().Fields.GetByName("op_reactions") == nil {
			return apis.NewApiError(http.StatusServiceUnavailable, errShoutReactPackDown.Error(), nil)
		}

		reactions := shoutReactionsField(rec, "op_reactions")
		if err := shoutReactToggle(reactions, name, c.Auth.Id); err != nil {
			return c.BadRequestError(err.Error(), nil)
		}
		rec.Set("op_reactions", reactions)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to save reaction", err)
		}
		// Return the whole map, not a delta: stitching deltas is how two devices of one person diverge.
		return c.JSON(http.StatusOK, map[string]any{
			"op_reactions": reactions,
			"op_top":       shoutCommunityTopReacts(rec, c.Auth.Id),
		})
	}).Bind(apis.RequireAuth())
}
