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

// Pretty game URLs: /game/<slug>, slug derived from title. This file mints slugs (create hook +
// rename) and keeps redirect-history aliases. Existing games were backfilled once by
// PB/backfill_slugs.py.
const maxSlugLen = 80

var nonSlugChars = regexp.MustCompile(`[^a-z0-9]+`)

// MUST stay byte-identical to PB/slugify.py — both mint slugs; drift forks a game's canonical URL.
// Steps: 1) NFKD, drop combining marks (é→e, ﬁ→fi, Ａ→a); 2) lowercase; 3) collapse non-[a-z0-9]
// runs to "-"; 4) trim edge hyphens, cap length. Non-Latin title → "" and the caller keeps the
// record id as URL key. (Python strips by combining class, Go by category Mn; they agree on all
// Latin diacritics.)
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
	if len(s) > maxSlugLen { // pure ASCII here, byte len == rune count
		s = strings.TrimRight(s[:maxSlugLen], "-")
	}
	return s
}

// A 15-char one-word slug looks like a PB id, so id-shaped keys try id first then slug — same order
// as frontend resolveGameByParam(), so both resolve every URL to the same record.
var legacyIDRe = regexp.MustCompile(`^[a-z0-9]{15}$`)

// Mirrors the frontend's three tiers: id → current slug → retired slug (alias). SSR (OG meta,
// sitemap) needs it: crawlers only see the URL. Hidden games skipped in tiers 1–2: PB rules
// ('hidden != true') don't apply to app-level lookups, so a merged-away duplicate would still
// answer for its id here while the browser falls through to the alias.
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

// Go twin of the frontend's gameCanonicalKey().
func gameURLKey(rec *core.Record) string {
	if s := rec.GetString("slug"); s != "" {
		return s
	}
	return rec.Id
}

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

// Same collision rule as PB/backfill_slugs.py (earlier record keeps the clean slug). Empty base
// stays empty.
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
	return base + "-" + excludeID
}

// Every URL a game ever exposed keeps redirecting to the current one.
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

// When a game reclaims a slug as live, drop the alias so the resolver never sees both.
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

// Caller saves game afterwards; old slug goes into `changed` for the revision log.
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
