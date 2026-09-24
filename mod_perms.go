// Moderator permissions: which moderator may do what. `users.isModerator` was all-or-nothing, fine
// while the site author was the only moderator; with an external moderator some handlers (bump
// roulette, publication queue, granting rights) stay owner-only. Capability registry + one check
// point.
// Storage: separate `mod_permissions` collection (one row per moderator), NOT a users field — so
// prod schema isn't touched; it self-creates at startup like game_views. Server-only writes; a user
// reads only their own row.
// No row = FULL access (legacy) — otherwise deploying the binary would silently lock the author out
// of her own site. /moderator/access shows them as "full access (legacy)". `_superusers` tokens
// (our automation) always pass.
package main

import (
	"log"
	"net/http"
	"sort"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const modPermsColl = "mod_permissions"

// Stored in mod_permissions.perms as a string array; "*" = everything.
const (
	permAll          = "*"
	permCards        = "cards"
	permComments     = "comments"
	permTickets      = "tickets"
	permTags         = "tags"
	permReview       = "review"
	permHosting      = "hosting"
	permHostingPurge = "hosting_purge"
	permChat         = "chat"
	permQueue        = "queue"
	permRoulette     = "roulette"
	permStats        = "stats"
	permPerms        = "perms"
	permModUpload    = "mod_upload"
)

type modCapability struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Note  string `json:"note"`
}

var modCapabilities = []modCapability{
	{permCards, "Game cards", "Edit, bump, hide and revert catalogue cards"},
	{permComments, "Comments", "Delete and pin other people's comments"},
	{permTickets, "Mod tickets", "Change status, kind, assignee and internal notes"},
	{permTags, "Tag votes", "Accept or remove a tag as a moderator decision"},
	{permReview, "Review queue", "The pipeline review gate: approve, reject, edit staged games"},
	{permHosting, "Hosting", "Block, restore, re-upload and roll back hosted games"},
	{permHostingPurge, "Hosting: purge", "Permanently delete hosted files from R2 — irreversible"},
	{permChat, "Chat", "Delete and pin messages, mute users, manage rooms and emoji"},
	{permQueue, "Publication queue", "Drip-feed settings, publish now, dismiss or approve items"},
	{permRoulette, "Bump roulette", "Roulette settings and forcing a draw"},
	{permStats, "View stats", "First-party per-game view counters"},
	{permPerms, "Moderator access", "Hand out the permissions on this page"},
	{permModUpload, "Mod uploads", "Helper app: download games, create reserved author accounts, upload to hosting, submit new cards to the publication queue"},
}

var modPermApp core.App

// Non-fatal: on failure log and stay on legacy behaviour (every moderator full access); never block
// server boot.
func ensureModPermissionsCollection(app core.App) {
	if _, err := app.FindCollectionByNameOrId(modPermsColl); err == nil {
		return
	}
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		log.Printf("mod_perms: users collection not found, %q not created: %v", modPermsColl, err)
		return
	}

	col := core.NewBaseCollection(modPermsColl)
	col.Fields.Add(
		&core.RelationField{
			Name: "user", Required: true, CollectionId: users.Id,
			MaxSelect: 1, CascadeDelete: true,
		},
		&core.JSONField{Name: "perms", MaxSize: 4000},
		&core.TextField{Name: "note", Max: 500},
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
	)
	col.AddIndex("idx_mod_permissions_user", true, "user", "")

	own := "@request.auth.id != \"\" && user = @request.auth.id"
	col.ListRule = &own
	col.ViewRule = &own
	col.CreateRule = nil
	col.UpdateRule = nil
	col.DeleteRule = nil

	if err := app.Save(col); err != nil {
		log.Printf("mod_perms: failed to create %q (permissions stay wide open): %v", modPermsColl, err)
		return
	}
	log.Printf("mod_perms: created %q collection", modPermsColl)
}

func modPermsRecord(app core.App, userID string) *core.Record {
	if app == nil || userID == "" {
		return nil
	}
	rec, err := app.FindFirstRecordByFilter(modPermsColl, "user = {:u}", dbx.Params{"u": userID})
	if err != nil {
		return nil
	}
	return rec
}

func modPermsList(rec *core.Record) []string {
	if rec == nil {
		return nil
	}
	var out []string
	for _, v := range rec.GetStringSlice("perms") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// authHasPerm is the single source of truth.
func authHasPerm(auth *core.Record, capability string) bool {
	if auth == nil {
		return false
	}
	if auth.Collection() != nil && auth.Collection().Name == core.CollectionNameSuperusers {
		return true
	}
	if !auth.GetBool("isModerator") {
		return false
	}
	rec := modPermsRecord(modPermApp, auth.Id)
	if rec == nil {
		return true
	}
	for _, p := range modPermsList(rec) {
		if p == permAll || p == capability {
			return true
		}
	}
	return false
}

func hasPerm(c *core.RequestEvent, capability string) bool {
	if c == nil {
		return false
	}
	return authHasPerm(c.Auth, capability)
}

func requirePerm(capability string, fn func(*core.RequestEvent) error) func(*core.RequestEvent) error {
	return func(c *core.RequestEvent) error {
		if !hasPerm(c, capability) {
			return c.ForbiddenError("You don't have the \""+capability+"\" moderator permission.", nil)
		}
		return fn(c)
	}
}

func knownCapability(key string) bool {
	if key == permAll {
		return true
	}
	for _, cap := range modCapabilities {
		if cap.Key == key {
			return true
		}
	}
	return false
}

type modPermsRow struct {
	UserID   string   `json:"user_id"`
	Username string   `json:"username"`
	Avatar   string   `json:"avatar"`
	Perms    []string `json:"perms"`
	Legacy   bool     `json:"legacy"`
	Note     string   `json:"note"`
	Updated  string   `json:"updated"`
}

func registerModPerms(app *pocketbase.PocketBase) {
	// Set immediately, not in OnServe: checks live in other files and must not depend on hook
	// registration order.
	modPermApp = app

	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		ensureModPermissionsCollection(app)

		g := e.Router.Group("/api/custom")

		g.GET("/mod/perms/me", func(c *core.RequestEvent) error {
			resp := map[string]any{
				"is_moderator": false,
				"perms":        []string{},
				"capabilities": modCapabilities,
			}
			if c.Auth == nil {
				return c.JSON(http.StatusOK, resp)
			}
			superuser := c.Auth.Collection() != nil && c.Auth.Collection().Name == core.CollectionNameSuperusers
			if !superuser && !c.Auth.GetBool("isModerator") {
				return c.JSON(http.StatusOK, resp)
			}
			resp["is_moderator"] = true

			granted := []string{}
			for _, cap := range modCapabilities {
				if authHasPerm(c.Auth, cap.Key) {
					granted = append(granted, cap.Key)
				}
			}
			resp["perms"] = granted
			resp["legacy"] = !superuser && modPermsRecord(app, c.Auth.Id) == nil
			return c.JSON(http.StatusOK, resp)
		}).Bind(apis.RequireAuth())

		g.GET("/mod/perms", requirePerm(permPerms, func(c *core.RequestEvent) error {
			users, err := app.FindRecordsByFilter(
				"users", "isModerator = true", "username", 0, 0)
			if err != nil {
				return c.InternalServerError("Failed to list moderators", err)
			}
			rows := make([]modPermsRow, 0, len(users))
			for _, u := range users {
				rec := modPermsRecord(app, u.Id)
				row := modPermsRow{
					UserID:   u.Id,
					Username: u.GetString("username"),
					Avatar:   u.GetString("avatar"),
					Perms:    modPermsList(rec),
					Legacy:   rec == nil,
				}
				if row.Perms == nil {
					row.Perms = []string{}
				}
				if rec != nil {
					row.Note = rec.GetString("note")
					row.Updated = rec.GetString("updated")
				}
				rows = append(rows, row)
			}
			sort.Slice(rows, func(i, j int) bool {
				return strings.ToLower(rows[i].Username) < strings.ToLower(rows[j].Username)
			})
			return c.JSON(http.StatusOK, map[string]any{
				"capabilities": modCapabilities,
				"moderators":   rows,
			})
		})).Bind(apis.RequireAuth())

		g.POST("/mod/perms", requirePerm(permPerms, func(c *core.RequestEvent) error {
			var p struct {
				User  string   `json:"user"`
				Perms []string `json:"perms"`
				Note  string   `json:"note"`
			}
			if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.User) == "" {
				return c.BadRequestError("Missing user", err)
			}
			target, err := app.FindRecordById("users", p.User)
			if err != nil {
				return c.NotFoundError("User not found", err)
			}
			if !target.GetBool("isModerator") {
				return c.BadRequestError("That user is not a moderator", nil)
			}

			seen := map[string]bool{}
			clean := []string{}
			for _, raw := range p.Perms {
				key := strings.TrimSpace(raw)
				if key == "" || seen[key] {
					continue
				}
				if !knownCapability(key) {
					return c.BadRequestError("Unknown permission: "+key, nil)
				}
				seen[key] = true
				clean = append(clean, key)
			}
			if seen[permAll] {
				clean = []string{permAll}
			}

			rec := modPermsRecord(app, target.Id)
			var before any
			if rec == nil {
				col, err := app.FindCollectionByNameOrId(modPermsColl)
				if err != nil {
					return c.InternalServerError("Permissions collection is missing", err)
				}
				rec = core.NewRecord(col)
				rec.Set("user", target.Id)
				before = map[string]any{"perms": nil, "legacy": true}
			} else {
				before = map[string]any{"perms": modPermsList(rec), "legacy": false}
			}
			rec.Set("perms", clean)
			rec.Set("note", strings.TrimSpace(p.Note))
			if err := app.Save(rec); err != nil {
				return c.InternalServerError("Failed to save permissions", err)
			}

			logModAction(app, c, modAction{
				Action:     "perms.update",
				Target:     target.Id + " " + target.GetString("username"),
				Before:     before,
				After:      map[string]any{"perms": clean},
				Reversible: true,
				Note:       strings.TrimSpace(p.Note),
			})

			return c.JSON(http.StatusOK, map[string]any{
				"user_id": target.Id,
				"perms":   clean,
				"legacy":  false,
			})
		})).Bind(apis.RequireAuth())

		return e.Next()
	})
}
