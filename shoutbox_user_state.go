// Personal chat state that must follow the user across devices (author decisions 2026-08-13): notes
// about people (your alias for them + private text), pinned conversations and their order, "read up
// to" per room. All three in ONE record per user, three JSON fields. Why not fields on `users`: its
// viewRule = "" (public) — anyone can read the whole record; the fields whitelist is frontend-only,
// so private notes would leak. Why not a row per (user, room): dozens of rows and UPDATEs per
// "read"; and not shoutbox_channel_prefs — its cache pulls ALL rows of a room on every send. Cost:
// ZERO new HTTP requests — state rides as a `state` block in GET /channels, read marks piggyback on
// POST /ping?chat=1 (sent once a minute anyway). DB write at most once a minute per user and only
// if marks changed. Collection closed to the outside (Go superuser only). Notes are visible ONLY to
// their author; no handler ever reveals "how others labeled me".
package main

import (
	"net/http"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

const (
	shoutStateCol = "shoutbox_user_state"

	// Notes cap (a dozen people you confuse, not a card index; also stops megabyte JSON).
	shoutNotesMax = 200
	// Alias replaces the name in the feed/lists — must fit where a name fits.
	shoutAliasMax = 32
	shoutNoteMax  = 280

	shoutPinsMax = 30

	// Read-marks cap; oldest dropped first (worst case: one extra "new" dot on an ancient DM).
	shoutReadsMax = 500
)

// Short keys ("a", "n") on purpose: the whole map goes to the frontend on every chat open.
type shoutNote struct {
	Alias string `json:"a,omitempty"`
	Note  string `json:"n,omitempty"`
}

// Same struct for DB and frontend: JSON columns hold exactly what goes to the browser.
type shoutUserState struct {
	Notes map[string]shoutNote `json:"notes,omitempty"`
	Pins  []string             `json:"pins,omitempty"`
	Reads map[string]int64     `json:"reads,omitempty"`
}

// Second return = "no record" — valid and most common; don't create empty rows.
func shoutStateRecord(app core.App, uid string) *core.Record {
	if uid == "" {
		return nil
	}
	rec, err := app.FindFirstRecordByFilter(shoutStateCol, "user = {:u}",
		dbx.Params{"u": uid})
	if err != nil {
		return nil
	}
	return rec
}

// No record or no collection (schema not applied) → empty state, not an error.
func shoutStateOf(app core.App, uid string) shoutUserState {
	out := shoutUserState{}
	rec := shoutStateRecord(app, uid)
	if rec == nil {
		return out
	}
	_ = rec.UnmarshalJSONField("notes", &out.Notes)
	_ = rec.UnmarshalJSONField("pins", &out.Pins)
	_ = rec.UnmarshalJSONField("reads", &out.Reads)
	return out
}

func shoutStateSave(app core.App, uid string, apply func(*shoutUserState)) error {
	rec := shoutStateRecord(app, uid)
	st := shoutUserState{}
	if rec != nil {
		_ = rec.UnmarshalJSONField("notes", &st.Notes)
		_ = rec.UnmarshalJSONField("pins", &st.Pins)
		_ = rec.UnmarshalJSONField("reads", &st.Reads)
	} else {
		coll, err := app.FindCollectionByNameOrId(shoutStateCol)
		if err != nil {
			return err
		}
		rec = core.NewRecord(coll)
		rec.Set("user", uid)
	}
	apply(&st)

	// Write an empty map, not nil: JSON `null` reads back as "no field", losing "removed all notes" vs
	// "never wrote".
	if st.Notes == nil {
		st.Notes = map[string]shoutNote{}
	}
	if st.Pins == nil {
		st.Pins = []string{}
	}
	if st.Reads == nil {
		st.Reads = map[string]int64{}
	}
	rec.Set("notes", st.Notes)
	rec.Set("pins", st.Pins)
	rec.Set("reads", st.Reads)
	return app.Save(rec)
}

// Single-line text: strip control chars (including newline) and cut by RUNES, not bytes. A newline
// in an alias would break the feed layout.
func shoutCleanLine(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' || unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
		s = strings.TrimSpace(s)
	}
	return s
}

func shoutCleanNote(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' {
			return r
		}
		if r == '\r' {
			return -1
		}
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
		s = strings.TrimSpace(s)
	}
	return s
}

// Merge takes the LARGER mark: "read up to" only grows, so a phone idle since last week can't roll
// back what was read on the laptop. Returns whether anything changed — if not, no DB write at all
// (the whole point of piggybacking on the ping).
func shoutMergeReads(cur map[string]int64, in map[string]int64) (map[string]int64, bool) {
	if len(in) == 0 {
		return cur, false
	}
	if cur == nil {
		cur = map[string]int64{}
	}
	changed := false
	for ch, at := range in {
		// PB ids are 15 chars; longer isn't from our frontend. Reject negative/absurd times too (the map
		// is sent back and counts unread).
		if ch == "" || len(ch) > 20 || at <= 0 || at > 1<<40 {
			continue
		}
		if at > cur[ch] {
			cur[ch] = at
			changed = true
		}
	}
	if !changed {
		return cur, false
	}
	if len(cur) > shoutReadsMax {
		type kv struct {
			ch string
			at int64
		}
		all := make([]kv, 0, len(cur))
		for ch, at := range cur {
			all = append(all, kv{ch, at})
		}
		sort.Slice(all, func(i, j int) bool { return all[i].at > all[j].at })
		trimmed := make(map[string]int64, shoutReadsMax)
		for _, e := range all[:shoutReadsMax] {
			trimmed[e.ch] = e.at
		}
		cur = trimmed
	}
	return cur, true
}

// Device sends its marks and gets the merged map back ONLY if it lagged behind. nil = "you already
// know everything".
func shoutSyncReads(app core.App, uid string, in map[string]int64) map[string]int64 {
	if uid == "" || len(in) == 0 {
		return nil
	}
	st := shoutStateOf(app, uid)
	merged, changed := shoutMergeReads(st.Reads, in)
	if changed {
		// Save re-merges: a ping from another device may land between read and write; its marks must not
		// be lost.
		_ = shoutStateSave(app, uid, func(s *shoutUserState) {
			s.Reads, _ = shoutMergeReads(s.Reads, in)
		})
	}
	for ch, at := range merged {
		if at > in[ch] {
			return merged
		}
	}
	return nil
}

func registerShoutboxUserState(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	registerChatAttention(app, g)

	// GET /state removed 2026-09-17 (nobody called it); state arrives via GET /channels and the ping.
	// Empty alias and text = delete the entry.
	g.POST("/note", func(c *core.RequestEvent) error {
		var p struct {
			User  string `json:"user"`
			Alias string `json:"alias"`
			Note  string `json:"note"`
		}
		if err := c.BindBody(&p); err != nil {
			return c.BadRequestError("Invalid body", err)
		}
		peer := strings.TrimSpace(p.User)
		if peer == "" {
			return c.BadRequestError("Missing user", nil)
		}
		if peer == c.Auth.Id {
			// No note on yourself: the alias replaces your name in the feed and you'd then ask support "why
			// is my name wrong".
			return c.BadRequestError("Can't take notes on yourself", nil)
		}
		if _, err := app.FindRecordById("users", peer); err != nil {
			return c.NotFoundError("User not found", err)
		}
		alias := shoutCleanLine(p.Alias, shoutAliasMax)
		note := shoutCleanNote(p.Note, shoutNoteMax)

		var full bool
		err := shoutStateSave(app, c.Auth.Id, func(s *shoutUserState) {
			if alias == "" && note == "" {
				delete(s.Notes, peer)
				return
			}
			if s.Notes == nil {
				s.Notes = map[string]shoutNote{}
			}
			if _, exists := s.Notes[peer]; !exists && len(s.Notes) >= shoutNotesMax {
				full = true
				return
			}
			s.Notes[peer] = shoutNote{Alias: alias, Note: note}
		})
		if full {
			return c.BadRequestError("You have too many notes saved.", nil)
		}
		if err != nil {
			return c.InternalServerError("Failed to save the note", err)
		}
		return c.JSON(http.StatusOK, map[string]any{
			"ok": true, "alias": alias, "note": note,
		})
	}).Bind(apis.RequireAuth())

	// Pins as the whole list, not "pin one": pin/unpin/drag act on ONE order; separate handlers desync
	// on the first double click.
	g.POST("/pins", func(c *core.RequestEvent) error {
		var p struct {
			Pins []string `json:"pins"`
		}
		if err := c.BindBody(&p); err != nil {
			return c.BadRequestError("Invalid body", err)
		}
		if len(p.Pins) > shoutPinsMax {
			return c.BadRequestError("Too many pinned conversations.", nil)
		}
		// Only pin what the user can already see, else pins become a probe for private-room existence
		// (same trick as /notify-prefs). One query for the whole list.
		visible := map[string]bool{}
		if chans, err := shoutVisibleChannels(app, c.Auth.Id); err == nil {
			for _, ch := range chans {
				visible[ch.ID] = true
			}
		}
		// User topics are excluded from shoutVisibleChannels (thousands would flood the menu), so topic
		// pins are allowed separately: one query by id, own sub-cap shoutCommunityPinsMax. Topics are
		// public, so no existence leak.
		wanted := make([]string, 0, len(p.Pins))
		seen := map[string]bool{}
		for _, id := range p.Pins {
			id = strings.TrimSpace(id)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			wanted = append(wanted, id)
		}
		unknown := make([]string, 0, len(wanted))
		for _, id := range wanted {
			if !visible[id] {
				unknown = append(unknown, id)
			}
		}
		isThread := map[string]bool{}
		if len(unknown) > 0 {
			if recs, err := app.FindRecordsByIds(shoutChannelsCol, unknown); err == nil {
				for _, r := range recs {
					if r.GetBool("enabled") && !r.GetBool("is_private") &&
						!r.GetBool("is_dm") && shoutCommunityIsThread(r) {
						isThread[r.Id] = true
					}
				}
			}
		}
		clean := make([]string, 0, len(wanted))
		threads := 0
		for _, id := range wanted {
			if visible[id] {
				clean = append(clean, id)
				continue
			}
			if !isThread[id] || threads >= shoutCommunityPinsMax {
				continue
			}
			threads++
			clean = append(clean, id)
		}
		if err := shoutStateSave(app, c.Auth.Id, func(s *shoutUserState) {
			s.Pins = clean
		}); err != nil {
			return c.InternalServerError("Failed to save pinned conversations", err)
		}
		// The topics personal block is cached for a minute; drop it after the user's own pin, or F5 shows
		// the pin "late". Same reason as shoutMine.forget after one's own post.
		shoutMine.forget(c.Auth.Id)
		return c.JSON(http.StatusOK, map[string]any{"ok": true, "pins": clean})
	}).Bind(apis.RequireAuth())
}
