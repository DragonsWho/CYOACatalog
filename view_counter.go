package main

// First-party per-game view counter.
//
// Why not just use Google Analytics: on an NSFW audience ad-blockers drop a big
// slice of GA hits, and GA numbers can't be read back onto the site in realtime.
// A same-origin ping into our own DB is un-blockable and gives us a number we
// own and can show on the site.
//
// Status: INTERNAL / not shown in the public UI yet. The write endpoint is live
// (so we start accumulating data), but the stats are exposed ONLY to moderators
// via GET /api/custom/mod/game-views, rendered on the moderator panel while we
// calibrate. Nothing here touches the `games` schema — counts live in their own
// additive `game_views` collection, auto-created on boot if missing.
//
// ⚠️ SCHEMA NOTE for review before prod: booting this creates the `game_views`
// collection (id, game[text,unique], count[number], updated[autodate]). That is
// the one schema change in this feature; it never alters existing collections.

import (
	"log"
	"net/http"
	"strconv"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const gameViewsColl = "game_views"

// ensureGameViewsCollection creates the additive counter collection if it does
// not exist yet. Non-fatal: on any failure we log and leave the feature dark
// rather than blocking server boot.
func ensureGameViewsCollection(app core.App) {
	if _, err := app.FindCollectionByNameOrId(gameViewsColl); err == nil {
		return // already there
	}

	col := core.NewBaseCollection(gameViewsColl)
	col.Fields.Add(
		&core.TextField{Name: "game", Required: true, Max: 255},
		&core.NumberField{Name: "count"},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
	)
	// One row per game; enables the atomic UPSERT below and guards against dupes.
	col.AddIndex("idx_game_views_game", true, "game", "")

	if err := app.Save(col); err != nil {
		log.Printf("view_counter: failed to create %q collection (feature disabled): %v", gameViewsColl, err)
		return
	}
	log.Printf("view_counter: created %q collection", gameViewsColl)
}

// bumpGameView increments a game's view count atomically. The UPDATE is a single
// `count = count + 1` statement so concurrent views can't lose each other; only
// the first-ever view of a game falls through to an INSERT.
func bumpGameView(app core.App, gameID string) error {
	res, err := app.DB().
		NewQuery("UPDATE {{" + gameViewsColl + "}} SET count = count + 1, updated = {:now} WHERE game = {:game}").
		Bind(dbx.Params{"game": gameID, "now": types.NowDateTime().String()}).
		Execute()
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}

	// First view: create the row. If we lost a race and the unique index rejects
	// the insert, the row now exists — just increment it.
	col, err := app.FindCollectionByNameOrId(gameViewsColl)
	if err != nil {
		return err
	}
	rec := core.NewRecord(col)
	rec.Set("game", gameID)
	rec.Set("count", 1)
	if err := app.Save(rec); err != nil {
		_, err2 := app.DB().
			NewQuery("UPDATE {{" + gameViewsColl + "}} SET count = count + 1, updated = {:now} WHERE game = {:game}").
			Bind(dbx.Params{"game": gameID, "now": types.NowDateTime().String()}).
			Execute()
		return err2
	}
	return nil
}

// gameViewStat is one row of the moderator stats readout.
type gameViewStat struct {
	GameID  string `db:"game_id" json:"game_id"`
	Slug    string `db:"slug"    json:"slug"` // pretty-URL key; link via slug||id
	Title   string `db:"title"   json:"title"`
	Count   int    `db:"count"   json:"count"`
	Updated string `db:"updated" json:"updated"`
}

func registerViewCounter(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		// Ensure the additive counter collection exists before serving.
		ensureGameViewsCollection(app)

		g := e.Router.Group("/api/custom")

		// ── Record a view (public; anonymous users view games too) ────────────
		// Client-side sessionStorage dedup keeps refresh-spam down; we still
		// verify the game exists so junk ids can't seed rows.
		g.POST("/games/{id}/view", func(c *core.RequestEvent) error {
			gameID := c.Request.PathValue("id")
			if gameID == "" {
				return c.BadRequestError("Missing game id", nil)
			}
			if _, err := app.FindRecordById("games", gameID); err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			if err := bumpGameView(app, gameID); err != nil {
				return c.InternalServerError("Failed to record view", err)
			}
			return c.JSON(http.StatusOK, map[string]bool{"ok": true})
		})

		// ── Moderator-only readout ────────────────────────────────────────────
		// Top games by view count, joined to their title. Not for the public UI.
		g.GET("/mod/game-views", func(c *core.RequestEvent) error {
			if !c.Auth.GetBool("isModerator") {
				return apis.NewForbiddenError("Only moderators can view stats", nil)
			}
			limit := 200
			if v := c.Request.URL.Query().Get("limit"); v != "" {
				if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
					limit = n
				}
			}

			stats := []gameViewStat{}
			err := app.DB().
				NewQuery(`
					SELECT gv.game AS game_id,
					       COALESCE(g.slug, '') AS slug,
					       COALESCE(g.title, '') AS title,
					       gv.count AS count,
					       gv.updated AS updated
					FROM {{` + gameViewsColl + `}} gv
					LEFT JOIN {{games}} g ON g.id = gv.game
					ORDER BY gv.count DESC
					LIMIT {:limit}
				`).
				Bind(dbx.Params{"limit": limit}).
				All(&stats)
			if err != nil {
				return c.InternalServerError("Failed to load stats", err)
			}
			return c.JSON(http.StatusOK, map[string]any{"stats": stats})
		}).Bind(apis.RequireAuth())

		return e.Next()
	})
}
