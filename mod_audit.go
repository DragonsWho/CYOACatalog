// Moderator action journal (`mod_actions`): who did what to what, before/after — so any moderator
// action can be reverted by hand. Rights: wiki/components/moderator-access.md. Properties:
// append-only (no create/update/delete rules; written via privileged `app`); best-effort — a write
// failure is logged and NEVER fails the action; no-op if the collection is missing (binary runs
// fine before PB/create_mod_actions.py); written only when the actor really is a moderator (owners
// using /comments/delete don't land here).
package main

import (
	"log"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const modActionsCollection = "mod_actions"

// Collection looked up once (logger sits on hot handlers); `missing` latches. Consequence: deploy
// order is PB/create_mod_actions.py FIRST, then binary. Creating the collection on a live process
// enables the journal only after restart.
var (
	modActionsOnce    sync.Once
	modActionsColl    *core.Collection
	modActionsMissing bool
)

func modActionsCollectionOf(app core.App) *core.Collection {
	modActionsOnce.Do(func() {
		coll, err := app.FindCollectionByNameOrId(modActionsCollection)
		if err != nil {
			modActionsMissing = true
			log.Printf("mod_audit: collection %q missing, moderator actions will not be journaled: %v",
				modActionsCollection, err)
			return
		}
		modActionsColl = coll
	})
	if modActionsMissing {
		return nil
	}
	return modActionsColl
}

// Action = stable machine code `<subsystem>.<verb>` ("comment.delete", "tag.mod_override",
// "hosting.block") — journal filters and reverts key off it. Before/After = minimal snapshot needed
// to revert, not the whole object. Reversible=false for irreversible actions (file purge, hard
// delete).
type modAction struct {
	Action     string
	Target     string
	Game       string
	Before     any
	After      any
	Reversible bool
	Note       string
}

// Called AFTER the action succeeded (records facts, not intent). Never returns an error.
func logModAction(app core.App, c *core.RequestEvent, a modAction) {
	if c == nil || c.Auth == nil || !c.Auth.GetBool("isModerator") {
		return
	}
	coll := modActionsCollectionOf(app)
	if coll == nil {
		return
	}

	rec := core.NewRecord(coll)
	rec.Set("actor", c.Auth.Id)
	rec.Set("action", trimModField(a.Action, 64))
	rec.Set("target", trimModField(a.Target, 200))
	if a.Game != "" {
		rec.Set("game", a.Game)
	}
	if a.Before != nil {
		rec.Set("before", a.Before)
	}
	if a.After != nil {
		rec.Set("after", a.After)
	}
	rec.Set("reversible", a.Reversible)
	rec.Set("note", trimModField(a.Note, 2000))
	if c.Request != nil {
		rec.Set("ip", trimModField(requestIP(c.Request), 64))
	}

	if err := app.Save(rec); err != nil {
		log.Printf("mod_audit: failed to journal %q by %s: %v", a.Action, c.Auth.Id, err)
	}
}

// PB rejects values over the field max (validation error, not truncation) — trim first.
func trimModField(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}

func modSnapshot(rec *core.Record, fields ...string) map[string]any {
	if rec == nil {
		return nil
	}
	out := make(map[string]any, len(fields))
	for _, f := range fields {
		out[f] = rec.Get(f)
	}
	return out
}

func modWhen(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func commentDeleteNote(comment *core.Record) string {
	if comment.GetBool("deleted") {
		return "tombstoned (thread has replies); restore by putting content back and clearing `deleted`"
	}
	return "hard-deleted (leaf comment); restore by re-creating the record from `before`"
}

func gameIDOf(game *core.Record) string {
	if game == nil {
		return ""
	}
	return game.Id
}

// Collections the moderator panel edits DIRECTLY via the PB SDK (rules allow it), bypassing Go
// endpoints. Record-request hooks fire on human REST requests only; server-side app.Save doesn't
// trigger them, so pipeline/harvester don't flood the journal.
var modDirectWriteCollections = []string{
	"game_relationships",
	"asset_fingerprints",
}

// Written AFTER e.Next(): a request failing rules/validation leaves no entry.
func registerModAuditHooks(app core.App) {
	for _, name := range modDirectWriteCollections {
		coll := name

		app.OnRecordCreateRequest(coll).BindFunc(func(e *core.RecordRequestEvent) error {
			if err := e.Next(); err != nil {
				return err
			}
			logModAction(app, e.RequestEvent, modAction{
				Action:     coll + ".create",
				Target:     e.Record.Id,
				Game:       modRelatedGame(e.Record),
				After:      modRecordFields(e.Record),
				Reversible: true,
				Note:       "direct REST write from the moderator panel; undo = delete the record",
			})
			return nil
		})

		app.OnRecordUpdateRequest(coll).BindFunc(func(e *core.RecordRequestEvent) error {
			// Snapshot before form submit: e.Next() overwrites the record.
			before := modRecordFields(e.Record)
			if err := e.Next(); err != nil {
				return err
			}
			logModAction(app, e.RequestEvent, modAction{
				Action:     coll + ".update",
				Target:     e.Record.Id,
				Game:       modRelatedGame(e.Record),
				Before:     before,
				After:      modRecordFields(e.Record),
				Reversible: true,
			})
			return nil
		})

		app.OnRecordDeleteRequest(coll).BindFunc(func(e *core.RecordRequestEvent) error {
			before := modRecordFields(e.Record)
			gameID := modRelatedGame(e.Record)
			id := e.Record.Id
			if err := e.Next(); err != nil {
				return err
			}
			logModAction(app, e.RequestEvent, modAction{
				Action:     coll + ".delete",
				Target:     id,
				Game:       gameID,
				Before:     before,
				Reversible: true,
				Note:       "undo = re-create the record from `before`",
			})
			return nil
		})
	}
}

func modRecordFields(rec *core.Record) map[string]any {
	if rec == nil {
		return nil
	}
	out := map[string]any{}
	for _, f := range rec.Collection().Fields {
		switch f.Type() {
		case "autodate":
			continue
		}
		out[f.GetName()] = rec.Get(f.GetName())
	}
	delete(out, "id")
	return out
}

func modRelatedGame(rec *core.Record) string {
	if rec == nil {
		return ""
	}
	for _, f := range []string{"game", "source", "gameId"} {
		if v := rec.GetString(f); v != "" {
			return v
		}
	}
	return ""
}
