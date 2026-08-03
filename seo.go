package main

import (
	"html"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// ── Crawler surface: robots.txt + sitemap.xml ────────────────────────────────
//
// Both are served from Go rather than dist/ because the sitemap is generated from
// the live DB (a new game must appear without a frontend rebuild) and robots.txt
// wants to point at it. They are registered ahead of the SPA catch-all — otherwise
// /robots.txt answers 200 with the HTML shell, which is what a crawler used to get.

// robotsTxt: everything public is crawlable; authed/tool surfaces are not (they
// render empty without a session, so indexing them only burns crawl budget).
var robotsTxt = strings.Join([]string{
	"User-agent: *",
	"Allow: /",
	"Disallow: /api/",
	"Disallow: /_/",
	"Disallow: /moderator",
	"Disallow: /profile",
	"Disallow: /login",
	"Disallow: /recovery",
	"Disallow: /verification",
	"Disallow: /create",
	"Disallow: /add-next",
	"Disallow: /cheat-lab",
	"Disallow: /chat-lab",
	"Disallow: /vector-search",
	"Disallow: /header-lab",
	"",
	"Sitemap: " + siteURL + "/sitemap.xml",
	"",
}, "\n")

// sitemapTTL: the catalog grows a few games a day, so a stale-by-hours list costs
// nothing and keeps the (full-table) rebuild off the request path.
const sitemapTTL = 6 * time.Hour

var sitemapCache = &sitemapDoc{}

type sitemapDoc struct {
	mu      sync.Mutex
	xml     string
	builtAt time.Time
}

// get returns the cached sitemap, rebuilding it when the TTL has expired. On a
// rebuild error the previous copy is kept (an empty one only on the very first try).
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

// invalidate drops the cached copy so the next request rebuilds — called when a
// game is created, so a fresh publish is discoverable right away.
func (s *sitemapDoc) invalidate() {
	s.mu.Lock()
	s.builtAt = time.Time{}
	s.mu.Unlock()
}

// buildSitemap lists the static app routes plus every non-hidden game under its
// canonical /game/<slug> URL. `hidden != true` mirrors the API listRule — this is
// a direct DB read, so the rule is not applied for us (same as the catalog snapshot).
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

	// Static routes: exactly the ones that carry their own SEO copy.
	paths := make([]string, 0, len(staticPageMeta))
	for p := range staticPageMeta {
		paths = append(paths, p)
	}
	sort.Strings(paths) // deterministic output (map order would churn the file)
	for _, p := range paths {
		writeURL(siteURL+"/"+p, "")
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

// registerSEORoutes wires robots.txt/sitemap.xml and keeps the sitemap fresh when
// games are published.
func registerSEORoutes(app core.App, e *core.ServeEvent) {
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

// registerSitemapInvalidation drops the cached sitemap when the set of game URLs
// changes, so a fresh publish is crawlable immediately. Updates are deliberately
// NOT hooked: they fire constantly (like/comment counters) and a retitled game keeps
// its old URL working through game_slug_aliases, so TTL staleness is harmless —
// while invalidating on every counter bump would rebuild the whole list per request.
func registerSitemapInvalidation(app core.App) {
	app.OnRecordAfterCreateSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		sitemapCache.invalidate()
		return e.Next()
	})
	app.OnRecordAfterDeleteSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		sitemapCache.invalidate()
		return e.Next()
	})
}
