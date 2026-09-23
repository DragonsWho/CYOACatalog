// Public chat rooms, moderator view: create, rename, reorder, hide, make private. These handlers
// must NOT: touch DMs (is_dm); touch someone else's private room ("make public" would become "show
// everyone their conversation") — shoutAdminRoom allows only public or the caller's own; delete (a
// room is all its messages — use enabled=false instead).
package main

import (
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/security"
)

const (
	shoutAdminTitleMax = 40  // = schema max of title
	shoutAdminDescMax  = 200 // = schema max of description
	// Cap is about eyes, not the DB: past ~10 chips the phone room strip becomes endless scrolling.
	shoutAdminRoomsMax = 24
)

// Allowed: public, or the caller's own. Foreign private room / DM → 404.
func shoutAdminRoom(app core.App, id, uid string) (*core.Record, error) {
	rec, err := app.FindRecordById(shoutChannelsCol, strings.TrimSpace(id))
	if err != nil {
		return nil, apis.NewNotFoundError("Unknown channel", err)
	}
	if rec.GetBool("is_dm") {
		return nil, apis.NewNotFoundError("Unknown channel", nil)
	}
	// Staff room is an exception: shared by all staff, any moderator with chat permission manages it
	// (shoutbox_staff.go).
	if rec.GetBool("is_private") && rec.GetString("owner") != uid && !shoutIsStaffRoom(rec) {
		return nil, apis.NewNotFoundError("Unknown channel", nil)
	}
	return rec, nil
}

// Slug from title; if taken, add a suffix rather than refuse ("Off Topic" vs "off-topic" is a legit
// clash).
func shoutAdminSlug(app core.App, title string) string {
	base := slugifyGame(title)
	if len(base) > 24 {
		base = strings.Trim(base[:24], "-")
	}
	if base == "" {
		base = "room"
	}
	// The staff slug is reserved forever: a room named "Staff" would otherwise become the staff room
	// by accident.
	if shoutStaffSlugTaken(base) {
		base = "room-" + base
	}
	slug := base
	for i := 0; i < 5; i++ {
		if _, err := app.FindFirstRecordByFilter(shoutChannelsCol,
			"slug = {:s}", dbx.Params{"s": slug}); err != nil {
			return slug
		}
		slug = base + "-" + security.RandomStringWithAlphabet(4, "abcdefghijklmnopqrstuvwxyz0123456789")
	}
	return "room-" + security.RandomStringWithAlphabet(16, "abcdefghijklmnopqrstuvwxyz0123456789")
}

// Includes hidden (enabled=false) rooms, or they couldn't be restored. `owner = ”` = the author's
// rooms; a public room WITH an owner is a user topic (shoutbox_community.go) — thousands of them
// would push real rooms out of this panel (topics have sort=300).
func shoutAdminList(app core.App, uid string) []map[string]any {
	recs, err := app.FindRecordsByFilter(shoutChannelsCol,
		"is_dm = false && ((is_private = false && "+shoutRoomOnlyFilter+") || (is_private = true && owner = {:u}))",
		"sort,slug", shoutAdminRoomsMax*2, 0, dbx.Params{"u": uid})
	if err != nil {
		return []map[string]any{}
	}
	// Staff room is shown to every moderator (so "sync members" can be pressed from anywhere).
	if staff := shoutStaffRoomRecord(app); shoutIsStaffRoom(staff) && staff.GetString("owner") != uid {
		recs = append(recs, staff)
	}
	out := make([]map[string]any, 0, len(recs))
	for _, r := range recs {
		out = append(out, map[string]any{
			"id":          r.Id,
			"slug":        r.GetString("slug"),
			"title":       r.GetString("title"),
			"description": r.GetString("description"),
			"sort":        r.GetInt("sort"),
			"enabled":     r.GetBool("enabled"),
			"is_private":  r.GetBool("is_private"),
			// Owner needed by the panel to decide whether to show membership editing (only the owner may
			// invite/kick, shoutbox_rooms.go).
			"owner":   r.GetString("owner"),
			"members": r.GetStringSlice("members"),
		})
	}
	return out
}

func shoutAdminTitle(title string) error {
	if n := utf8.RuneCountInString(title); n < 1 || n > shoutAdminTitleMax {
		return fmt.Errorf("Room name must be 1–%d characters.", shoutAdminTitleMax)
	}
	return nil
}

func registerShoutboxRoomsAdmin(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	mod := func(fn func(c *core.RequestEvent) error) func(c *core.RequestEvent) error {
		return func(c *core.RequestEvent) error {
			if !hasPerm(c, permChat) {
				return c.ForbiddenError("Moderators only.", nil)
			}
			return fn(c)
		}
	}

	g.GET("/rooms/admin", mod(func(c *core.RequestEvent) error {
		return c.JSON(http.StatusOK, map[string]any{"rooms": shoutAdminList(app, c.Auth.Id)})
	})).Bind(apis.RequireAuth())

	g.POST("/rooms/admin", mod(func(c *core.RequestEvent) error {
		var p struct {
			Title string `json:"title"`
			Desc  string `json:"description"`
		}
		if err := c.BindBody(&p); err != nil {
			return c.BadRequestError("Bad request", err)
		}
		title := strings.TrimSpace(p.Title)
		if err := shoutAdminTitle(title); err != nil {
			return c.BadRequestError(err.Error(), nil)
		}
		desc := strings.TrimSpace(p.Desc)
		if utf8.RuneCountInString(desc) > shoutAdminDescMax {
			return c.BadRequestError(fmt.Sprintf("Description must be up to %d characters.", shoutAdminDescMax), nil)
		}

		// Count ONLY author rooms (`owner = ''`): topics have sort=300 and would hit the cap and blow up
		// `next`.
		open, err := app.FindRecordsByFilter(shoutChannelsCol,
			"is_dm = false && is_private = false && "+shoutRoomOnlyFilter, "-sort", shoutAdminRoomsMax+1, 0)
		if err == nil && len(open) >= shoutAdminRoomsMax {
			return c.BadRequestError("There are already too many public rooms.", nil)
		}
		// Append at the end: a new room mustn't jump above General.
		next := 10
		if len(open) > 0 {
			next = open[0].GetInt("sort") + 10
		}

		coll, err := app.FindCollectionByNameOrId(shoutChannelsCol)
		if err != nil {
			return c.InternalServerError("Channels storage missing", err)
		}
		rec := core.NewRecord(coll)
		rec.Set("slug", shoutAdminSlug(app, title))
		rec.Set("title", title)
		rec.Set("description", desc)
		rec.Set("sort", next)
		rec.Set("enabled", true)
		rec.Set("is_private", false)
		rec.Set("is_dm", false)
		if err := app.Save(rec); err != nil {
			return c.BadRequestError("Failed to create the room", err)
		}
		logModAction(app, c, modAction{
			Action:     "chat.room_create",
			Target:     rec.Id + " " + rec.GetString("slug"),
			After:      modSnapshot(rec, "slug", "title", "description", "enabled", "is_private"),
			Reversible: true,
			Note:       "new public room; undo = hide it (enabled=false) or delete the channel record",
		})
		return c.JSON(http.StatusOK, map[string]any{"rooms": shoutAdminList(app, c.Auth.Id)})
	})).Bind(apis.RequireAuth())

	// Optional fields as pointers: the panel sends only what changed.
	g.POST("/rooms/admin/update", mod(func(c *core.RequestEvent) error {
		var p struct {
			Channel string  `json:"channel"`
			Title   *string `json:"title"`
			Desc    *string `json:"description"`
			Enabled *bool   `json:"enabled"`
			Private *bool   `json:"is_private"`
		}
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.Channel) == "" {
			return c.BadRequestError("Missing channel", err)
		}
		rec, err := shoutAdminRoom(app, p.Channel, c.Auth.Id)
		if err != nil {
			return err
		}
		roomFields := []string{"title", "description", "enabled", "is_private", "owner", "members"}
		roomBefore := modSnapshot(rec, roomFields...)

		if p.Title != nil {
			title := strings.TrimSpace(*p.Title)
			if err := shoutAdminTitle(title); err != nil {
				return c.BadRequestError(err.Error(), nil)
			}
			// Renaming does NOT change the slug: slugs are in links and discord_channel_id bindings.
			rec.Set("title", title)
		}
		if p.Desc != nil {
			desc := strings.TrimSpace(*p.Desc)
			if utf8.RuneCountInString(desc) > shoutAdminDescMax {
				return c.BadRequestError(fmt.Sprintf("Description must be up to %d characters.", shoutAdminDescMax), nil)
			}
			rec.Set("description", desc)
		}
		if p.Enabled != nil {
			rec.Set("enabled", *p.Enabled)
		}
		if p.Private != nil && *p.Private != rec.GetBool("is_private") {
			if err := shoutStaffGuard(rec, !*p.Private); err != nil {
				return err
			}
			if *p.Private {
				// When making private, add the moderator as owner+member, or it vanishes from everyone's menu
				// including theirs.
				rec.Set("is_private", true)
				if rec.GetString("owner") == "" {
					rec.Set("owner", c.Auth.Id)
				}
				rec.Set("members", shoutDedupIDs(append(rec.GetStringSlice("members"), c.Auth.Id)))
			} else {
				// Back to public: members list kept (it may be closed again).
				rec.Set("is_private", false)
			}
		}
		if err := app.Save(rec); err != nil {
			return c.BadRequestError("Failed to save the room", err)
		}
		logModAction(app, c, modAction{
			Action:     "chat.room_update",
			Target:     rec.Id + " " + rec.GetString("slug"),
			Before:     roomBefore,
			After:      modSnapshot(rec, roomFields...),
			Reversible: true,
		})
		return c.JSON(http.StatusOK, map[string]any{"rooms": shoutAdminList(app, c.Auth.Id)})
	})).Bind(apis.RequireAuth())

	// Reorder by swapping sort with a neighbor, not rewriting the list.
	g.POST("/rooms/admin/move", mod(func(c *core.RequestEvent) error {
		var p struct {
			Channel string `json:"channel"`
			Dir     string `json:"dir"`
		}
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.Channel) == "" {
			return c.BadRequestError("Missing channel", err)
		}
		if _, err := shoutAdminRoom(app, p.Channel, c.Auth.Id); err != nil {
			return err
		}
		// Move only among the author's public rooms: private rooms and user topics (`owner != ''`) aren't
		// in this menu — otherwise the "neighbor" could be someone's topic.
		recs, err := app.FindRecordsByFilter(shoutChannelsCol,
			"is_dm = false && is_private = false && "+shoutRoomOnlyFilter, "sort,slug", shoutAdminRoomsMax*2, 0)
		if err != nil {
			return c.InternalServerError("Could not read the rooms", err)
		}
		i := -1
		for n, r := range recs {
			if r.Id == strings.TrimSpace(p.Channel) {
				i = n
				break
			}
		}
		j := i - 1
		if p.Dir == "down" {
			j = i + 1
		} else if p.Dir != "up" {
			return c.BadRequestError("Unknown direction", nil)
		}
		if i >= 0 && j >= 0 && j < len(recs) {
			err = app.RunInTransaction(func(tx core.App) error {
				si, sj := recs[i].GetInt("sort"), recs[j].GetInt("sort")
				if si == sj {
					// Order was determined by slug; swapping would change nothing.
					for n, r := range recs {
						r.Set("sort", (n+1)*10)
						if e := tx.Save(r); e != nil {
							return e
						}
					}
					si, sj = (i+1)*10, (j+1)*10
				}
				recs[i].Set("sort", sj)
				recs[j].Set("sort", si)
				if e := tx.Save(recs[i]); e != nil {
					return e
				}
				return tx.Save(recs[j])
			})
			if err != nil {
				return c.BadRequestError("Failed to save the order", err)
			}
		}
		return c.JSON(http.StatusOK, map[string]any{"rooms": shoutAdminList(app, c.Auth.Id)})
	})).Bind(apis.RequireAuth())
}
