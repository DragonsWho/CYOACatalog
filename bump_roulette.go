package main

// Bump roulette — a community raffle that decides which game gets bumped to the
// top of the catalog. Users spend a once-a-day vote as a raffle ticket on a game
// (up to 3 tickets per game per account); once per interval a cron draw picks one
// uniformly-random ticket and its game wins (bumped_at = now, tickets reset, 30d
// vote lockout). More tickets ⇒ more chances.
//
// Two existing systems are the template — no new architectural patterns:
//   • server-authoritative voting (the tag-vote endpoint in main.go): bump_votes
//     is backend-write-only, every rule is enforced here in Go, the frontend only
//     ever reads aggregates. A user can only ever add/remove THEIR OWN ticket.
//   • cron + singleton settings (publication_queue.go): a minute cron ticks and
//     draws when now ≥ bump_settings.next_draw_at.
//
// New collections (bump_votes, bump_draws, bump_settings) auto-create on boot like
// game_views (view_counter.go); nothing here touches the games/users schema. The
// actual bump reuses games.bumped_at. Canon: PB/schema_changes_bump_roulette.md

import (
	"log"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	bumpVotesColl    = "bump_votes"
	bumpDrawsColl    = "bump_draws"
	bumpSettingsColl = "bump_settings"
)

// Defaults applied when a settings field is unset/zero. Moderators tune these live
// in the roulette panel (bump_settings singleton).
const (
	defBumpIntervalHours   = 24
	defBumpMinAgeDays      = 14
	defBumpWinLockoutDays  = 30
	defBumpMaxPerGame      = 3
	defBumpVoteCooldownHrs = 24
	defBumpWithdrawHrs     = 24
	bumpStandingsLimit     = 50
	bumpWinnersLimit       = 20
)

// ─── Collection bootstrap ──────────────────────────────────────────────────────

// ensureBumpCollections creates the three roulette collections + the settings
// singleton if they do not exist yet. Non-fatal: on any failure we log and leave
// the feature dark rather than blocking boot (mirrors ensureGameViewsCollection).
func ensureBumpCollections(app core.App) {
	if _, err := app.FindCollectionByNameOrId(bumpVotesColl); err != nil {
		col := core.NewBaseCollection(bumpVotesColl)
		col.Fields.Add(
			&core.TextField{Name: "user", Required: true, Max: 255},
			&core.TextField{Name: "game", Required: true, Max: 255},
			&core.AutodateField{Name: "created", OnCreate: true},
		)
		col.AddIndex("idx_bump_votes_game", false, "game", "")
		col.AddIndex("idx_bump_votes_user_created", false, "user, created", "")
		col.AddIndex("idx_bump_votes_user_game", false, "user, game", "")
		if err := app.Save(col); err != nil {
			log.Printf("bump: failed to create %q (feature disabled): %v", bumpVotesColl, err)
			return
		}
		log.Printf("bump: created %q collection", bumpVotesColl)
	}

	if _, err := app.FindCollectionByNameOrId(bumpDrawsColl); err != nil {
		col := core.NewBaseCollection(bumpDrawsColl)
		col.Fields.Add(
			&core.TextField{Name: "game", Required: true, Max: 255},
			&core.AutodateField{Name: "drawn_at", OnCreate: true},
			&core.NumberField{Name: "ticket_count"},
			&core.NumberField{Name: "total_tickets"},
			&core.NumberField{Name: "total_games"},
		)
		col.AddIndex("idx_bump_draws_game_drawn", false, "game, drawn_at", "")
		// Public read of the winners history (stats page + lockout lookups).
		col.ListRule = types.Pointer("")
		col.ViewRule = types.Pointer("")
		if err := app.Save(col); err != nil {
			log.Printf("bump: failed to create %q: %v", bumpDrawsColl, err)
			return
		}
		log.Printf("bump: created %q collection", bumpDrawsColl)
	}

	if _, err := app.FindCollectionByNameOrId(bumpSettingsColl); err != nil {
		col := core.NewBaseCollection(bumpSettingsColl)
		col.Fields.Add(
			&core.BoolField{Name: "enabled"},
			&core.NumberField{Name: "interval_hours"},
			&core.NumberField{Name: "min_age_days"},
			&core.NumberField{Name: "win_lockout_days"},
			&core.NumberField{Name: "max_tickets_per_game"},
			&core.NumberField{Name: "vote_cooldown_hours"},
			&core.NumberField{Name: "withdraw_window_hours"},
			&core.DateField{Name: "next_draw_at"},
			&core.DateField{Name: "last_draw_at"},
		)
		if err := app.Save(col); err != nil {
			log.Printf("bump: failed to create %q: %v", bumpSettingsColl, err)
			return
		}
		log.Printf("bump: created %q collection", bumpSettingsColl)
	}
	// Seed the singleton row with sane defaults (disabled until a mod flips it).
	if recs, _ := app.FindRecordsByFilter(bumpSettingsColl, "", "", 1, 0); len(recs) == 0 {
		col, err := app.FindCollectionByNameOrId(bumpSettingsColl)
		if err != nil {
			return
		}
		rec := core.NewRecord(col)
		rec.Set("enabled", false)
		rec.Set("interval_hours", defBumpIntervalHours)
		rec.Set("min_age_days", defBumpMinAgeDays)
		rec.Set("win_lockout_days", defBumpWinLockoutDays)
		rec.Set("max_tickets_per_game", defBumpMaxPerGame)
		rec.Set("vote_cooldown_hours", defBumpVoteCooldownHrs)
		rec.Set("withdraw_window_hours", defBumpWithdrawHrs)
		if err := app.Save(rec); err != nil {
			log.Printf("bump: failed to seed %q singleton: %v", bumpSettingsColl, err)
		}
	}
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

// bumpInt reads a positive settings int, falling back to def when unset/≤0.
func bumpInt(s *core.Record, field string, def int) int {
	if v := s.GetInt(field); v > 0 {
		return v
	}
	return def
}

// bumpPBTime formats a time in PocketBase's stored layout for SQL binds.
func bumpPBTime(t time.Time) string {
	d, _ := types.ParseDateTime(t.UTC())
	return d.String()
}

func loadBumpSettings(app core.App) (*core.Record, error) {
	recs, err := app.FindRecordsByFilter(bumpSettingsColl, "", "", 1, 0)
	if err != nil {
		return nil, err
	}
	if len(recs) == 0 {
		return nil, apis.NewApiError(http.StatusServiceUnavailable, "bump settings missing", nil)
	}
	return recs[0], nil
}

// bumpEligibility reports whether a game may currently receive votes / be drawn.
// lockedUntil is set (non-zero) only when the game is inside its post-win lockout.
func bumpEligibility(app core.App, game, s *core.Record, now time.Time) (ok bool, reason string, lockedUntil time.Time) {
	// Games are soft-deleted via hidden=true; there is no separate `deleted`
	// field on the games collection (see main.go catalog listRule "hidden != true").
	if game.GetBool("hidden") {
		return false, "unavailable", time.Time{}
	}
	minAge := bumpInt(s, "min_age_days", defBumpMinAgeDays)
	eligibleAt := game.GetDateTime("created").Time().Add(time.Duration(minAge) * 24 * time.Hour)
	if now.Before(eligibleAt) {
		return false, "too_new", time.Time{}
	}
	lockoutDays := bumpInt(s, "win_lockout_days", defBumpWinLockoutDays)
	cutoff := now.Add(-time.Duration(lockoutDays) * 24 * time.Hour)
	rows := []struct {
		DrawnAt types.DateTime `db:"drawn_at"`
	}{}
	_ = app.DB().
		NewQuery("SELECT drawn_at FROM {{" + bumpDrawsColl + "}} WHERE game = {:g} AND drawn_at >= {:cut} ORDER BY drawn_at DESC LIMIT 1").
		Bind(dbx.Params{"g": game.Id, "cut": bumpPBTime(cutoff)}).
		All(&rows)
	if len(rows) > 0 {
		return false, "won_recently", rows[0].DrawnAt.Time().Add(time.Duration(lockoutDays) * 24 * time.Hour)
	}
	return true, "", time.Time{}
}

// bumpStatusJSON builds the full per-game widget payload. authID == "" ⇒ anon
// (personal fields omitted).
func bumpStatusJSON(app core.App, s, game *core.Record, authID string, now time.Time) map[string]any {
	tickets, _ := app.CountRecords(bumpVotesColl, dbx.HashExp{"game": game.Id})
	pool, _ := app.CountRecords(bumpVotesColl)
	eligible, reason, lockedUntil := bumpEligibility(app, game, s, now)

	resp := map[string]any{
		"tickets":      tickets,
		"pool_tickets": pool,
		"eligible":     eligible,
		"reason":       reason,
	}
	if nd := s.GetDateTime("next_draw_at").Time(); !nd.IsZero() {
		resp["next_draw_at"] = nd.UTC().Format(time.RFC3339)
	}
	if !lockedUntil.IsZero() {
		resp["locked_until"] = lockedUntil.UTC().Format(time.RFC3339)
	}
	if authID == "" {
		return resp
	}

	maxPer := bumpInt(s, "max_tickets_per_game", defBumpMaxPerGame)
	myTickets, _ := app.CountRecords(bumpVotesColl, dbx.HashExp{"user": authID, "game": game.Id})
	resp["my_tickets"] = myTickets
	resp["max_tickets"] = maxPer

	// Global 1-vote-per-cooldown gate: the most recent still-active ticket.
	cooldownHrs := bumpInt(s, "vote_cooldown_hours", defBumpVoteCooldownHrs)
	onCooldown := false
	if recent, _ := app.FindRecordsByFilter(bumpVotesColl, "user = {:u}", "-created", 1, 0, dbx.Params{"u": authID}); len(recent) > 0 {
		nextVote := recent[0].GetDateTime("created").Time().Add(time.Duration(cooldownHrs) * time.Hour)
		if now.Before(nextVote) {
			onCooldown = true
			resp["next_vote_at"] = nextVote.UTC().Format(time.RFC3339)
		}
	}
	// Withdraw window on THIS game (most recent ticket, if still retractable).
	withdrawHrs := bumpInt(s, "withdraw_window_hours", defBumpWithdrawHrs)
	if mine, _ := app.FindRecordsByFilter(bumpVotesColl, "user = {:u} && game = {:g}", "-created", 1, 0, dbx.Params{"u": authID, "g": game.Id}); len(mine) > 0 {
		until := mine[0].GetDateTime("created").Time().Add(time.Duration(withdrawHrs) * time.Hour)
		if now.Before(until) {
			resp["withdrawable_until"] = until.UTC().Format(time.RFC3339)
		}
	}
	resp["can_vote"] = eligible && int(myTickets) < maxPer && !onCooldown
	return resp
}

// ─── Draw ──────────────────────────────────────────────────────────────────────

// performDraw runs one roulette draw. Returns the winning game id ("" when there
// were no eligible tickets — a valid no-op).
func performDraw(app core.App, s *core.Record, now time.Time) (string, error) {
	var rows []struct {
		Game string `db:"game"`
		Cnt  int    `db:"cnt"`
	}
	if err := app.DB().
		NewQuery("SELECT game, COUNT(*) AS cnt FROM {{" + bumpVotesColl + "}} GROUP BY game").
		All(&rows); err != nil {
		return "", err
	}

	type cand struct {
		game    *core.Record
		tickets int
	}
	var elig []cand
	total := 0
	for _, r := range rows {
		g, err := app.FindRecordById("games", r.Game)
		if err != nil {
			continue // game gone — its dangling tickets are simply ignored
		}
		if ok, _, _ := bumpEligibility(app, g, s, now); !ok {
			continue
		}
		elig = append(elig, cand{g, r.Cnt})
		total += r.Cnt
	}
	if total == 0 {
		return "", nil
	}

	// Uniformly random ticket → its game wins (each ticket = equal chance).
	pick := rand.Intn(total)
	var winner *core.Record
	var winTickets int
	acc := 0
	for _, c := range elig {
		acc += c.tickets
		if pick < acc {
			winner, winTickets = c.game, c.tickets
			break
		}
	}
	if winner == nil {
		return "", nil
	}

	err := app.RunInTransaction(func(tx core.App) error {
		winner.Set("bumped_at", types.NowDateTime())
		if err := tx.Save(winner); err != nil {
			return err
		}
		drawsCol, err := tx.FindCollectionByNameOrId(bumpDrawsColl)
		if err != nil {
			return err
		}
		d := core.NewRecord(drawsCol)
		d.Set("game", winner.Id)
		d.Set("ticket_count", winTickets)
		d.Set("total_tickets", total)
		d.Set("total_games", len(elig))
		if err := tx.Save(d); err != nil {
			return err
		}
		// Winner's tickets are consumed (reset to 0); the 30d lockout is now
		// implied by the fresh bump_draws row.
		_, err = tx.DB().
			NewQuery("DELETE FROM {{" + bumpVotesColl + "}} WHERE game = {:g}").
			Bind(dbx.Params{"g": winner.Id}).
			Execute()
		return err
	})
	if err != nil {
		return "", err
	}
	return winner.Id, nil
}

// armBumpNext schedules the next draw and persists last_draw_at if it was set.
func armBumpNext(app core.App, s *core.Record, now time.Time) {
	interval := bumpInt(s, "interval_hours", defBumpIntervalHours)
	s.Set("next_draw_at", now.Add(time.Duration(interval)*time.Hour))
	if err := app.Save(s); err != nil {
		app.Logger().Error("bump: arm next failed", "error", err.Error())
	}
}

// bumpTick is the minute cron: draw when due, then re-arm. Mirrors publicationTick.
func bumpTick(app core.App) {
	s, err := loadBumpSettings(app)
	if err != nil {
		return // settings not ready yet
	}
	if !s.GetBool("enabled") {
		return
	}
	now := time.Now().UTC()
	next := s.GetDateTime("next_draw_at").Time()
	if next.IsZero() {
		armBumpNext(app, s, now)
		return
	}
	if now.Before(next) {
		return
	}

	winner, err := performDraw(app, s, now)
	if err != nil {
		app.Logger().Error("bump: draw failed", "error", err.Error())
	}
	if winner != "" {
		s.Set("last_draw_at", types.NowDateTime())
		catalogPurge.trigger(app) // surface the bump in the catalog immediately
		app.Logger().Info("bump: roulette winner", "game", winner)
	}
	armBumpNext(app, s, now)
}

// ─── Stats queries (shared by public /stats and mod /admin) ─────────────────────

type bumpStanding struct {
	ID      string `db:"id" json:"id"`
	Slug    string `db:"slug" json:"slug"` // pretty-URL key; link via slug||id
	Title   string `db:"title" json:"title"`
	Image   string `db:"image" json:"image"`
	Nsfw    bool   `db:"nsfw" json:"nsfw"`
	Tickets int    `db:"tickets" json:"tickets"`
}

type bumpWinner struct {
	ID           string         `db:"id" json:"id"`
	Slug         string         `db:"slug" json:"slug"` // pretty-URL key; link via slug||id
	Title        string         `db:"title" json:"title"`
	Image        string         `db:"image" json:"image"`
	DrawnAt      types.DateTime `db:"drawn_at" json:"drawn_at"`
	TicketCount  int            `db:"ticket_count" json:"ticket_count"`
	TotalTickets int            `db:"total_tickets" json:"total_tickets"`
}

// bumpNsfwTagIDs resolves the "nsfw"/"extreme" tag ids the same case-insensitive
// way the catalog does (buildCatalogScriptTag in main.go). NSFW is a *tag*, not a
// column on games, so standings derive the flag from each game's tags relation.
func bumpNsfwTagIDs(app core.App) (nsfw, extreme string) {
	recs, err := app.FindRecordsByFilter("tags", "id != ''", "", 0, 0)
	if err != nil {
		return "", ""
	}
	for _, t := range recs {
		switch strings.ToLower(t.GetString("name")) {
		case "nsfw":
			nsfw = t.Id
		case "extreme":
			extreme = t.Id
		}
	}
	return nsfw, extreme
}

func bumpStandings(app core.App, limit int) ([]bumpStanding, error) {
	// g.tags is the raw relation JSON (["tagid", …]); a substring check against
	// the 15-char tag id is a reliable membership test.
	var rows []struct {
		ID      string `db:"id"`
		Slug    string `db:"slug"`
		Title   string `db:"title"`
		Image   string `db:"image"`
		Tags    string `db:"tags"`
		Tickets int    `db:"tickets"`
	}
	err := app.DB().
		NewQuery(`
			SELECT v.game AS id,
			       COALESCE(g.slug, '') AS slug,
			       COALESCE(g.title, '') AS title,
			       COALESCE(g.image, '') AS image,
			       COALESCE(g.tags, '') AS tags,
			       COUNT(*) AS tickets
			FROM {{` + bumpVotesColl + `}} v
			LEFT JOIN {{games}} g ON g.id = v.game
			WHERE COALESCE(g.hidden, FALSE) = FALSE
			GROUP BY v.game
			ORDER BY tickets DESC, MIN(v.created) ASC
			LIMIT {:limit}
		`).
		Bind(dbx.Params{"limit": limit}).
		All(&rows)
	if err != nil {
		return nil, err
	}
	nsfwID, extremeID := bumpNsfwTagIDs(app)
	out := make([]bumpStanding, 0, len(rows))
	for _, r := range rows {
		nsfw := (nsfwID != "" && strings.Contains(r.Tags, nsfwID)) ||
			(extremeID != "" && strings.Contains(r.Tags, extremeID))
		out = append(out, bumpStanding{ID: r.ID, Slug: r.Slug, Title: r.Title, Image: r.Image, Nsfw: nsfw, Tickets: r.Tickets})
	}
	return out, nil
}

func bumpRecentWinners(app core.App, limit int) ([]bumpWinner, error) {
	out := []bumpWinner{}
	err := app.DB().
		NewQuery(`
			SELECT d.game AS id,
			       COALESCE(g.slug, '') AS slug,
			       COALESCE(g.title, '') AS title,
			       COALESCE(g.image, '') AS image,
			       d.drawn_at AS drawn_at,
			       d.ticket_count AS ticket_count,
			       d.total_tickets AS total_tickets
			FROM {{` + bumpDrawsColl + `}} d
			LEFT JOIN {{games}} g ON g.id = d.game
			ORDER BY d.drawn_at DESC
			LIMIT {:limit}
		`).
		Bind(dbx.Params{"limit": limit}).
		All(&out)
	return out, err
}

// ─── Registration ──────────────────────────────────────────────────────────────

func registerBumpRoulette(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		ensureBumpCollections(app)
		g := e.Router.Group("/api/custom")

		// ── Per-game widget status (public; auth optional for personal fields) ──
		g.GET("/bump/{id}", func(c *core.RequestEvent) error {
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			s, err := loadBumpSettings(app)
			if err != nil {
				return c.InternalServerError("Bump settings unavailable", err)
			}
			authID := "" // public endpoint: c.Auth is nil for anonymous callers
			if c.Auth != nil {
				authID = c.Auth.Id
			}
			return c.JSON(http.StatusOK, bumpStatusJSON(app, s, game, authID, time.Now().UTC()))
		})

		// ── Cast one ticket ─────────────────────────────────────────────────────
		g.POST("/bump/{id}/vote", func(c *core.RequestEvent) error {
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			s, err := loadBumpSettings(app)
			if err != nil {
				return c.InternalServerError("Bump settings unavailable", err)
			}
			if !s.GetBool("enabled") {
				return apis.NewApiError(http.StatusForbidden, "The bump roulette is currently closed.", nil)
			}
			now := time.Now().UTC()
			userID := c.Auth.Id

			if ok, reason, lockedUntil := bumpEligibility(app, game, s, now); !ok {
				msg := "This game can't be voted for right now."
				meta := map[string]any{"reason": reason}
				switch reason {
				case "too_new":
					msg = "A game can be voted for only 2 weeks after it's published."
				case "won_recently":
					msg = "This game recently won the roulette — voting reopens later."
					if !lockedUntil.IsZero() {
						meta["locked_until"] = lockedUntil.UTC().Format(time.RFC3339)
					}
				}
				return apis.NewApiError(http.StatusForbidden, msg, meta)
			}

			// Global cooldown (1 vote per window across all games).
			cooldownHrs := bumpInt(s, "vote_cooldown_hours", defBumpVoteCooldownHrs)
			if recent, _ := app.FindRecordsByFilter(bumpVotesColl, "user = {:u}", "-created", 1, 0, dbx.Params{"u": userID}); len(recent) > 0 {
				nextVote := recent[0].GetDateTime("created").Time().Add(time.Duration(cooldownHrs) * time.Hour)
				if now.Before(nextVote) {
					return apis.NewApiError(http.StatusTooManyRequests,
						"You can cast one vote per day. Come back tomorrow — or withdraw your last vote to move it.",
						map[string]any{"next_vote_at": nextVote.UTC().Format(time.RFC3339)})
				}
			}
			// Per-game cap.
			maxPer := bumpInt(s, "max_tickets_per_game", defBumpMaxPerGame)
			if n, _ := app.CountRecords(bumpVotesColl, dbx.HashExp{"user": userID, "game": game.Id}); int(n) >= maxPer {
				return apis.NewApiError(http.StatusTooManyRequests,
					"You've already given this game the maximum number of votes.", nil)
			}

			col, err := app.FindCollectionByNameOrId(bumpVotesColl)
			if err != nil {
				return c.InternalServerError("Vote failed", err)
			}
			rec := core.NewRecord(col)
			rec.Set("user", userID)
			rec.Set("game", game.Id)
			if err := app.Save(rec); err != nil {
				return c.InternalServerError("Failed to record vote", err)
			}
			return c.JSON(http.StatusOK, bumpStatusJSON(app, s, game, userID, now))
		}).Bind(apis.RequireAuth())

		// ── Withdraw the last ticket (only inside the retract window) ────────────
		g.POST("/bump/{id}/withdraw", func(c *core.RequestEvent) error {
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			s, err := loadBumpSettings(app)
			if err != nil {
				return c.InternalServerError("Bump settings unavailable", err)
			}
			now := time.Now().UTC()
			userID := c.Auth.Id
			mine, _ := app.FindRecordsByFilter(bumpVotesColl, "user = {:u} && game = {:g}", "-created", 1, 0, dbx.Params{"u": userID, "g": game.Id})
			if len(mine) == 0 {
				return c.BadRequestError("You have no vote to withdraw on this game.", nil)
			}
			withdrawHrs := bumpInt(s, "withdraw_window_hours", defBumpWithdrawHrs)
			until := mine[0].GetDateTime("created").Time().Add(time.Duration(withdrawHrs) * time.Hour)
			if !now.Before(until) {
				return apis.NewApiError(http.StatusConflict,
					"This vote is locked in — the 24-hour withdrawal window has passed.", nil)
			}
			if err := app.Delete(mine[0]); err != nil {
				return c.InternalServerError("Failed to withdraw vote", err)
			}
			return c.JSON(http.StatusOK, bumpStatusJSON(app, s, game, userID, now))
		}).Bind(apis.RequireAuth())

		// ── Public standings / stats page ───────────────────────────────────────
		g.GET("/bump/stats", func(c *core.RequestEvent) error {
			s, err := loadBumpSettings(app)
			if err != nil {
				return c.InternalServerError("Bump settings unavailable", err)
			}
			standings, err := bumpStandings(app, bumpStandingsLimit)
			if err != nil {
				return c.InternalServerError("Failed to load standings", err)
			}
			winners, err := bumpRecentWinners(app, bumpWinnersLimit)
			if err != nil {
				return c.InternalServerError("Failed to load winners", err)
			}
			pool, _ := app.CountRecords(bumpVotesColl)
			resp := map[string]any{
				"enabled":      s.GetBool("enabled"),
				"pool_tickets": pool,
				"standings":    standings,
				"winners":      winners,
			}
			if nd := s.GetDateTime("next_draw_at").Time(); !nd.IsZero() {
				resp["next_draw_at"] = nd.UTC().Format(time.RFC3339)
			}
			return c.JSON(http.StatusOK, resp)
		})

		// ── Moderator: read settings + extended stats ───────────────────────────
		g.GET("/bump/admin", func(c *core.RequestEvent) error {
			if !c.Auth.GetBool("isModerator") {
				return apis.NewForbiddenError("Moderators only", nil)
			}
			s, err := loadBumpSettings(app)
			if err != nil {
				return c.InternalServerError("Bump settings unavailable", err)
			}
			standings, _ := bumpStandings(app, bumpStandingsLimit)
			winners, _ := bumpRecentWinners(app, bumpWinnersLimit)
			pool, _ := app.CountRecords(bumpVotesColl)
			var voters struct {
				N int `db:"n"`
			}
			_ = app.DB().NewQuery("SELECT COUNT(DISTINCT user) AS n FROM {{" + bumpVotesColl + "}}").One(&voters)
			return c.JSON(http.StatusOK, map[string]any{
				"settings":     bumpSettingsJSON(s),
				"pool_tickets": pool,
				"voters":       voters.N,
				"standings":    standings,
				"winners":      winners,
			})
		}).Bind(apis.RequireAuth())

		// ── Moderator: update settings ──────────────────────────────────────────
		g.POST("/bump/admin", func(c *core.RequestEvent) error {
			if !c.Auth.GetBool("isModerator") {
				return apis.NewForbiddenError("Moderators only", nil)
			}
			s, err := loadBumpSettings(app)
			if err != nil {
				return c.InternalServerError("Bump settings unavailable", err)
			}
			payload := new(bumpAdminPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			if payload.Enabled != nil {
				s.Set("enabled", *payload.Enabled)
			}
			for field, val := range map[string]*int{
				"interval_hours":        payload.IntervalHours,
				"min_age_days":          payload.MinAgeDays,
				"win_lockout_days":      payload.WinLockoutDays,
				"max_tickets_per_game":  payload.MaxTicketsPerGame,
				"vote_cooldown_hours":   payload.VoteCooldownHours,
				"withdraw_window_hours": payload.WithdrawHours,
			} {
				if val != nil && *val > 0 {
					s.Set(field, *val)
				}
			}
			if payload.ResetNextDraw != nil && *payload.ResetNextDraw {
				armBumpNext(app, s, time.Now().UTC()) // saves s
			} else if err := app.Save(s); err != nil {
				return c.InternalServerError("Failed to save settings", err)
			}
			return c.JSON(http.StatusOK, map[string]any{"settings": bumpSettingsJSON(s)})
		}).Bind(apis.RequireAuth())

		// ── Moderator: run a draw now (manual / testing) ────────────────────────
		g.POST("/bump/admin/draw", func(c *core.RequestEvent) error {
			if !c.Auth.GetBool("isModerator") {
				return apis.NewForbiddenError("Moderators only", nil)
			}
			s, err := loadBumpSettings(app)
			if err != nil {
				return c.InternalServerError("Bump settings unavailable", err)
			}
			now := time.Now().UTC()
			winner, err := performDraw(app, s, now)
			if err != nil {
				return c.InternalServerError("Draw failed", err)
			}
			if winner != "" {
				s.Set("last_draw_at", types.NowDateTime())
				catalogPurge.trigger(app)
			}
			armBumpNext(app, s, now)
			return c.JSON(http.StatusOK, map[string]any{"winner": winner})
		}).Bind(apis.RequireAuth())

		return e.Next()
	})

	// Minute cron — draws when now ≥ next_draw_at (mirrors publication_queue).
	app.Cron().MustAdd("bump_roulette", "* * * * *", func() {
		bumpTick(app)
	})
}

// bumpAdminPayload — moderator-tunable settings (all optional; only sent fields change).
type bumpAdminPayload struct {
	Enabled           *bool `json:"enabled"`
	IntervalHours     *int  `json:"interval_hours"`
	MinAgeDays        *int  `json:"min_age_days"`
	WinLockoutDays    *int  `json:"win_lockout_days"`
	MaxTicketsPerGame *int  `json:"max_tickets_per_game"`
	VoteCooldownHours *int  `json:"vote_cooldown_hours"`
	WithdrawHours     *int  `json:"withdraw_window_hours"`
	ResetNextDraw     *bool `json:"reset_next_draw"`
}

func bumpSettingsJSON(s *core.Record) map[string]any {
	out := map[string]any{
		"enabled":               s.GetBool("enabled"),
		"interval_hours":        bumpInt(s, "interval_hours", defBumpIntervalHours),
		"min_age_days":          bumpInt(s, "min_age_days", defBumpMinAgeDays),
		"win_lockout_days":      bumpInt(s, "win_lockout_days", defBumpWinLockoutDays),
		"max_tickets_per_game":  bumpInt(s, "max_tickets_per_game", defBumpMaxPerGame),
		"vote_cooldown_hours":   bumpInt(s, "vote_cooldown_hours", defBumpVoteCooldownHrs),
		"withdraw_window_hours": bumpInt(s, "withdraw_window_hours", defBumpWithdrawHrs),
	}
	if nd := s.GetDateTime("next_draw_at").Time(); !nd.IsZero() {
		out["next_draw_at"] = nd.UTC().Format(time.RFC3339)
	}
	if ld := s.GetDateTime("last_draw_at").Time(); !ld.IsZero() {
		out["last_draw_at"] = ld.UTC().Format(time.RFC3339)
	}
	return out
}
