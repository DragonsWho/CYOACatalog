// Personal block list ("don't show me this person, no DMs from them"). Author decision 2026-08-04:
// stored SERVER-side (own collection), not localStorage — the request was literally "block them
// from DMing me", so whoever lets messages through (the server) must know. Effects: no DMs between
// the pair (BOTH directions); no bell/push for their mentions; frontend hides their lines in the
// feed. Both directions on purpose: a two-person conversation where one can't hear the other is a
// trap (the blocked person writes into a void). Moderator mutes (shoutState.mutes) are different:
// global and temporary; this is personal and permanent.
package main

import (
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

const (
	shoutBlocksCol = "shoutbox_blocks"
	// Per-user cap: it's for a couple of unpleasant people, not a site-wide blacklist; also stops a
	// loop from generating DB rows.
	shoutBlocksMax = 200
)

// Called on every DM send and mention — must stay a single unique-index lookup.
func shoutBlockExists(app core.App, blocker, blocked string) bool {
	if blocker == "" || blocked == "" || blocker == blocked {
		return false
	}
	_, err := app.FindFirstRecordByFilter(shoutBlocksCol,
		"user = {:u} && blocked = {:b}",
		dbx.Params{"u": blocker, "b": blocked})
	return err == nil
}

func shoutBlockBetween(app core.App, a, b string) bool {
	return shoutBlockExists(app, a, b) || shoutBlockExists(app, b, a)
}

func shoutDMPeer(ch *core.Record, me string) string {
	if ch == nil || !ch.GetBool("is_dm") {
		return ""
	}
	for _, id := range ch.GetStringSlice("members") {
		if id != me {
			return id
		}
	}
	return ""
}

// The server deliberately doesn't filter the feed: it's a stock PB list, cached for everyone, can't
// be personal. The frontend hides lines.
func shoutBlockList(app core.App, uid string) []string {
	if uid == "" {
		return nil
	}
	recs, err := app.FindRecordsByFilter(shoutBlocksCol, "user = {:u}", "-created",
		shoutBlocksMax, 0, dbx.Params{"u": uid})
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(recs))
	for _, r := range recs {
		if b := r.GetString("blocked"); b != "" {
			out = append(out, b)
		}
	}
	return out
}

func registerShoutboxBlocks(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	g.GET("/blocks", func(c *core.RequestEvent) error {
		return c.JSON(http.StatusOK, map[string]any{"blocked": shoutBlockList(app, c.Auth.Id)})
	}).Bind(apis.RequireAuth())

	type blockPayload struct {
		User string `json:"user"`
	}

	g.POST("/block", func(c *core.RequestEvent) error {
		var p blockPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.User) == "" {
			return c.BadRequestError("Missing user", err)
		}
		peer := strings.TrimSpace(p.User)
		if peer == c.Auth.Id {
			return c.BadRequestError("Can't block yourself", nil)
		}
		if _, err := app.FindRecordById("users", peer); err != nil {
			return c.NotFoundError("User not found", err)
		}
		if shoutBlockExists(app, c.Auth.Id, peer) {
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}
		if len(shoutBlockList(app, c.Auth.Id)) >= shoutBlocksMax {
			return c.BadRequestError("Your block list is full.", nil)
		}
		coll, err := app.FindCollectionByNameOrId(shoutBlocksCol)
		if err != nil {
			return c.InternalServerError("Block list storage missing", err)
		}
		rec := core.NewRecord(coll)
		rec.Set("user", c.Auth.Id)
		rec.Set("blocked", peer)
		if err := app.Save(rec); err != nil {
			// A double-click race hits the unique index — same result as success for the caller.
			if shoutBlockExists(app, c.Auth.Id, peer) {
				return c.JSON(http.StatusOK, map[string]any{"ok": true})
			}
			return c.InternalServerError("Failed to block", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	}).Bind(apis.RequireAuth())

	g.POST("/unblock", func(c *core.RequestEvent) error {
		var p blockPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.User) == "" {
			return c.BadRequestError("Missing user", err)
		}
		rec, err := app.FindFirstRecordByFilter(shoutBlocksCol,
			"user = {:u} && blocked = {:b}",
			dbx.Params{"u": c.Auth.Id, "b": strings.TrimSpace(p.User)})
		if err != nil {
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		}
		if err := app.Delete(rec); err != nil {
			return c.InternalServerError("Failed to unblock", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"ok": true})
	}).Bind(apis.RequireAuth())
}
