package main

// First-party per-game view counter. Not GA: ad-blockers drop a big slice of GA hits on an NSFW
// audience and GA numbers can't be read back onto the site. A same-origin ping into our DB is
// unblockable and ours. Status: INTERNAL — write endpoint live (accumulating), stats exposed ONLY
// to moderators via GET /api/custom/mod/game-views. Counts live in a separate additive `game_views`
// collection, auto-created on boot (id, game[text,unique], count[number], updated[autodate]) — the
// one schema change of this feature; never alters existing collections.
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

// Creates the counter collection if missing. Non-fatal: on failure log and leave the feature dark
// rather than block boot.
func ensureGameViewsCollection(app core.App) {
	if _, err := app.FindCollectionByNameOrId(gameViewsColl); err == nil {
		return
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

// Atomic increment: single `count = count + 1` UPDATE so concurrent views aren't lost; only a
// game's first view falls through to INSERT.
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

	// First view: insert. If we lost a race and the unique index rejects it, the row exists — just
	// increment.
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

// One row of the moderator stats readout.
type gameViewStat struct {
	GameID  string `db:"game_id" json:"game_id"`
	Slug    string `db:"slug"    json:"slug"` // pretty-URL key; link via slug||id
	Title   string `db:"title"   json:"title"`
	Count   int    `db:"count"   json:"count"`
	Updated string `db:"updated" json:"updated"`
}

func registerViewCounter(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		ensureGameViewsCollection(app)

		g := e.Router.Group("/api/custom")

		// ── Record a view (public; anonymous users view games too) ── Client sessionStorage dedup limits
		// refresh spam; we still verify the game exists so junk ids can't seed rows.
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

		// ── Moderator-only readout ── Top games by view count joined to title. Not for public UI.
		g.GET("/mod/game-views", func(c *core.RequestEvent) error {
			if !hasPerm(c, permStats) {
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
