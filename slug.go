package main

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"golang.org/x/text/unicode/norm"
)

// Pretty game URLs. A game is addressed by /game/<slug>, slug derived from title.
// This file owns slug minting (create hook + rename) and the redirect-history
// aliases. Backfill of existing games is done once by PB/backfill_slugs.py.

const maxSlugLen = 80

var nonSlugChars = regexp.MustCompile(`[^a-z0-9]+`)

// slugifyGame converts a game title to a URL slug. It MUST stay byte-identical to
// PB/slugify.py — both this Go path and the Python pipeline mint slugs, and any
// drift would fork a game's canonical URL. Algorithm (same four steps as Python):
//  1. NFKD-normalize and drop combining marks  → é→e, ñ→n, ﬁ→fi, Ａ→a.
//  2. lowercase.
//  3. collapse every run of non-[a-z0-9] to a single hyphen.
//  4. trim edge hyphens, cap length.
//
// A title with no Latin letters (Cyrillic/CJK/emoji) collapses to "" — the caller
// then leaves the record id as the URL key. (Python strips by combining CLASS;
// Go drops category Mn. They agree on every Latin diacritic, which is all the
// catalog has — 0 non-Latin slugs on prod — and both yield "" for non-Latin.)
func slugifyGame(title string) string {
	if title == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range norm.NFKD.String(title) {
		if unicode.Is(unicode.Mn, r) { // nonspacing combining mark — drop it
			continue
		}
		b.WriteRune(r)
	}
	s := strings.ToLower(b.String())
	s = nonSlugChars.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > maxSlugLen { // s is pure ASCII here, so byte len == rune count
		s = strings.TrimRight(s[:maxSlugLen], "-")
	}
	return s
}

// legacyIDRe matches a PocketBase record id: exactly 15 lowercase alphanumerics.
// A one-word 15-char slug looks identical, so an id-shaped key is tried as an id
// first and falls back to a slug lookup — same order as the frontend's
// resolveGameByParam(), so both resolve every URL to the same record.
var legacyIDRe = regexp.MustCompile(`^[a-z0-9]{15}$`)

// findGameByURLKey resolves a /game/<key> URL segment to its record, mirroring the
// frontend's three tiers: legacy record id → current slug → retired slug (alias).
// Returns nil when nothing matches. Server-side rendering (OG meta, sitemap) needs
// this because the crawler only ever sees the URL, never the client resolution.
//
// Hidden games are skipped in the first two tiers: PB rules ('hidden != true') do
// not apply to app-level lookups, so without the check a merged-away duplicate
// would still answer for its own id/slug here while the browser (rule-gated) falls
// through to the alias — and the crawler would get a card for a page users can't
// open. Skipping lets the alias tier point both at the keeper.
func findGameByURLKey(app core.App, key string) *core.Record {
	if key == "" {
		return nil
	}
	if legacyIDRe.MatchString(key) {
		if rec, err := app.FindRecordById("games", key); err == nil && !rec.GetBool("hidden") {
			return rec
		}
	}
	if rec, _ := app.FindFirstRecordByFilter(
		"games", "slug = {:s}", dbx.Params{"s": key},
	); rec != nil && !rec.GetBool("hidden") {
		return rec
	}
	if alias, _ := app.FindFirstRecordByFilter(
		"game_slug_aliases", "slug = {:s}", dbx.Params{"s": key},
	); alias != nil {
		if rec, err := app.FindRecordById("games", alias.GetString("game")); err == nil {
			return rec
		}
	}
	return nil
}

// gameURLKey is the canonical URL key for a game: its slug when set, else the
// record id (collision/non-Latin titles keep id URLs). Go twin of the frontend's
// gameCanonicalKey().
func gameURLKey(rec *core.Record) string {
	if s := rec.GetString("slug"); s != "" {
		return s
	}
	return rec.Id
}

// gameSlugTaken reports whether another game already holds this slug (excludeID
// lets a rename ignore itself).
func gameSlugTaken(app core.App, slug, excludeID string) bool {
	var dummy int
	err := app.ConcurrentDB().
		Select("(1)").
		From("games").
		AndWhere(dbx.NewExp("slug = {:s}", dbx.Params{"s": slug})).
		AndWhere(dbx.NewExp("id != {:id}", dbx.Params{"id": excludeID})).
		Limit(1).
		Row(&dummy)
	return err == nil && dummy > 0
}

// uniqueGameSlug returns base, or base-2/base-3/… until free — same collision rule
// as PB/backfill_slugs.py (the earlier record keeps the clean slug). An empty base
// stays empty (non-Latin title → id-addressed game).
func uniqueGameSlug(app core.App, base, excludeID string) string {
	if base == "" {
		return ""
	}
	if !gameSlugTaken(app, base, excludeID) {
		return base
	}
	for i := 2; i < 100000; i++ {
		cand := base + "-" + strconv.Itoa(i)
		if !gameSlugTaken(app, cand, excludeID) {
			return cand
		}
	}
	return base + "-" + excludeID // pathological fallback; never expected to hit
}

// retireGameSlug records a slug a game used to have, so every URL it ever exposed
// keeps redirecting to the current one. No-op for empty slugs (collision/hidden
// games never had a public slug) or when the alias already exists.
func retireGameSlug(app core.App, slug, gameID string) {
	if slug == "" {
		return
	}
	if existing, _ := app.FindFirstRecordByFilter(
		"game_slug_aliases", "slug = {:s}", dbx.Params{"s": slug},
	); existing != nil {
		return
	}
	coll, err := app.FindCollectionByNameOrId("game_slug_aliases")
	if err != nil {
		app.Logger().Warn("slug alias: collection not found", "error", err.Error())
		return
	}
	rec := core.NewRecord(coll)
	rec.Set("slug", slug)
	rec.Set("game", gameID)
	if err := app.Save(rec); err != nil {
		app.Logger().Warn("slug alias: save failed", "slug", slug, "error", err.Error())
	}
}

// dropGameSlugAlias removes any alias for a slug — called when a game reclaims a
// slug as its live one, so the resolver never sees both a live slug and a stale
// alias for the same string.
func dropGameSlugAlias(app core.App, slug string) {
	if slug == "" {
		return
	}
	if rec, _ := app.FindFirstRecordByFilter(
		"game_slug_aliases", "slug = {:s}", dbx.Params{"s": slug},
	); rec != nil {
		if err := app.Delete(rec); err != nil {
			app.Logger().Warn("slug alias: delete failed", "slug", slug, "error", err.Error())
		}
	}
}

// applyGameSlugRename refreshes a game's slug after its title changed, preserving
// the old slug as a redirect alias. It mutates game (Set slug) and records the old
// slug into `changed` for the revision log; the caller saves game afterwards.
func applyGameSlugRename(app core.App, game *core.Record, changed map[string]any) {
	newBase := slugifyGame(game.GetString("title"))
	if newBase == "" {
		return // non-Latin title → leave the existing slug/id untouched
	}
	oldSlug := game.GetString("slug")
	newSlug := uniqueGameSlug(app, newBase, game.Id)
	if newSlug == oldSlug {
		return
	}
	dropGameSlugAlias(app, newSlug) // reclaiming a formerly-retired slug: drop the alias
	changed["slug"] = oldSlug
	game.Set("slug", newSlug)
	retireGameSlug(app, oldSlug, game.Id)
}
