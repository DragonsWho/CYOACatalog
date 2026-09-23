// DMs and private rooms (chat v2). Author decisions (wiki/decisions.md, 2026-08-04): any logged-in
// user can DM any other; any logged-in user can create a private room (per-user cap); moderators do
// NOT see private content through the site UI. No E2E encryption: messages are plaintext in
// PocketBase; the DB owner can read anything — "moderators can't see" is about site buttons, not
// crypto. Everything goes through Go handlers: shoutbox_channels writeRule is superuser-only and
// must stay so, or anyone could PATCH themselves into a private room's members. A DM is just a
// private channel with is_dm and exactly two members — no separate collection on purpose, so
// feed/send/push/unread/delete work unchanged.
package main

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/security"
)

const (
	shoutRoomsPerOwner  = 5
	shoutRoomMaxMembers = 20
	// DMs per hour: each /dm with a new peer creates a DB row — uncapped it's a garbage generator.
	// Counter kept in memory only (losing it on restart is fine, like mutes).
	shoutDMPerHour = 20
)

var shoutDMRate = struct {
	mu  sync.Mutex
	hit map[string][]time.Time
}{hit: map[string][]time.Time{}}

func shoutDMRateOK(uid string) bool {
	shoutDMRate.mu.Lock()
	defer shoutDMRate.mu.Unlock()
	cut := time.Now().Add(-time.Hour)
	kept := shoutDMRate.hit[uid][:0]
	for _, t := range shoutDMRate.hit[uid] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= shoutDMPerHour {
		shoutDMRate.hit[uid] = kept
		return false
	}
	shoutDMRate.hit[uid] = append(kept, time.Now())
	return true
}

// Deterministic DM slug for a pair (pair sorted, so A→B == B→A); the unique slug index makes
// find-or-create atomic — a race ends in an insert failure, then we re-read. Hash, not
// "dm-<idA>-<idB>": two 15-char ids don't fit slug max=32, and the slug stops listing participants.
func shoutDMSlug(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return "dm-" + shoutHash("dm", shoutSalt(), a, b)
}

func shoutChanFromRecord(r *core.Record) shoutChannel {
	ch := shoutChannel{
		ID:      r.Id,
		Slug:    r.GetString("slug"),
		Title:   r.GetString("title"),
		Desc:    r.GetString("description"),
		Private: r.GetBool("is_private"),
		DM:      r.GetBool("is_dm"),
		Owner:   r.GetString("owner"),
	}
	if ch.Private {
		ch.Members = r.GetStringSlice("members")
	}
	return ch
}

// Member cards in one query; channel records hold only ids, and without names the frontend can't
// label a DM.
func shoutMemberCards(app core.App, chans []shoutChannel) map[string]map[string]any {
	ids := map[string]bool{}
	for _, ch := range chans {
		for _, id := range ch.Members {
			ids[id] = true
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
		out[u.Id] = map[string]any{
			"id":     u.Id,
			"name":   name,
			"avatar": u.GetString("avatar"),
		}
	}
	return out
}

// Non-member → 404 not 403: existence of a private room is private (same as shoutResolveChannel).
func shoutRoomRecord(app core.App, chID, uid string) (*core.Record, error) {
	rec, err := app.FindRecordById(shoutChannelsCol, strings.TrimSpace(chID))
	if err != nil {
		return nil, apis.NewNotFoundError("Unknown channel", nil)
	}
	if !rec.GetBool("is_private") || !shoutIsMember(rec, uid) {
		return nil, apis.NewNotFoundError("Unknown channel", nil)
	}
	return rec, nil
}

func registerShoutboxRooms(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	// Idempotent: the frontend calls this on every "message this person" instead of storing
	// conversation ids.
	type dmPayload struct {
		User string `json:"user"`
	}
	g.POST("/dm", func(c *core.RequestEvent) error {
		var p dmPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.User) == "" {
			return c.BadRequestError("Missing user", err)
		}
		peer := strings.TrimSpace(p.User)
		if peer == c.Auth.Id {
			return c.BadRequestError("Can't message yourself", nil)
		}
		if _, err := app.FindRecordById("users", peer); err != nil {
			return c.NotFoundError("User not found", err)
		}
		// A block in either direction = no conversation (shoutbox_blocks.go). Same answer for both sides
		// on purpose: "you're blocked" is information about someone else's decision.
		if shoutBlockBetween(app, c.Auth.Id, peer) {
			return apis.NewForbiddenError("This conversation is closed.", nil)
		}

		slug := shoutDMSlug(c.Auth.Id, peer)
		if rec, err := app.FindFirstRecordByFilter(shoutChannelsCol,
			"slug = {:slug}", dbx.Params{"slug": slug}); err == nil {
			// Also re-enable a DM an admin disabled — the conversation shouldn't vanish because of that.
			if !rec.GetBool("enabled") {
				rec.Set("enabled", true)
				_ = app.Save(rec)
			}
			return c.JSON(http.StatusOK, map[string]any{"channel": shoutChanFromRecord(rec)})
		}

		if !shoutDMRateOK(c.Auth.Id) {
			return apis.NewApiError(http.StatusTooManyRequests, "Too many new conversations. Try later.", nil)
		}

		coll, err := app.FindCollectionByNameOrId(shoutChannelsCol)
		if err != nil {
			return c.InternalServerError("Channels storage missing", err)
		}
		rec := core.NewRecord(coll)
		rec.Set("slug", slug)
		// DM title is a placeholder the frontend replaces with the peer's name; never store a name here
		// (names change, the field doesn't).
		rec.Set("title", "Direct message")
		rec.Set("sort", 1000)
		rec.Set("enabled", true)
		rec.Set("is_private", true)
		rec.Set("is_dm", true)
		rec.Set("members", []string{c.Auth.Id, peer})
		if err := app.Save(rec); err != nil {
			// Race: a parallel request created the same DM and hit the unique slug index. Re-read — same
			// result.
			if other, e2 := app.FindFirstRecordByFilter(shoutChannelsCol,
				"slug = {:slug}", dbx.Params{"slug": slug}); e2 == nil {
				return c.JSON(http.StatusOK, map[string]any{"channel": shoutChanFromRecord(other)})
			}
			return c.InternalServerError("Failed to open conversation", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"channel": shoutChanFromRecord(rec)})
	}).Bind(apis.RequireAuth())

	// Members are added without confirmation, on purpose: rooms are for an already-agreed group;
	// anyone can leave with one button.
	type roomPayload struct {
		Title   string   `json:"title"`
		Members []string `json:"members"`
	}
	g.POST("/rooms", func(c *core.RequestEvent) error {
		var p roomPayload
		if err := c.BindBody(&p); err != nil {
			return c.BadRequestError("Bad request", err)
		}
		title := strings.TrimSpace(p.Title)
		if n := utf8.RuneCountInString(title); n < 1 || n > 40 {
			return c.BadRequestError("Room name must be 1–40 characters.", nil)
		}

		// `is_private = true` is required: users also own PUBLIC topic rooms (shoutbox_community.go);
		// without it, topics would eat the private-room quota.
		owned, err := app.FindRecordsByFilter(shoutChannelsCol,
			"owner = {:u} && is_dm = false && is_private = true", "", shoutRoomsPerOwner+1, 0,
			dbx.Params{"u": c.Auth.Id})
		if err == nil && len(owned) >= shoutRoomsPerOwner {
			return c.BadRequestError("You already have the maximum number of rooms.", nil)
		}

		members := shoutDedupIDs(append([]string{c.Auth.Id}, p.Members...))
		if len(members) > shoutRoomMaxMembers {
			return c.BadRequestError("Too many members.", nil)
		}
		// Unknown ids dropped silently: an account may be deleted between opening the dialog and
		// clicking.
		clean := make([]string, 0, len(members))
		for _, id := range members {
			if _, e := app.FindRecordById("users", id); e == nil {
				clean = append(clean, id)
			}
		}

		coll, err := app.FindCollectionByNameOrId(shoutChannelsCol)
		if err != nil {
			return c.InternalServerError("Channels storage missing", err)
		}
		rec := core.NewRecord(coll)
		rec.Set("slug", "room-"+security.RandomStringWithAlphabet(16, "abcdefghijklmnopqrstuvwxyz0123456789"))
		rec.Set("title", title)
		rec.Set("sort", 500)
		rec.Set("enabled", true)
		rec.Set("is_private", true)
		rec.Set("is_dm", false)
		rec.Set("owner", c.Auth.Id)
		rec.Set("members", clean)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to create room", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"channel": shoutChanFromRecord(rec)})
	}).Bind(apis.RequireAuth())

	// Owner only; never on DMs — a two-person conversation isn't extended with a third (that's what
	// rooms are for).
	type membersPayload struct {
		Channel string   `json:"channel"`
		Add     []string `json:"add"`
		Remove  []string `json:"remove"`
	}
	g.POST("/rooms/members", func(c *core.RequestEvent) error {
		var p membersPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.Channel) == "" {
			return c.BadRequestError("Missing channel", err)
		}
		rec, err := shoutRoomRecord(app, p.Channel, c.Auth.Id)
		if err != nil {
			return err
		}
		if rec.GetBool("is_dm") {
			return c.BadRequestError("A conversation can't have more than two people.", nil)
		}
		if rec.GetString("owner") != c.Auth.Id {
			return c.ForbiddenError("Only the room owner can do that.", nil)
		}

		drop := map[string]bool{}
		for _, id := range p.Remove {
			if id != c.Auth.Id {
				drop[strings.TrimSpace(id)] = true
			}
		}
		members := make([]string, 0, shoutRoomMaxMembers)
		for _, id := range rec.GetStringSlice("members") {
			if !drop[id] {
				members = append(members, id)
			}
		}
		for _, id := range p.Add {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			if _, e := app.FindRecordById("users", id); e != nil {
				continue
			}
			members = append(members, id)
		}
		members = shoutDedupIDs(members)
		if len(members) > shoutRoomMaxMembers {
			return c.BadRequestError("Too many members.", nil)
		}
		rec.Set("members", members)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to update members", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"channel": shoutChanFromRecord(rec)})
	}).Bind(apis.RequireAuth())

	// You can't leave a DM (you just don't open it).
	type leavePayload struct {
		Channel string `json:"channel"`
	}
	g.POST("/rooms/leave", func(c *core.RequestEvent) error {
		var p leavePayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.Channel) == "" {
			return c.BadRequestError("Missing channel", err)
		}
		rec, err := shoutRoomRecord(app, p.Channel, c.Auth.Id)
		if err != nil {
			return err
		}
		if rec.GetBool("is_dm") {
			return c.BadRequestError("You can't leave a private conversation.", nil)
		}
		// Can't leave the staff room: membership = moderator list and the next chat visit would re-add
		// you (shoutbox_staff.go). A button the server undoes is a lie.
		if shoutIsStaffRoom(rec) {
			return c.BadRequestError("The staff room follows the moderator list — you leave it by stepping down.", nil)
		}
		members := make([]string, 0, shoutRoomMaxMembers)
		for _, id := range rec.GetStringSlice("members") {
			if id != c.Auth.Id {
				members = append(members, id)
			}
		}
		rec.Set("members", members)
		// Owner left → room goes to the first remaining member; empty room is disabled.
		if rec.GetString("owner") == c.Auth.Id {
			if len(members) == 0 {
				rec.Set("enabled", false)
				rec.Set("owner", "")
			} else {
				rec.Set("owner", members[0])
			}
		}
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to leave room", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	}).Bind(apis.RequireAuth())
}

// Stable order so PATCHing the same member set doesn't reshuffle the field on every save.
func shoutDedupIDs(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, id := range in {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
