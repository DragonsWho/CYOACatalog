package main

import (
	"html"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// /all — plain HTML catalog index. The site was a crawl dead end: "/" renders 25 cards and scrolls
// via JS, game cards link to no other game, so a bot reached a few dozen of 1301 games. sitemap.xml
// only SUGGESTS URLs; unlinked URLs are "Discovered – currently not indexed" (598 in the 2026-09-20
// Coverage export). So: server pages of 100 games, real <a href> to canonical /game/<slug>,
// prev/next chained, first linked from the footer. No React, no API. Page number in the PATH
// (/all/2), not ?page=2: the canonical rule collapses query params to the base URL, which would
// make pages 2–14 duplicates of page 1.
const allPageSize = 100

const allIndexTTL = 6 * time.Hour

type allIndexEntry struct {
	key   string
	title string
}

var allIndexCache = &allIndexDoc{}

type allIndexDoc struct {
	mu      sync.Mutex
	entries []allIndexEntry
	builtAt time.Time
}

func (d *allIndexDoc) get(app core.App) []allIndexEntry {
	d.mu.Lock()
	fresh := d.entries != nil && time.Since(d.builtAt) < allIndexTTL
	cached := d.entries
	d.mu.Unlock()
	if fresh {
		return cached
	}

	entries, err := buildAllIndex(app)
	if err != nil {
		app.Logger().Warn("all-index rebuild failed", "error", err.Error())
		return cached
	}

	d.mu.Lock()
	d.entries = entries
	d.builtAt = time.Now()
	d.mu.Unlock()
	return entries
}

func (d *allIndexDoc) invalidate() {
	d.mu.Lock()
	d.builtAt = time.Time{}
	d.mu.Unlock()
}

// Sorted by title: date order would move games between pages on every publish.
func buildAllIndex(app core.App) ([]allIndexEntry, error) {
	records, err := app.FindRecordsByFilter("games", "hidden != true", "title", 0, 0)
	if err != nil {
		return nil, err
	}
	entries := make([]allIndexEntry, 0, len(records))
	for _, rec := range records {
		title := strings.TrimSpace(rec.GetString("title"))
		if title == "" {
			title = "(untitled)"
		}
		entries = append(entries, allIndexEntry{key: gameURLKey(rec), title: title})
	}
	return entries, nil
}

func allPageCount(total int) int {
	if total <= 0 {
		return 1
	}
	return (total + allPageSize - 1) / allPageSize
}

// First page is /all, not /all/1 — one canonical form (/all/1 redirects).
func allPagePath(page int) string {
	if page <= 1 {
		return "/all"
	}
	return "/all/" + strconv.Itoa(page)
}

// Minimal inline markup: must open with zero /assets requests, independent of frontend deploys.
func renderAllPage(entries []allIndexEntry, page int) string {
	total := len(entries)
	pages := allPageCount(total)
	start := (page - 1) * allPageSize
	end := start + allPageSize
	if end > total {
		end = total
	}

	title := "All games — CYOA.CAFE"
	if page > 1 {
		title = "All games, page " + strconv.Itoa(page) + " — CYOA.CAFE"
	}

	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="en"><head><meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	b.WriteString(`<title>` + html.EscapeString(title) + `</title>`)
	b.WriteString(`<meta name="description" content="The complete CYOA.CAFE catalog: all ` +
		strconv.Itoa(total) + ` interactive and image CYOA games, listed A to Z.">`)
	b.WriteString(`<link rel="canonical" href="` + siteURL + allPagePath(page) + `">`)
	if page > 1 {
		b.WriteString(`<link rel="prev" href="` + siteURL + allPagePath(page-1) + `">`)
	}
	if page < pages {
		b.WriteString(`<link rel="next" href="` + siteURL + allPagePath(page+1) + `">`)
	}
	b.WriteString(`<style>` +
		`:root{--bg:#151515;--fg:#dcdcdc;--muted:rgba(255,255,255,.5);--rule:rgba(255,255,255,.08);--accent:#fc3447}` +
		`*{box-sizing:border-box}` +
		`body{margin:0;padding:32px 24px 56px;background:var(--bg);color:var(--fg);` +
		`font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}` +
		`main{max-width:900px;margin:0 auto}` +
		`.brand{display:inline-block;margin:0 0 20px;color:var(--accent);font-weight:700;` +
		`letter-spacing:.14em;font-size:15px;text-decoration:none}` +
		`.brand:hover{opacity:.8}` +
		`h1{font-size:26px;font-weight:700;margin:0 0 6px}` +
		`p.sub{color:var(--muted);margin:0 0 24px;font-size:13px;letter-spacing:.04em}` +
		`p.sub a{color:var(--muted);text-decoration:underline}` +
		`p.sub a:hover{color:var(--accent)}` +
		`ul{list-style:none;margin:0;padding:0;columns:2;column-gap:40px}` +
		`@media(max-width:640px){ul{columns:1}body{padding:24px 16px 40px}}` +
		`li{break-inside:avoid;padding:5px 0;border-bottom:1px solid var(--rule)}` +
		`a{color:var(--fg);text-decoration:none}` +
		`li a:hover{color:var(--accent)}` +
		`nav{margin:28px 0 0;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline}` +
		`nav span{font-size:14px;color:var(--muted)}` +
		`nav a{font-size:14px;color:var(--fg);padding:2px 6px;border:1px solid var(--rule);border-radius:4px}` +
		`nav a:hover{color:var(--accent);border-color:var(--accent)}` +
		`nav .cur{font-size:14px;color:var(--accent);font-weight:700;padding:2px 6px;` +
		`border:1px solid var(--accent);border-radius:4px}` +
		`</style></head><body><main>`)

	b.WriteString(`<a class="brand" href="/">CYOA.CAFE</a>`)
	b.WriteString(`<h1>All games</h1>`)
	b.WriteString(`<p class="sub">` + strconv.Itoa(total) + ` games · page ` +
		strconv.Itoa(page) + ` of ` + strconv.Itoa(pages) +
		` · <a href="/">back to the catalog</a></p>`)

	b.WriteString(`<ul>`)
	for _, e := range entries[start:end] {
		b.WriteString(`<li><a href="/game/` + html.EscapeString(e.key) + `">` +
			html.EscapeString(e.title) + `</a></li>`)
	}
	b.WriteString(`</ul>`)

	// Full page ladder, not just prev/next: any page reachable in one hop.
	b.WriteString(`<nav><span>Pages:</span>`)
	for p := 1; p <= pages; p++ {
		if p == page {
			b.WriteString(`<span class="cur">` + strconv.Itoa(p) + `</span>`)
			continue
		}
		b.WriteString(`<a href="` + allPagePath(p) + `">` + strconv.Itoa(p) + `</a>`)
	}
	b.WriteString(`</nav>`)

	b.WriteString(`</main></body></html>`)
	return b.String()
}

func registerAllIndexRoutes(app core.App, e *core.ServeEvent) {
	serve := func(c *core.RequestEvent, page int) error {
		entries := allIndexCache.get(app)
		if len(entries) == 0 {
			return c.NoContent(http.StatusServiceUnavailable)
		}
		if page < 1 || page > allPageCount(len(entries)) {
			// Nonexistent page → honest 404, else /all/999 becomes another soft 404.
			c.Response.Header().Set("X-Robots-Tag", "noindex")
			c.Response.Header().Set("Cache-Control", "no-store")
			return c.NoContent(http.StatusNotFound)
		}
		c.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
		c.Response.Header().Set("Cache-Control", "public, max-age=3600")
		c.Response.WriteHeader(http.StatusOK)
		_, err := c.Response.Write([]byte(renderAllPage(entries, page)))
		return err
	}

	e.Router.GET("/all", func(c *core.RequestEvent) error {
		return serve(c, 1)
	})

	e.Router.GET("/all/{page}", func(c *core.RequestEvent) error {
		raw := c.Request.PathValue("page")
		page, err := strconv.Atoi(raw)
		if err != nil {
			c.Response.Header().Set("X-Robots-Tag", "noindex")
			c.Response.Header().Set("Cache-Control", "no-store")
			return c.NoContent(http.StatusNotFound)
		}
		if page == 1 {
			return c.Redirect(http.StatusMovedPermanently, "/all")
		}
		return serve(c, page)
	})
}
