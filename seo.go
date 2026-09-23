package main

import (
	"encoding/json"
	"html"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// robots.txt + sitemap.xml served from Go, not dist/: the sitemap comes from the live DB (new games
// appear without a frontend rebuild). Registered ahead of the SPA catch-all — otherwise /robots.txt
// answers 200 with the HTML shell.
// Two rules learned the hard way (2026-09-12): 1) Googlebot renders our JS; while all of /api/ was
// disallowed it rendered "Game not found or failed to load" and filed 559 LIVE game cards as soft
// 404s. So every read-only endpoint the visible page uses is Allowed by name; the blanket Disallow
// covers the rest (Allow wins by longest match). 2) Nothing private is hidden with Disallow:
// Disallow forbids fetching, so noindex is never read and linked URLs get indexed as bare titles.
// Private surfaces use noindexPaths (main.go) instead.
var robotsTxt = strings.Join([]string{
	"User-agent: *",
	"Allow: /",
	"",
	"# Data the page is built from in the bot's browser.",
	"Allow: /api/collections/games/records",
	"Allow: /api/collections/tags/records",
	"Allow: /api/collections/tag_categories/records",
	"Allow: /api/collections/comments/records",
	"Allow: /api/collections/game_relationships/records",
	"Allow: /api/collections/game_variants/records",
	"Allow: /api/collections/game_tag_votes/records",
	"Allow: /api/collections/announcements/records",
	// The "Similar games" strip (SimilarGamesStrip) is built from this endpoint; without Allow the bot
	// gets an empty strip and the card stays a crawl dead end.
	"Allow: /api/similar-games/",
	"Allow: /api/custom/games/",
	"Allow: /api/custom/bump/",
	"Allow: /api/files/",
	"",
	"# Bots need nothing else from the API: realtime, batch, auth, chat heartbeat,",
	"# and certainly not PocketBase internals.",
	"Disallow: /api/",
	"Disallow: /_/",
	"",
	"Sitemap: " + siteURL + "/sitemap.xml",
	"",
}, "\n")

const sitemapTTL = 6 * time.Hour

var sitemapCache = &sitemapDoc{}

type sitemapDoc struct {
	mu      sync.Mutex
	xml     string
	builtAt time.Time
}

func (s *sitemapDoc) get(app core.App) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.xml != "" && time.Since(s.builtAt) < sitemapTTL {
		return s.xml
	}
	doc, err := buildSitemap(app)
	if err != nil {
		app.Logger().Warn("sitemap build failed", "error", err.Error())
		return s.xml
	}
	s.xml = doc
	s.builtAt = time.Now()
	return s.xml
}

func (s *sitemapDoc) invalidate() {
	s.mu.Lock()
	s.builtAt = time.Time{}
	s.mu.Unlock()
}

// `hidden != true` mirrors the API listRule — direct DB read, rule not applied for us.
func buildSitemap(app core.App) (string, error) {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` + "\n")

	writeURL := func(loc, lastmod string) {
		b.WriteString("<url><loc>" + html.EscapeString(loc) + "</loc>")
		if lastmod != "" {
			b.WriteString("<lastmod>" + lastmod + "</lastmod>")
		}
		b.WriteString("</url>\n")
	}

	paths := make([]string, 0, len(staticPageMeta))
	for p := range staticPageMeta {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		writeURL(siteURL+"/"+p, "")
	}

	// /all index pages: otherwise the bot finds /all only via the footer after React renders. Same
	// cache as the page itself — map and index can't disagree.
	if n := allPageCount(len(allIndexCache.get(app))); n > 0 {
		for p := 1; p <= n; p++ {
			writeURL(siteURL+allPagePath(p), "")
		}
	}

	records, err := app.FindRecordsByFilter("games", "hidden != true", "-created", 0, 0)
	if err != nil {
		return "", err
	}
	for _, rec := range records {
		lastmod := ""
		if t := rec.GetDateTime("updated").Time(); !t.IsZero() {
			lastmod = t.UTC().Format("2006-01-02")
		}
		writeURL(siteURL+"/game/"+gameURLKey(rec), lastmod)
	}

	b.WriteString("</urlset>\n")
	return b.String(), nil
}

func registerSEORoutes(app core.App, e *core.ServeEvent) {
	registerAllIndexRoutes(app, e)
	registerGameAboutRoute(app, e)

	e.Router.GET("/robots.txt", func(c *core.RequestEvent) error {
		c.Response.Header().Set("Content-Type", "text/plain; charset=utf-8")
		c.Response.Header().Set("Cache-Control", "public, max-age=86400")
		c.Response.WriteHeader(http.StatusOK)
		_, err := c.Response.Write([]byte(robotsTxt))
		return err
	})

	e.Router.GET("/sitemap.xml", func(c *core.RequestEvent) error {
		doc := sitemapCache.get(app)
		if doc == "" {
			return c.NoContent(http.StatusServiceUnavailable)
		}
		c.Response.Header().Set("Content-Type", "application/xml; charset=utf-8")
		c.Response.Header().Set("Cache-Control", "public, max-age=3600")
		c.Response.WriteHeader(http.StatusOK)
		_, err := c.Response.Write([]byte(doc))
		return err
	})
}

// Updates deliberately NOT hooked: they fire constantly (counters) and a retitled game keeps its
// old URL via game_slug_aliases; TTL staleness is harmless.
func registerSitemapInvalidation(app core.App) {
	app.OnRecordAfterCreateSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		sitemapCache.invalidate()
		allIndexCache.invalidate()
		return e.Next()
	})
	app.OnRecordAfterDeleteSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		sitemapCache.invalidate()
		allIndexCache.invalidate()
		return e.Next()
	})
}

// Unknown URLs: no more soft 404s. The SPA catch-all answered EVERY path with the shell, so a
// phantom URL like /en returned 200 with the whole catalog and got filed as a home duplicate
// (language lives in `?lang=`, never a path prefix). Now such URLs answer 404 with the shell
// (frontend <Route path="*"> sends humans to "/"). knownAppPaths mirrors the <Route> table in
// src/App.tsx by FIRST path segment (home = ""). ⚠ A new route in App.tsx needs an entry here, else
// the page works in the browser but answers 404 to Google (TestKnownAppPathsMatchFrontendRoutes
// enforces it).
var knownAppPaths = map[string]bool{
	"":                 true,
	"add-next":         true,
	"chat":             true,
	"confirm-email":    true,
	"create":           true,
	"game":             true,
	"hosting":          true,
	"log":              true,
	"login":            true,
	"moderator":        true,
	"privacy-policy":   true,
	"profile":          true,
	"recovery":         true,
	"roulette":         true,
	"search":           true,
	"semantic-search":  true,
	"terms-of-service": true,
	"verification":     true,
	// "play" must NOT be here: /play/<user>/<slug>/… belongs to hosting (hosting.go); bare /play,
	// /play/<user> have no frontend route and were soft 404s.
}

func isKnownAppPath(path string) bool {
	seg, _, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	// "*-lab" stands are recognized by name so each new one doesn't break the build against this
	// registry; isNoindexPath hides them too.
	if isLabPath(seg) {
		return true
	}
	return knownAppPaths[seg]
}

func isLabPath(seg string) bool {
	return strings.HasSuffix(strings.TrimRight(seg, "0123456789"), "-lab")
}

// JSON-LD: Game — deliberately not VideoGame/SoftwareApplication (Google's software-app rich result
// requires offers + aggregateRating; we have no price and upvotes aren't a 1–5 rating; inventing
// them is structured-data spam). Plain Game has no required fields, so no Search Console errors.
// BreadcrumbList: Home › All games › <title>, pointing at crawlable /all.
func gameJSONLD(app core.App, rec *core.Record, pageURL, image, title string) string {
	app.ExpandRecord(rec, []string{"authors"}, nil)

	game := map[string]any{
		"@context": "https://schema.org",
		"@type":    "Game",
		"name":     title,
		"url":      pageURL,
		"image":    image,
	}
	// Never put text in JSON-LD that the page doesn't show (guideline breach). The long summary IS
	// shown ("About this game").
	d := plainExcerpt(rec.GetString("rich_description"), 500)
	if d == "" {
		d = plainExcerpt(rec.GetString("description"), 500)
	}
	if d != "" {
		game["description"] = d
	}
	var authors []map[string]any
	for _, a := range rec.ExpandedAll("authors") {
		if n := strings.TrimSpace(a.GetString("name")); n != "" {
			authors = append(authors, map[string]any{"@type": "Person", "name": n})
		}
	}
	if len(authors) > 0 {
		game["author"] = authors
	}
	var tags []string
	for _, t := range rec.ExpandedAll("tags") {
		if n := strings.TrimSpace(t.GetString("name")); n != "" {
			tags = append(tags, n)
		}
	}
	if len(tags) > 0 {
		game["keywords"] = strings.Join(tags, ", ")
	}
	if t := rec.GetDateTime("created").Time(); !t.IsZero() {
		game["datePublished"] = t.UTC().Format("2006-01-02")
	}
	if t := rec.GetDateTime("updated").Time(); !t.IsZero() {
		game["dateModified"] = t.UTC().Format("2006-01-02")
	}

	crumbs := map[string]any{
		"@context": "https://schema.org",
		"@type":    "BreadcrumbList",
		"itemListElement": []map[string]any{
			{"@type": "ListItem", "position": 1, "name": siteName, "item": siteURL + "/"},
			{"@type": "ListItem", "position": 2, "name": "All games", "item": siteURL + allPagePath(1)},
			{"@type": "ListItem", "position": 3, "name": title, "item": pageURL},
		},
	}

	// json.Marshal escapes <, >, & — a "</script>" title can't break out.
	var b strings.Builder
	for _, block := range []map[string]any{game, crumbs} {
		js, err := json.Marshal(block)
		if err != nil {
			continue
		}
		b.WriteString(`<script type="application/ld+json">` + string(js) + `</script>`)
	}
	return b.String()
}

// "About this game": games.rich_description (LLM summary written for the semantic index) is hidden
// in the schema so the catalog API never ships it; on the game page it's exactly the content
// crawlers lack. Served here to GameAbout.tsx without schema changes, under /api/custom/games/
// (Allowed in robots.txt). Changes only on regeneration → 1h cache.
func registerGameAboutRoute(app core.App, e *core.ServeEvent) {
	e.Router.GET("/api/custom/games/{id}/about", func(c *core.RequestEvent) error {
		rec, err := app.FindRecordById("games", c.Request.PathValue("id"))
		if err != nil || rec.GetBool("hidden") {
			return c.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
		}
		c.Response.Header().Set("Cache-Control", "public, max-age=3600")
		return c.JSON(http.StatusOK, map[string]string{
			"text": strings.TrimSpace(rec.GetString("rich_description")),
		})
	})
}
