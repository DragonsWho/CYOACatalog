package main

// Edge whitespace in titles is an invisible duplicate source: "The Unseen Trial " vs "The Unseen
// Trial" are one game to a human but two for a PB `title="…"` filter — merge_games found a group of
// one, and exact lookups (tag map, queue dedup, catalog reconciliation) break too. Fixing every
// input path is futile (many, and more coming), so normalize once on DB write — every path through
// PocketBase lands here. Rule is deliberately NARROW: trim edges and collapse internal whitespace
// only. Never touch case, punctuation or emoji — that's editing someone's title, not hygiene.
import (
	"regexp"
	"strings"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// title fields to normalize: collection → field
var trimmedNameFields = map[string]string{
	"games":   "title",
	"authors": "name",
	"tags":    "name",
}

// Go's \s doesn't cover NBSP/zero-width — list the invisibles explicitly.
var innerSpaceRe = regexp.MustCompile("[\\s\u00a0\u200b\ufeff]+")

// Collapse any whitespace run to one space and trim. Copy-paste invisibles (NBSP, zero-width, BOM)
// count as whitespace: visually identical, and exact filters diverge on them just like a trailing
// space.
func normalizeName(s string) string {
	return strings.TrimSpace(innerSpaceRe.ReplaceAllString(s, " "))
}

// Must be registered BEFORE registerGameEdits: the games-create hook must run before slug minting
// (PB hook order = BindFunc order). slugifyGame trims anyway, so this is predictability, not
// correctness.
func registerNameTrim(app *pocketbase.PocketBase) {
	for coll, field := range trimmedNameFields {
		coll, field := coll, field
		trim := func(e *core.RecordEvent) error {
			raw := e.Record.GetString(field)
			if clean := normalizeName(raw); clean != raw {
				e.Record.Set(field, clean)
				e.App.Logger().Info("name trimmed",
					"collection", coll, "record", e.Record.Id,
					"from", raw, "to", clean)
			}
			return e.Next()
		}
		app.OnRecordCreate(coll).BindFunc(trim)
		app.OnRecordUpdate(coll).BindFunc(trim)
	}
}
