package main

// Game page first paint: the HTML shell of /game/<slug> carries the data GameDetails would otherwise
// fetch after the bundle and its chunk load (game → then relationships + variants: two sequential
// round trips, ~2 s on a mid phone), plus a preload of the cover. The frontend renders from it at
// mount and revalidates in the background (the shell is edge-cached for an hour).
//
// Shapes mirror the frontend queries exactly (src/pocketbase/pocketbase.ts GAME_DETAIL_FIELDS /
// VARIANT_FIELDS, GameDetails REL_FIELDS); keep them in sync. All collections involved are public
// (games: hidden != true — findGameByURLKey already skips hidden games).

import (
	"encoding/json"
	"html"
	"log"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

var gameDetailFields = []string{
	"id", "collectionId", "slug", "title", "description", "image", "image_base64", "aliases",
	"img_or_link", "iframe_url", "cyoa_pages", "cyoa_pages_preview", "language", "upvotes_count",
	"uploader", "created", "bumped_at", "original_link", "release_date", "original_release",
}

var gameVariantFields = []string{
	"id", "collectionId", "language", "version_label", "title", "description",
	"img_or_link", "iframe_url", "cyoa_pages", "cyoa_pages_preview", "image", "image_base64",
}

var gameRelFields = []string{
	"id", "relationship_type", "source_game", "target_game", "description_source",
	"description_target", "source_language", "target_language",
}

// Like the API's `fields=` projection: only fields present in the schema (a field not yet added in
// prod is omitted, not null).
func pickFields(r *core.Record, names []string) map[string]any {
	out := map[string]any{}
	for _, n := range names {
		switch n {
		case "id":
			out["id"] = r.Id
			continue
		case "collectionId":
			out["collectionId"] = r.Collection().Id
			continue
		}
		if r.Collection().Fields.GetByName(n) != nil {
			out[n] = r.Get(n)
		}
	}
	return out
}

// Detail-image candidates; must equal GameDetails DETAIL_IMG_* and utils/cfImage.ts output.
var detailImgWidths = []string{"400", "600", "800", "1200"}

const detailImgSizes = "(max-width: 900px) 96vw, 580px"

func detailImgURL(path, width string) string {
	return "/cdn-cgi/image/width=" + width + ",quality=70,format=auto" + path
}

// buildGameInline returns the <script>window.__GAME__=…</script> block and the cover preload link
// for an already-resolved, visible game. withPreload=false when a query (?lang=) may switch the
// cover to a variant's.
func buildGameInline(app core.App, rec *core.Record, withPreload bool) string {
	game := pickFields(rec, gameDetailFields)

	if errs := app.ExpandRecord(rec, []string{"authors", "tags"}, nil); len(errs) > 0 {
		log.Printf("Warn: game inline expand: %v", errs)
	}
	expand := map[string]any{}
	if authors := rec.ExpandedAll("authors"); len(authors) > 0 {
		arr := make([]map[string]any, 0, len(authors))
		for _, a := range authors {
			arr = append(arr, map[string]any{"id": a.Id, "name": a.GetString("name")})
		}
		expand["authors"] = arr
	}
	if tags := rec.ExpandedAll("tags"); len(tags) > 0 {
		// expand.tags[].expand.tag_categories_via_tags (back-relation), as the frontend requests it.
		ids := make([]any, 0, len(tags))
		for _, t := range tags {
			ids = append(ids, t.Id)
		}
		catsOf := map[string][]map[string]any{}
		if cats, err := app.FindAllRecords("tag_categories"); err == nil {
			for _, c := range cats {
				for _, tid := range c.GetStringSlice("tags") {
					catsOf[tid] = append(catsOf[tid], map[string]any{"id": c.Id, "name": c.GetString("name")})
				}
			}
		}
		arr := make([]map[string]any, 0, len(tags))
		for _, t := range tags {
			// The API sends `expand: {}` for a tag in no category.
			tagExpand := map[string]any{}
			if c := catsOf[t.Id]; len(c) > 0 {
				tagExpand["tag_categories_via_tags"] = c
			}
			tag := map[string]any{"id": t.Id, "name": t.GetString("name"), "expand": tagExpand}
			arr = append(arr, tag)
		}
		expand["tags"] = arr
	}
	if len(expand) > 0 {
		game["expand"] = expand
	}

	// Relationships: outgoing (expand target_game), then incoming (expand source_game); expanded
	// games only when visible to guests, as the API would.
	related := []map[string]any{}
	for _, dir := range []struct{ filterField, expandField string }{
		{"source_game", "target_game"},
		{"target_game", "source_game"},
	} {
		rels, err := app.FindRecordsByFilter("game_relationships", dir.filterField+" = {:id}", "", 0, 0, dbx.Params{"id": rec.Id})
		if err != nil {
			continue
		}
		for _, r := range rels {
			item := pickFields(r, gameRelFields)
			if other, err := app.FindRecordById("games", r.GetString(dir.expandField)); err == nil && !other.GetBool("hidden") {
				item["expand"] = map[string]any{dir.expandField: map[string]any{
					"id": other.Id, "slug": other.GetString("slug"), "title": other.GetString("title"),
				}}
			}
			related = append(related, item)
		}
	}

	variants := []map[string]any{}
	if vs, err := app.FindRecordsByFilter("game_variants", "game = {:id}", "", 0, 0, dbx.Params{"id": rec.Id}); err == nil {
		for _, v := range vs {
			variants = append(variants, pickFields(v, gameVariantFields))
		}
	}

	payload, err := json.Marshal(map[string]any{
		"key":      gameURLKey(rec),
		"game":     game,
		"related":  related,
		"variants": variants,
	})
	if err != nil {
		log.Printf("Warn: game inline marshal: %v", err)
		return ""
	}
	// json.Marshal escapes <, >, & — safe inside <script>.
	out := "<script>window.__GAME__=" + string(payload) + "</script>"

	if img := rec.GetString("image"); withPreload && img != "" {
		path := "/api/files/" + rec.Collection().Id + "/" + rec.Id + "/" + img
		set := make([]string, 0, len(detailImgWidths))
		for _, w := range detailImgWidths {
			set = append(set, detailImgURL(path, w)+" "+w+"w")
		}
		out += `<link rel="preload" as="image" fetchpriority="high" href="` + html.EscapeString(detailImgURL(path, "600")) +
			`" imagesrcset="` + html.EscapeString(strings.Join(set, ", ")) +
			`" imagesizes="` + detailImgSizes + `">`
	}
	return out
}
