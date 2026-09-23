// Staff room and staff badges. Moderators need a room closed to visitors, but not created by hand
// per new moderator. Also the site author must be distinguishable from moderators (red nick used to
// mean "any staff"). The room is a normal private room (`is_private = true`) with reserved slug
// `staff`; no new schema flag — message read access is enforced by the shoutbox_messages listRule
// on channel `members`, which can't check roles. So membership is materialized: the server writes
// every `isModerator = true` user into members. New moderators are added on their first chat visit
// (shoutStaffJoin from /channels, cheap, moderators only); demoted ones removed by sync from the
// rooms panel; leaving is impossible (would be undone). "Admin" (red) = moderator allowed to grant
// permissions (permPerms), i.e. the site owner. Legacy moderators without a mod_permissions row
// count as full (mod_perms.go).
package main

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// Constant, not a setting: server and rooms panel must agree on it.
const shoutStaffSlug = "staff"

const shoutStaffTitle = "Staff"

const shoutStaffTTL = 60 * time.Second

var shoutStaffCache struct {
	mu     sync.Mutex
	admins []string
	at     time.Time
}

func shoutStaffModerators(app core.App) []*core.Record {
	recs, err := app.FindRecordsByFilter("users", "isModerator = true", "username", 0, 0)
	if err != nil {
		return nil
	}
	return recs
}

func shoutStaffAdmins(app core.App) []string {
	shoutStaffCache.mu.Lock()
	defer shoutStaffCache.mu.Unlock()
	if time.Since(shoutStaffCache.at) < shoutStaffTTL && shoutStaffCache.admins != nil {
		return shoutStaffCache.admins
	}
	out := []string{}
	for _, u := range shoutStaffModerators(app) {
		if authHasPerm(u, permPerms) {
			out = append(out, u.Id)
		}
	}
	shoutStaffCache.admins = out
	shoutStaffCache.at = time.Now()
	return out
}

// nil if not created yet — not an error.
func shoutStaffRoomRecord(app core.App) *core.Record {
	rec, err := app.FindFirstRecordByFilter(shoutChannelsCol,
		"slug = {:s}", dbx.Params{"s": shoutStaffSlug})
	if err != nil {
		return nil
	}
	return rec
}

func shoutIsStaffRoom(rec *core.Record) bool {
	return rec != nil && rec.GetString("slug") == shoutStaffSlug && rec.GetBool("is_private")
}

// Called from /channels, else a new moderator wouldn't see the room until someone pressed "sync".
// One lookup, moderators only.
func shoutStaffJoin(app core.App, auth *core.Record) {
	if auth == nil || !auth.GetBool("isModerator") {
		return
	}
	rec := shoutStaffRoomRecord(app)
	if !shoutIsStaffRoom(rec) || shoutIsMember(rec, auth.Id) {
		return
	}
	rec.Set("members", shoutDedupIDs(append(rec.GetStringSlice("members"), auth.Id)))
	_ = app.Save(rec)
}

// Owner is never removed even if demoted, or the room would be ownerless.
func shoutStaffSync(app core.App, rec *core.Record) error {
	mods := shoutStaffModerators(app)
	members := make([]string, 0, len(mods)+1)
	if owner := rec.GetString("owner"); owner != "" {
		members = append(members, owner)
	}
	for _, u := range mods {
		members = append(members, u.Id)
	}
	rec.Set("members", shoutDedupIDs(members))
	return app.Save(rec)
}

func registerShoutboxStaff(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	// Public: red nicks are already visible in the feed.
	g.GET("/staff", func(c *core.RequestEvent) error {
		return c.JSON(http.StatusOK, map[string]any{"admins": shoutStaffAdmins(app)})
	})

	// One handler for create and sync: same question — "the room exists and contains all moderators".
	g.POST("/rooms/admin/staff", func(c *core.RequestEvent) error {
		if !hasPerm(c, permChat) {
			return c.ForbiddenError("Moderators only.", nil)
		}
		rec := shoutStaffRoomRecord(app)
		created := false
		if rec == nil {
			coll, err := app.FindCollectionByNameOrId(shoutChannelsCol)
			if err != nil {
				return c.InternalServerError("Channels storage missing", err)
			}
			rec = core.NewRecord(coll)
			rec.Set("slug", shoutStaffSlug)
			rec.Set("title", shoutStaffTitle)
			rec.Set("description", "Moderators only")
			rec.Set("enabled", true)
			rec.Set("is_dm", false)
			rec.Set("owner", c.Auth.Id)
			created = true
		}
		// The room may exist as public (created by hand under the same slug) — force private.
		rec.Set("is_private", true)
		rec.Set("enabled", true)
		if rec.GetBool("is_dm") {
			return c.BadRequestError("A conversation can't be the staff room.", nil)
		}
		if err := shoutStaffSync(app, rec); err != nil {
			return c.BadRequestError("Failed to save the staff room", err)
		}
		action := "chat.staff_room_sync"
		if created {
			action = "chat.staff_room_create"
		}
		logModAction(app, c, modAction{
			Action:     action,
			Target:     rec.Id + " " + rec.GetString("slug"),
			After:      modSnapshot(rec, "slug", "title", "enabled", "is_private", "owner", "members"),
			Reversible: true,
			Note:       "staff room: members = every moderator; undo = hide it (enabled=false)",
		})
		return c.JSON(http.StatusOK, map[string]any{"rooms": shoutAdminList(app, c.Auth.Id)})
	}).Bind(apis.RequireAuth())
}

func shoutStaffGuard(rec *core.Record, makePublic bool) error {
	if !shoutIsStaffRoom(rec) || !makePublic {
		return nil
	}
	return apis.NewBadRequestError(
		"The staff room can't be made public — it would show every internal message to everyone.", nil)
}

// Where slugs derive from titles: a public room "Staff" would otherwise take the staff slug.
func shoutStaffSlugTaken(slug string) bool {
	return strings.EqualFold(strings.TrimSpace(slug), shoutStaffSlug)
}
