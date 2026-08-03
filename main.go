// main.go

package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/joho/godotenv"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"

	// ┌─── ДОБАВЛЕНО: OAuth2 плагин ───┐
	oauth2 "github.com/DragonsWho/pocketbase-ext-oauth2"
	// └────────────────────────────────┘
)

// NB: plain `dist` (not `all:dist`) — the `all:` prefix would also embed
// dot/underscore files, including the `.fuse_hidden*` copies ntfs-3g leaves
// behind when `dist/serve` is replaced while still running. Those would bloat
// the binary (a whole stale copy of itself). Real frontend assets never start
// with `.`/`_`, so plain `dist` embeds everything we actually serve.
//
//go:embed dist
var assets embed.FS

// Early Hints: extract the hashed entry bundle names from the built index.html
// so we can advertise them via a `Link: rel=preload` response header. Cloudflare
// (Early Hints enabled on the zone) harvests these headers from the cached HTML
// response and replays them as a 103 Early Hints, letting the browser start the
// bundle download during the edge/origin think-time. CF only honors `preload` and
// `preconnect` (not `modulepreload`), so we emit `preload`. `crossorigin` matches
// Vite's `<script type="module" crossorigin>` / `<link crossorigin>` so the
// preload is actually consumed and not fetched twice.
var assetJSRe = regexp.MustCompile(`<script[^>]+\bsrc="(/assets/[^"]+\.js)"`)
var assetCSSRe = regexp.MustCompile(`<link[^>]+\bhref="(/assets/[^"]+\.css)"`)

func buildEarlyHintsLink(distDirFS fs.FS) string {
	data, err := fs.ReadFile(distDirFS, "index.html")
	if err != nil {
		log.Printf("Warn: Early Hints disabled — cannot read index.html: %v", err)
		return ""
	}
	html := string(data)
	var parts []string
	if m := assetCSSRe.FindStringSubmatch(html); m != nil {
		parts = append(parts, fmt.Sprintf("<%s>; rel=preload; as=style; crossorigin", m[1]))
	}
	if m := assetJSRe.FindStringSubmatch(html); m != nil {
		parts = append(parts, fmt.Sprintf("<%s>; rel=preload; as=script; crossorigin", m[1]))
	}
	return strings.Join(parts, ", ")
}

// ── Catalog snapshot inlining ("впрыск") ───────────────────────────────────
//
// The cold-visit CLS jump on the catalog is "empty shell painted → cards pop in
// a few frames later" (frontend can't fetch until the 670K bundle parses). To get
// real cards into the *second* paint we inline the default catalog view straight
// into index.html as `window.__CATALOG__`, so React (SearchPage) can seed its grid
// before the first network round-trip even starts.
//
// The snapshot is the DEFAULT home view and is identical for every visitor — the
// `-created` top page, SFW-filtered (nsfw/extreme tags excluded), shaped exactly
// like a `games` getList response with `expand=authors,tags` and the
// CATALOG_GAME_FIELDS whitelist (incl. image_base64 blur). Because it's the same
// for all anon users, the injected document stays shared → CF rule [R6] keeps
// edge-caching it. The frontend only seeds from it on the exact default SFW home
// view, then a normal fetch reconciles by id (no visible re-render).
//
// It's rebuilt in-process on a timer (the doc can be up to ~edge-TTL stale, which
// the confirming fetch fixes), so the origin just hands out a ready string.
const catalogSnapshotSize = 25

// catalogSnap is the live in-memory snapshot inlined into the SPA shell. It's a
// package var so the games-create hook (registerCatalogSnapshotRefresh) can rebuild
// it the instant a new game is published. catalogInliningActive guards the hook so
// it does nothing in dev (vite proxy, no embedded dist) — only the prod serve branch
// flips it true.
var (
	catalogSnap           = &catalogSnapshot{}
	catalogInliningActive bool
	catalogPurge          = &cfPurger{}
)

type catalogSnapshot struct {
	mu        sync.RWMutex
	scriptTag string // <script>window.__CATALOG__=[...]</script>, or "" if unbuilt
}

func (s *catalogSnapshot) get() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.scriptTag
}

func (s *catalogSnapshot) set(tag string) {
	s.mu.Lock()
	s.scriptTag = tag
	s.mu.Unlock()
}

// refresh rebuilds the snapshot from the live DB. On any error it leaves the
// previous value untouched (frontend just falls back to its normal fetch).
func (s *catalogSnapshot) refresh(app core.App) {
	tag, err := buildCatalogScriptTag(app)
	if err != nil {
		log.Printf("Warn: catalog snapshot refresh failed: %v", err)
		return
	}
	s.set(tag)
}

// cfPurger coalesces a burst of game publishes into a single Cloudflare cache purge.
// A new game changes the set of "recent" cards, so the edge-cached SPA shell (with the
// stale inlined snapshot) must be dropped. Counts (likes/comments) drift constantly and
// are NOT purged here — the 5-min snapshot timer covers them.
type cfPurger struct {
	mu      sync.Mutex
	pending bool
}

// trigger refreshes the snapshot now, then schedules one purge after a short window so
// a batch of publishes collapses into a single CF call. No-op unless inlining is active.
func (p *cfPurger) trigger(app core.App) {
	if !catalogInliningActive {
		return
	}
	catalogSnap.refresh(app)
	p.mu.Lock()
	if p.pending {
		p.mu.Unlock()
		return
	}
	p.pending = true
	p.mu.Unlock()
	go func() {
		time.Sleep(15 * time.Second) // coalesce a burst of publishes into one purge
		p.mu.Lock()
		p.pending = false
		p.mu.Unlock()
		catalogSnap.refresh(app) // pick up anything published during the window
		if err := purgeCatalogHTMLCache(); err != nil {
			app.Logger().Warn("catalog HTML cache purge failed", "error", err.Error())
			return
		}
		app.Logger().Info("catalog HTML cache purged after new game publish")
	}()
}

// purgeCatalogHTMLCache drops the edge-cached SPA shell for the catalog views that seed
// from the inlined snapshot (home + search). Uses the same CF token/zone as `make cf-purge`.
func purgeCatalogHTMLCache() error {
	return purgeCFURLs([]string{"https://cyoa.cafe", "https://cyoa.cafe/", "https://cyoa.cafe/search"})
}

// purgeCFURLs drops specific URLs from the Cloudflare edge cache.
func purgeCFURLs(urls []string) error {
	zone := os.Getenv("CLOUDFLARE_ZONE_ID")
	token := os.Getenv("CLOUDFLARE_API_TOKEN")
	if zone == "" || token == "" {
		return fmt.Errorf("CLOUDFLARE_ZONE_ID/CLOUDFLARE_API_TOKEN not set")
	}
	payload, err := json.Marshal(map[string]any{"files": urls})
	if err != nil {
		return err
	}
	body := string(payload)
	req, err := http.NewRequest(http.MethodPost,
		"https://api.cloudflare.com/client/v4/zones/"+zone+"/purge_cache",
		strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("cloudflare purge status %d", resp.StatusCode)
	}
	return nil
}

// ── Social / Open Graph meta injection ─────────────────────────────────────
//
// Crawlers (Telegram, Discord, Twitter/X, Facebook) don't execute JS — they read
// only the server's first HTML response. To get a per-game share card we load the
// game from the DB and inject og:/twitter: tags + a real <title> into the shell
// before serving /game/{id}; every other route gets site-wide defaults. Same
// string-injection approach as the catalog snapshot — no schema/frontend change.
const (
	siteName       = "CYOA.CAFE"
	siteURL        = "https://cyoa.cafe"
	defaultOGTitle = "CYOA.CAFE — Choose Your Own Adventure catalog"
	defaultOGDesc  = "A catalog of interactive and image CYOAs. Browse, search and play Choose Your Own Adventure games."
	defaultOGImage = "https://cyoa.cafe/apple-touch-icon.png"
)

var (
	gamePathRe = regexp.MustCompile(`^game/([^/?#]+)`)
	htmlTagRe  = regexp.MustCompile(`<[^>]*>`)
	wsRe       = regexp.MustCompile(`\s+`)
)

// staticPageMeta gives the main app routes their own <title>/description instead of
// the generic site default. Keyed by the path WITHOUT a leading slash (home = "").
// `title` is the full branded <title>; the social og:title drops the " — CYOA.CAFE"
// suffix (the brand is already shown via og:site_name). Add a route here to give it
// its own SEO copy.
// noindexPaths — routes whose shell carries <meta name="robots" content="noindex">.
// The chat is here by the author's decision: a cosy room stops feeling private
// the moment its posts are searchable from outside (see spec §11).
// Matched by first segment, so /moderator/tickets is covered by "moderator".
var noindexPaths = map[string]bool{
	"chat-lab":  true,
	"cheat-lab": true,
	"moderator": true,
	"profile":   true,
}

func isNoindexPath(path string) bool {
	seg, _, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	return noindexPaths[seg]
}

var staticPageMeta = map[string]struct{ title, desc string }{
	"": {
		title: "CYOA.CAFE — Choose Your Own Adventure catalog",
		desc:  "A catalog of interactive and image CYOAs. Browse hundreds of Choose Your Own Adventure games, filter by tags, and search by theme.",
	},
	"search": {
		title: "Search CYOAs — CYOA.CAFE",
		desc:  "Search the CYOA catalog by tags, author, length and rating. Find the interactive and image Choose Your Own Adventure games you're after.",
	},
	"semantic-search": {
		title: "Smart search — CYOA.CAFE",
		desc:  "Describe the CYOA you want in your own words and find the closest matches by meaning, not just keywords — AI-powered semantic search.",
	},
	"hosting": {
		title: "Free CYOA hosting — CYOA.CAFE",
		desc:  "Host your Choose Your Own Adventure game for free, like Neocities for CYOAs: upload it, get a shareable link, and add it to the catalog.",
	},
	"privacy-policy": {
		title: "Privacy Policy — CYOA.CAFE",
		desc:  "How CYOA.CAFE handles your data and privacy.",
	},
	"terms-of-service": {
		title: "Terms of Service — CYOA.CAFE",
		desc:  "The terms for using CYOA.CAFE.",
	},
}

// plainExcerpt turns description HTML into a single-line plain-text excerpt capped
// at `max` runes (OG/Twitter descriptions are truncated past ~200 anyway).
func plainExcerpt(htmlStr string, max int) string {
	s := htmlTagRe.ReplaceAllString(htmlStr, " ")
	s = html.UnescapeString(s) // &amp;→&, … (re-escaped on output)
	s = strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
	r := []rune(s)
	if len(r) > max {
		s = strings.TrimSpace(string(r[:max])) + "…"
	}
	return s
}

// badgesFor builds the share-card description prefix: one badge from each of a few
// high-signal, controlled-vocabulary categories in a fixed order —
// Interactivity · Rating · Status(only if not Full) · Playtime · POV. This orients
// the reader ("is this for me?") without dumping tags or crowding out the
// description text (and without the platform-flag risk of listing kinks). The
// vocabularies are the prod tag_categories (mechanical tags), matched by lowercased
// name, so no per-request category lookup is needed. To tweak what shows, edit the
// ordered groups below. NB: kinks/sexual-role/tone are deliberately NOT here.
func badgesFor(app core.App, rec *core.Record) string {
	// Expand failures just mean the prefix carries fewer badges — non-fatal.
	app.ExpandRecord(rec, []string{"tags"}, nil)
	have := map[string]bool{}
	for _, t := range rec.ExpandedAll("tags") {
		if n := strings.ToLower(strings.TrimSpace(t.GetString("name"))); n != "" {
			have[n] = true
		}
	}
	// pick returns the display form of the first present option (lowercase→display),
	// scanning in the given priority order; "" if none of them are on the game.
	pick := func(opts ...[2]string) string {
		for _, o := range opts {
			if have[o[0]] {
				return o[1]
			}
		}
		return ""
	}
	var parts []string
	add := func(s string) {
		if s != "" {
			parts = append(parts, s)
		}
	}

	// Interactivity — prefer the tag; fall back to the img_or_link field.
	itx := pick(
		[2]string{"interactive", "Interactive"},
		[2]string{"interactive port", "Interactive"},
		[2]string{"interactive other", "Interactive"},
		[2]string{"static", "Static"},
	)
	if itx == "" {
		switch rec.GetString("img_or_link") {
		case "link":
			itx = "Interactive"
		case "img":
			itx = "Image CYOA"
		}
	}
	add(itx)

	// Rating — most severe wins.
	add(pick(
		[2]string{"extreme", "Extreme"},
		[2]string{"nsfw", "NSFW"},
		[2]string{"ecchi", "Ecchi"},
		[2]string{"sfw", "SFW"},
	))
	// Status — only "not finished" flags; "Full" (the common case) is omitted.
	add(pick(
		[2]string{"demo", "Demo"},
		[2]string{"upd", "Upd"},
		[2]string{"dlc", "DLC"},
	))
	// Playtime — shortest present wins (a game normally has one).
	add(pick(
		[2]string{"1min", "1min"}, [2]string{"5min", "5min"}, [2]string{"15min", "15min"},
		[2]string{"30min", "30min"}, [2]string{"60+min", "60+min"},
	))
	// POV.
	add(pick(
		[2]string{"malepov", "MalePov"}, [2]string{"fempov", "FemPov"},
		[2]string{"futapov", "FutaPov"}, [2]string{"monster pov", "Monster Pov"},
		[2]string{"custom pov", "Custom Pov"},
	))
	return strings.Join(parts, " · ")
}

// buildSocialMeta returns the <meta> block + page <title> for the given app path.
// cacheable is true for game pages (title/description/cover change rarely, so the
// enriched HTML is safe to edge-cache for an hour).
func buildSocialMeta(app core.App, path string) (metaBlock, pageTitle string, cacheable bool) {
	// socialDescBudget keeps og:/twitter: descriptions within the ~155-char window
	// most platforms show before truncating (Google SERP ~150-160, social ~125).
	const socialDescBudget = 155

	pageTitle = defaultOGTitle // for <title>: branded
	ogTitle := defaultOGTitle  // for og:/twitter:: brand shown separately via site_name
	desc := defaultOGDesc
	image := defaultOGImage
	pageURL := siteURL + "/" + path
	// noindex: set on /game/<key> that resolves to nothing (see below), and on
	// the private surfaces below. robots.txt already disallows them, but a
	// Disallow only asks a crawler not to *fetch* — a URL someone linked can
	// still land in the index as a bare title. The meta tag is what actually
	// keeps it out.
	noindex := isNoindexPath(path)

	if m := gamePathRe.FindStringSubmatch(path); m != nil {
		// The URL key is a pretty slug (or a legacy id / retired slug), so resolve it
		// the same way the frontend does — a plain FindRecordById only ever matched
		// the id form and left every /game/<slug> share with the site-wide default card.
		if rec := findGameByURLKey(app, m[1]); rec != nil {
			gameTitle := strings.TrimSpace(rec.GetString("title"))
			if gameTitle == "" {
				gameTitle = "Untitled Game"
			}
			// <title> carries the brand suffix (SEO/tab); og:title does NOT — social
			// cards already render og:site_name, so the suffix would just duplicate it.
			pageTitle = gameTitle + " — " + siteName
			ogTitle = gameTitle
			// Canonical URL is the pretty one, whichever form was requested — an
			// id/retired-slug share still declares the current /game/<slug>.
			pageURL = siteURL + "/game/" + gameURLKey(rec)

			// Cover, CF-resized to a social-friendly width (≈1200px wide cards).
			if img := rec.GetString("image"); img != "" {
				image = siteURL + "/cdn-cgi/image/width=1200,quality=80,format=auto" +
					"/api/files/" + rec.Collection().Id + "/" + rec.Id + "/" + img
			}

			// Description = "<badges> — <excerpt>", capped to the budget. The badge
			// prefix is kept whole; only the excerpt is trimmed to fit what remains.
			prefix := badgesFor(app, rec)
			budget := socialDescBudget
			if prefix != "" {
				budget -= len([]rune(prefix)) + 3 // " — "
			}
			if budget < 30 { // no room for meaningful body → badges only
				desc = prefix
			} else {
				body := plainExcerpt(rec.GetString("description"), budget)
				if prefix != "" && body != "" {
					desc = prefix + " — " + body
				} else if prefix != "" {
					desc = prefix
				} else {
					desc = body
				}
			}
			cacheable = true
		} else {
			// Deleted game / typo'd slug: the SPA still answers 200 with its "not
			// found" view, so tell crawlers not to index the URL (a soft 404 that
			// looks like the site's default page is worse than no page at all).
			noindex = true
		}
	} else if meta, ok := staticPageMeta[path]; ok {
		// Main app routes (home, search, hosting, …) get their own copy.
		pageTitle = meta.title
		ogTitle = strings.TrimSuffix(meta.title, " — "+siteName)
		desc = meta.desc
	}

	esc := html.EscapeString
	var b strings.Builder
	b.WriteString(`<meta property="og:type" content="website">`)
	b.WriteString(`<meta property="og:site_name" content="` + esc(siteName) + `">`)
	b.WriteString(`<meta property="og:title" content="` + esc(ogTitle) + `">`)
	b.WriteString(`<meta property="og:description" content="` + esc(desc) + `">`)
	b.WriteString(`<meta property="og:image" content="` + esc(image) + `">`)
	b.WriteString(`<meta property="og:url" content="` + esc(pageURL) + `">`)
	b.WriteString(`<meta name="twitter:card" content="summary_large_image">`)
	b.WriteString(`<meta name="twitter:title" content="` + esc(ogTitle) + `">`)
	b.WriteString(`<meta name="twitter:description" content="` + esc(desc) + `">`)
	b.WriteString(`<meta name="twitter:image" content="` + esc(image) + `">`)
	b.WriteString(`<meta name="description" content="` + esc(desc) + `">`)
	// Canonical: the SPA shell is reachable under query/hash variants and (on game
	// pages) the same content via different casing — a canonical URL tells search
	// engines which one to index, avoiding duplicate-content dilution.
	b.WriteString(`<link rel="canonical" href="` + esc(pageURL) + `">`)
	if noindex {
		b.WriteString(`<meta name="robots" content="noindex">`)
	}
	return b.String(), pageTitle, cacheable
}

// registerCatalogSnapshotRefresh rebuilds the inlined snapshot + purges the edge cache
// whenever a new game lands in the catalog (queue publish, God-mode upload, admin).
func registerCatalogSnapshotRefresh(app core.App) {
	app.OnRecordAfterCreateSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		catalogPurge.trigger(e.App)
		return e.Next()
	})
}

func buildCatalogScriptTag(app core.App) (string, error) {
	// Resolve the SFW-exclusion tag ids the same way the frontend does
	// (case-insensitive name match on "nsfw"/"extreme").
	var nsfwID, extremeID string
	tagRecs, err := app.FindRecordsByFilter("tags", "id != ''", "", 0, 0)
	if err != nil {
		return "", fmt.Errorf("load tags: %w", err)
	}
	for _, t := range tagRecs {
		switch strings.ToLower(t.GetString("name")) {
		case "nsfw":
			nsfwID = t.Id
		case "extreme":
			extremeID = t.Id
		}
	}

	// SFW array = nsfw/extreme excluded (anon/default view, edge-cache shared).
	filter := ""
	params := dbx.Params{}
	var clauses []string
	if nsfwID != "" {
		clauses = append(clauses, "tags.id != {:nsfw}")
		params["nsfw"] = nsfwID
	}
	if extremeID != "" {
		clauses = append(clauses, "tags.id != {:extreme}")
		params["extreme"] = extremeID
	}
	if len(clauses) > 0 {
		filter = strings.Join(clauses, " && ")
	}
	sfwJSON, err := buildCatalogItemsJSON(app, filter, params)
	if err != nil {
		return "", fmt.Errorf("sfw snapshot: %w", err)
	}

	// ALL array = no tag filter (the 'all' filter-mode home view). The blur
	// thumbnails are ~1px so there is no meaningful imagery in source; the inline
	// script renders this only when the cyoa_filter_mode cookie isn't 'sfw'.
	allJSON, err := buildCatalogItemsJSON(app, "", dbx.Params{})
	if err != nil {
		return "", fmt.Errorf("all snapshot: %w", err)
	}

	return "<script>window.__CATALOG__=" + sfwJSON +
		";window.__CATALOG_ALL__=" + allJSON + "</script>", nil
}

// buildCatalogItemsJSON loads the `-created` top page under `filter`, expands
// authors+tags, and marshals the getList-shaped items to JSON. Default
// json.Marshal escapes <, >, & and U+2028/2029, so the payload is safe to inline
// inside <script> (no </script> breakout from description HTML).
func buildCatalogItemsJSON(app core.App, filter string, params dbx.Params) (string, error) {
	// This direct DB read bypasses the API listRule ('hidden != true'), so soft-
	// hidden games must be excluded here explicitly or they leak into the inlined
	// snapshot. Sort mirrors the frontend "new" tab: bumps float a game up
	// (bumped_at is seeded to created on insert + backfilled, so the fallback
	// -created only covers pre-backfill records).
	if filter != "" {
		filter = "hidden != true && (" + filter + ")"
	} else {
		filter = "hidden != true"
	}
	records, err := app.FindRecordsByFilter("games", filter, "-bumped_at,-created", catalogSnapshotSize, 0, params)
	if err != nil {
		return "", fmt.Errorf("load games: %w", err)
	}
	if errs := app.ExpandRecords(records, []string{"authors", "tags"}, nil); len(errs) > 0 {
		// Non-fatal: expand failures just mean a card renders without authors/tags
		// until the confirming fetch lands. Log and keep going.
		log.Printf("Warn: catalog snapshot expand had %d errors", len(errs))
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		item := map[string]any{
			"id":             r.Id,
			"collectionId":   r.Collection().Id,
			"slug":           r.GetString("slug"), // pretty-URL key; GameCard links via gameCanonicalKey (slug||id)
			"title":          r.GetString("title"),
			"description":    r.GetString("description"),
			"image":          r.GetString("image"),
			"image_base64":   r.GetString("image_base64"),
			"upvotes_count":  r.GetInt("upvotes_count"),
			"comments_count": r.GetInt("comments_count"),
			// created + original_release: the "New"/fresh badge (GameCard →
			// isFreshOriginal) needs both. Without them, a game that drops off the
			// pinned strip into the general feed renders from this snapshot and
			// loses its badge until the live fetch reconciles. Mirror
			// CATALOG_GAME_FIELDS.
			"created":          r.GetString("created"),
			"original_release": r.GetBool("original_release"),
		}
		expand := map[string]any{}
		if authors := r.ExpandedAll("authors"); len(authors) > 0 {
			arr := make([]map[string]any, 0, len(authors))
			for _, a := range authors {
				arr = append(arr, map[string]any{"id": a.Id, "name": a.GetString("name")})
			}
			expand["authors"] = arr
		}
		if tags := r.ExpandedAll("tags"); len(tags) > 0 {
			arr := make([]map[string]any, 0, len(tags))
			for _, t := range tags {
				arr = append(arr, map[string]any{"id": t.Id, "name": t.GetString("name")})
			}
			expand["tags"] = arr
		}
		item["expand"] = expand
		items = append(items, item)
	}

	payload, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}
	return string(payload), nil
}

// distFileExists reports whether a concrete (non-index, non-dir) file exists in
// the embedded dist for this request path, so the SPA handler can let the static
// handler serve real files and reserve index.html (with injection) for app routes.
func distFileExists(fsys fs.FS, p string) bool {
	if p == "" || p == "index.html" {
		return false
	}
	f, err := fsys.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return false
	}
	return true
}

type TurnstileResponse struct {
	Success    bool     `json:"success"`
	ErrorCodes []string `json:"error-codes"`
}

var authLogger *slog.Logger

const traceLevel slog.Level = slog.Level(-8)

type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *statusRecorder) WriteHeader(status int) {
	if !r.wrote {
		r.status = status
		r.wrote = true
		r.ResponseWriter.WriteHeader(status)
	}
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wrote {
		r.status = http.StatusOK
		r.wrote = true
	}
	return r.ResponseWriter.Write(b)
}

func verifyTurnstile(token string) (bool, error) {
	secretKey := os.Getenv("TURNSTILE_SECRET_KEY")
	if secretKey == "" {
		return false, fmt.Errorf("TURNSTILE_SECRET_KEY is not set")
	}
	data := url.Values{}
	data.Set("secret", secretKey)
	data.Set("response", token)

	resp, err := http.PostForm(
		"https://challenges.cloudflare.com/turnstile/v0/siteverify",
		data,
	)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, err
	}

	var turnstileResp TurnstileResponse
	if err := json.Unmarshal(body, &turnstileResp); err != nil {
		return false, err
	}

	return turnstileResp.Success, nil
}

// mentionRE matches @username tokens in a comment body. Site usernames are
// alphanumerics plus a few separators; we require a non-word char before the
// "@" so embedded addresses (e.g. inside an email) don't trigger a mention.
var mentionRE = regexp.MustCompile(`(^|[^\w@])@([a-zA-Z0-9._-]{2,30})`)

// createCommentNotifications fans notifications out for a freshly posted
// comment. Best-effort: every failure is logged and swallowed so it can never
// affect the comment write itself. Recipients are deduplicated to one
// notification per user (priority reply > comment_on_game > mention) and the
// actor never notifies themselves.
func createCommentNotifications(app core.App, comment *core.Record, actorID, gameID string, parentID *string, content string) {
	coll, err := app.FindCollectionByNameOrId("notifications")
	if err != nil {
		log.Printf("notifications: collection missing, skipping fan-out: %v", err)
		return
	}

	// recipient id -> notification type; first write wins (priority order below).
	recipients := map[string]string{}
	add := func(userID, ntype string) {
		if userID == "" || userID == actorID {
			return
		}
		if _, exists := recipients[userID]; exists {
			return
		}
		recipients[userID] = ntype
	}

	// 1. Reply: the parent comment's author (highest priority).
	if parentID != nil && *parentID != "" {
		if parent, perr := app.FindRecordById("comments", *parentID); perr == nil {
			add(parent.GetString("author"), "reply")
		}
	}

	// 2. Comment on a game: the game's uploader — but only if it's a real owner,
	// not a system/import placeholder. Catalog imports are attributed to a
	// reserved system account ("Archive"); notifying it is pure noise, and when a
	// real person later signs into a same-named claimed account they'd get
	// spurious "someone commented on your game" pings for games they never
	// touched. Reserved accounts are never logged into, so skipping them is safe.
	if game, gerr := app.FindRecordById("games", gameID); gerr == nil {
		if up := game.GetString("uploader"); up != "" {
			if uploader, uerr := app.FindRecordById("users", up); uerr == nil && !uploader.GetBool("is_reserved") {
				add(up, "comment_on_game")
			}
		}
	}

	// 3. @mentions resolved to real usernames.
	for _, m := range mentionRE.FindAllStringSubmatch(content, -1) {
		user, uerr := app.FindFirstRecordByFilter("users", "username = {:u}", dbx.Params{"u": m[2]})
		if uerr != nil {
			continue
		}
		add(user.Id, "mention")
	}

	for userID, ntype := range recipients {
		n := core.NewRecord(coll)
		n.Set("recipient", userID)
		n.Set("type", ntype)
		n.Set("actor", actorID)
		n.Set("comment", comment.Id)
		n.Set("game", gameID)
		n.Set("read", false)
		if serr := app.Save(n); serr != nil {
			log.Printf("notifications: failed to create %s for %s: %v", ntype, userID, serr)
		}
	}
}

// moderatorMentionRE matches the special @moderator / @moderators summon token
// (case-insensitive). Like a normal mention it must be preceded by a non-word
// char so it doesn't fire mid-word.
var moderatorMentionRE = regexp.MustCompile(`(?i)(^|[^\w@])@moderators?\b`)

var validModKinds = map[string]bool{
	"wrong_author": true, "dead_link": true, "missing_images": true,
	"change_tag": true, "update_version": true, "relation": true,
	"duplicate": true, "illegal": true, "other": true,
}
var validModStatuses = map[string]bool{
	"open": true, "in_progress": true, "resolved": true, "trash": true,
}

// maybeCreateModRequest opens a moderation ticket when a comment summons the
// moderators with @moderator. The triggering comment is the public face of the
// request; the ticket carries the private state (status/assignee/internal note).
// Best-effort: failures are logged, never blocking the comment.
func maybeCreateModRequest(app core.App, comment *core.Record, requesterID, gameID, content string, modKind *string) {
	if !moderatorMentionRE.MatchString(content) {
		return
	}
	coll, err := app.FindCollectionByNameOrId("mod_requests")
	if err != nil {
		log.Printf("mod_requests: collection missing, skipping: %v", err)
		return
	}
	kind := "other"
	if modKind != nil && validModKinds[*modKind] {
		kind = *modKind
	}
	rec := core.NewRecord(coll)
	rec.Set("comment", comment.Id)
	rec.Set("game", gameID)
	rec.Set("requester", requesterID)
	rec.Set("kind", kind)
	rec.Set("status", "open")
	if err := app.Save(rec); err != nil {
		log.Printf("mod_requests: failed to create ticket: %v", err)
	}
}

// SQLite's page cache is allocated PER CONNECTION, and PocketBase's defaults are
// sized for a machine far bigger than our 1 vCPU / 961 MB droplet: cache_size(-32000)
// is 32 MB per connection with up to 120 data + 20 aux connections — a ~4.5 GB
// ceiling. In practice ~15 warm idle connections pinned `serve` at ~550 MB of
// anonymous memory (invisible in Go heap profiles: it lives inside the allocator of
// the pure-Go modernc.org/sqlite driver, not in the Go heap), the process hit its
// cgroup ceiling and the box spent hours in direct reclaim instead of serving.
// See wiki/log.md, entry 2026-07-29 (3).
//
// With the values below the worst case is (10+1 data + 4+1 aux) * 4 MB ≈ 64 MB.
// All of them are env-tunable so the box can be re-sized without a rebuild.
const (
	defaultSQLiteCacheKB   = 4000 // per connection
	defaultDataMaxOpenConn = 10
	defaultDataMaxIdleConn = 5
	defaultAuxMaxOpenConn  = 4
	defaultAuxMaxIdleConn  = 2
)

// envInt reads a positive integer from env, falling back to def.
func envInt(name string, def int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		log.Printf("Warning: ignoring invalid %s=%q, using %d", name, raw, def)
		return def
	}
	return v
}

// sqliteConnect mirrors core.DefaultDBConnect; only cache_size differs.
// The busy_timeout pragma must stay first — upstream blocks on it before WAL mode
// is negotiated, otherwise a concurrent connection can fail the mode switch.
func sqliteConnect(cacheKB int) core.DBConnectFunc {
	pragmas := fmt.Sprintf(
		"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=journal_size_limit(200000000)"+
			"&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)&_pragma=temp_store(MEMORY)"+
			"&_pragma=cache_size(-%d)", cacheKB)

	return func(dbPath string) (*dbx.DB, error) {
		return dbx.Open("sqlite", dbPath+pragmas)
	}
}

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("Info: No .env file found, using environment variables.")
	}

	dbCacheKB := envInt("PB_SQLITE_CACHE_KB", defaultSQLiteCacheKB)
	dataMaxOpen := envInt("PB_DATA_MAX_OPEN_CONNS", defaultDataMaxOpenConn)
	dataMaxIdle := envInt("PB_DATA_MAX_IDLE_CONNS", defaultDataMaxIdleConn)
	auxMaxOpen := envInt("PB_AUX_MAX_OPEN_CONNS", defaultAuxMaxOpenConn)
	auxMaxIdle := envInt("PB_AUX_MAX_IDLE_CONNS", defaultAuxMaxIdleConn)
	log.Printf("Info: SQLite pools — data %d/%d, aux %d/%d, cache %d KB per connection (worst case ~%d MB)",
		dataMaxOpen, dataMaxIdle, auxMaxOpen, auxMaxIdle, dbCacheKB,
		(dataMaxOpen+auxMaxOpen+2)*dbCacheKB/1024)

	app := pocketbase.NewWithConfig(pocketbase.Config{
		DataMaxOpenConns: dataMaxOpen,
		DataMaxIdleConns: dataMaxIdle,
		AuxMaxOpenConns:  auxMaxOpen,
		AuxMaxIdleConns:  auxMaxIdle,
		DBConnect:        sqliteConnect(dbCacheKB),
	})

	// `serve push-keys` — разовая генерация пары VAPID для веб-пушей.
	registerPushKeysCmd(app)

	// ┌─── ДОБАВЛЕНО: нужно для корректного парсинга флагов до регистрации плагинов ───┐
	app.RootCmd.ParseFlags(os.Args[1:])
	// └────────────────────────────────────────────────────────────────────────────────────┘

	configureLogging(app)

	hooksDir := "pb_hooks"
	if _, err := os.Stat(hooksDir); os.IsNotExist(err) {
		log.Printf("Info: Hooks directory '%s' not found, skipping JS hooks loading.", hooksDir)
	} else {
		jsvm.MustRegister(app, jsvm.Config{HooksDir: hooksDir})
		log.Printf("Info: Registered JS hooks from directory: %s", hooksDir)
	}

	// OAuth2-плагин строит discovery-метаданные (issuer + все эндпоинты) ОДИН РАЗ
	// внутри Register(), синхронно на этом шаге — то есть ДО того, как PocketBase
	// загрузит настройки из data.db (это происходит позже, в bootstrap). Поэтому
	// app.Settings().Meta.AppURL здесь = дефолт "http://localhost:8090", и issuer
	// в /.well-known/openid-configuration навсегда замерзает на localhost, что бы
	// ни стояло в Admin UI. Фиксируем прод-URL из env ДО регистрации.
	if appURL := os.Getenv("PB_APP_URL"); appURL != "" {
		app.Settings().Meta.AppURL = appURL
	}

	// ┌─── ДОБАВЛЕНО: Регистрация OAuth2 плагина ───┐
	oauth2.MustRegister(app, &oauth2.Config{
		BaseConfig: &oauth2.BaseConfig{
			AccessTokenLifespan:   time.Hour,
			AuthorizeCodeLifespan: time.Minute * 15,
			// PKCE защищает ПУБЛИЧНЫХ клиентов (SPA/мобилки) без секрета. Наш
			// единственный клиент — форум (Flarum floxum-oidc) — конфиденциальный:
			// у него есть client_secret и он аутентифицирует обмен кода через
			// client_secret_basic, что даёт ту же защиту. floxum PKCE не шлёт,
			// поэтому при EnforcePKCE=true вход ломался. Отключаем.
			EnforcePKCE:        false,
			RefreshTokenScopes: []string{}, // разрешить все скоупы для refresh
		},
		PathPrefix:     "/oauth2",
		UserCollection: "users",
		// Динамическая регистрация клиентов — отключаем,
		// ты будешь регистрировать клиентов вручную через Admin UI
		EnableRFC7591DynamicClientRegistration: false,
		// Protected Resource Metadata — можно включить, вреда нет
		EnableRFC9728ProtectedResourceMetadata: true,
	})
	// └─────────────────────────────────────────────┘

	// Осмысленные username при OAuth-регистрации + «сменить username однажды».
	registerUsernameHooks(app)

	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		// Диагностический порт на loopback: без него после всплеска памяти
		// известно только «сколько», но не «куда». Слепки снимает cyoa-watch.
		startPprof(func(format string, args ...any) {
			app.Logger().Info(fmt.Sprintf(format, args...))
		})

		// Ограничитель одновременных /api/*-запросов. Первым — чтобы отказ стоил
		// только проверки. См. overload.go: без потолка задержка на медленной
		// SQLite превращает обычные 7 rps в 200 хендлеров в памяти → своп-трэшинг
		// (инцидент 26.07.2026, час простоя).
		registerOverloadGuard(app.Logger(), e)

		// Middleware для логирования auth запросов
		e.Router.BindFunc(func(c *core.RequestEvent) error {
			if authLogger != nil && shouldLogAuthRequest(c.Request.URL.Path) {
				logAuthRequestStart(authLogger, c)

				recorder := &statusRecorder{
					ResponseWriter: c.Response,
					status:         0,
					wrote:          false,
				}
				originalResponse := c.Response
				c.Response = recorder

				err := c.Next()

				logAuthRequestEnd(authLogger, c, recorder, time.Now())

				c.Response = originalResponse

				return err
			}
			return c.Next()
		})

		// ── Forum SSO cookie rolling-refresh ─────────────────────────────────
		// A "forum-only" user's session on cyoa.cafe rides entirely on the
		// pb_auth cookie (a 30d mirror of the PB token) that the OAuth2
		// authorize endpoint adopts to make the forum→site hop a chain of
		// invisible redirects. That cookie is otherwise renewed ONLY by
		// visiting the main site (refreshAuth/syncSsoCookie in pocketbase.ts).
		// Someone who lives on forum.cyoa.cafe and never opens the main site
		// lets pb_auth die after 30d — then the silent hop turns into a visible
		// login form ("forum users keep getting logged out"). Slide the 30d
		// window on every successful hop: when /oauth2/auth is hit with a still
		// -valid pb_auth, reissue a fresh token and reset the cookie. The auth
		// token is a stateless JWT, so reissuing invalidates nothing. Cookie
		// attributes are byte-for-byte identical to the JS-set cookie so it
		// overwrites in place (same name+path+host) — no duplicate cookie.
		e.Router.BindFunc(func(c *core.RequestEvent) error {
			if c.Request.Method == http.MethodGet && c.Request.URL.Path == "/oauth2/auth" {
				if ck, cerr := c.Request.Cookie("pb_auth"); cerr == nil && ck.Value != "" {
					if rec, rerr := app.FindAuthRecordByToken(ck.Value, core.TokenTypeAuth); rerr == nil && rec != nil {
						if fresh, terr := rec.NewAuthToken(); terr == nil {
							http.SetCookie(c.Response, &http.Cookie{
								Name:     "pb_auth",
								Value:    fresh,
								Path:     "/oauth2",
								MaxAge:   2592000, // 30d, matches prod token duration
								Secure:   true,
								SameSite: http.SameSiteLaxMode,
							})
						}
					}
				}
			}
			return c.Next()
		})

		apiGroup := e.Router.Group("/api/custom")

		apiGroup.POST("/verify-turnstile", func(c *core.RequestEvent) error {
			token := c.Request.FormValue("token")
			if token == "" {
				return c.BadRequestError("Token required", nil)
			}

			success, err := verifyTurnstile(token)
			if err != nil {
				return c.InternalServerError("Failed to verify token", err)
			}
			if !success {
				return c.ForbiddenError("Turnstile verification failed", nil)
			}

			return c.JSON(http.StatusOK, map[string]bool{"success": true})
		})

		type CommentPayload struct {
			GameID   string  `json:"game_id"`
			ParentID *string `json:"parent_id"`
			Content  string  `json:"content"`
			ModKind  *string `json:"mod_kind"`
		}

		apiGroup.POST("/comments", func(c *core.RequestEvent) error {
			userID := c.Auth.Id
			payload := new(CommentPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}

			if payload.GameID == "" || payload.Content == "" {
				return c.BadRequestError("Missing game_id or content", nil)
			}

			// Rate limit: at most commentRateMax comments per author within
			// commentRateWindow. Keeps a single user from flooding a thread
			// (e.g. accidental double-posts or spam) without being annoying.
			const commentRateMax = 3
			const commentRateWindow = 10 * time.Minute
			since := time.Now().UTC().Add(-commentRateWindow).Format("2006-01-02 15:04:05.000Z")
			recent, rerr := app.FindRecordsByFilter(
				"comments", "author = {:author} && created >= {:since}", "", 0, 0,
				dbx.Params{"author": userID, "since": since},
			)
			if rerr == nil && len(recent) >= commentRateMax {
				return apis.NewApiError(
					http.StatusTooManyRequests,
					"You're posting too fast. Please wait a moment before commenting again.",
					nil,
				)
			}

			var newComment *core.Record
			var gameRecord *core.Record

			err := app.RunInTransaction(func(txApp core.App) error {
				commentsCollection, err := txApp.FindCollectionByNameOrId("comments")
				if err != nil {
					return fmt.Errorf("failed to find comments collection: %w", err)
				}

				newComment = core.NewRecord(commentsCollection)
				newComment.Set("content", payload.Content)
				newComment.Set("author", userID)
				newComment.Set("game", payload.GameID)

				if payload.ParentID != nil && *payload.ParentID != "" {
					newComment.Set("parent", *payload.ParentID)
				}

				if err := txApp.Save(newComment); err != nil {
					return fmt.Errorf("failed to save comment: %w", err)
				}

				isReply := payload.ParentID != nil && *payload.ParentID != ""
				if isReply {
					parent, err := txApp.FindRecordById("comments", *payload.ParentID)
					if err != nil {
						log.Printf(
							"Warning: could not find parent comment %s: %v",
							*payload.ParentID,
							err,
						)
					} else {
						parent.Set("children+", newComment.Id)
						if err := txApp.Save(parent); err != nil {
							return fmt.Errorf("failed to update parent comment: %w", err)
						}
					}
				}

				// Keep comments_count in sync for BOTH top-level comments and
				// replies — it feeds the catalog card counter. The relation list
				// game.comments only holds top-level comments, so the count is
				// recomputed from the true number of comment records for the game.
				gameRecord, err = txApp.FindRecordById("games", payload.GameID)
				if err != nil {
					log.Printf(
						"Warning: could not find game %s to update: %v",
						payload.GameID,
						err,
					)
				} else {
					if !isReply {
						gameRecord.Set("comments+", newComment.Id)
					}
					total, cerr := txApp.FindRecordsByFilter(
						"comments", "game = {:game}", "", 0, 0,
						dbx.Params{"game": payload.GameID},
					)
					if cerr == nil {
						gameRecord.Set("comments_count", len(total))
					}
					if err := txApp.Save(gameRecord); err != nil {
						return fmt.Errorf("failed to update game record: %w", err)
					}
				}

				return nil
			})

			if err != nil {
				return c.InternalServerError("Comment creation failed", err)
			}

			// Fan out notifications (best-effort, outside the transaction so a
			// notification failure can never roll back a successfully posted
			// comment). Notifies the game's uploader, the parent comment's
			// author, and any @mentioned users — deduplicated, never the actor.
			createCommentNotifications(app, newComment, userID, payload.GameID, payload.ParentID, payload.Content)

			// If the comment summons the moderators (@moderator), open a moderation
			// ticket. Also best-effort and outside the transaction.
			maybeCreateModRequest(app, newComment, userID, payload.GameID, payload.Content, payload.ModKind)

			finalCommentCount := 0
			if gameRecord != nil {
				finalCommentCount = gameRecord.GetInt("comments_count")
			}

			return c.JSON(
				http.StatusOK,
				map[string]any{"id": newComment.Id, "comments_count": finalCommentCount},
			)
		}).Bind(apis.RequireAuth())

		type CommentDeletePayload struct {
			CommentID string `json:"comment_id"`
		}

		// Delete a comment. Authors may delete their own; moderators may delete any.
		// Comments that still have replies are tombstoned (content blanked) so the
		// surrounding thread is preserved; leaf comments are hard-deleted.
		apiGroup.POST("/comments/delete", func(c *core.RequestEvent) error {
			payload := new(CommentDeletePayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			if payload.CommentID == "" {
				return c.BadRequestError("Missing comment_id", nil)
			}

			comment, err := app.FindRecordById("comments", payload.CommentID)
			if err != nil {
				return apis.NewNotFoundError("Comment not found", err)
			}

			isOwner := comment.GetString("author") == c.Auth.Id
			if !isOwner && !c.Auth.GetBool("isModerator") {
				return apis.NewForbiddenError("You can only delete your own comments", nil)
			}

			gameID := comment.GetString("game")

			if len(comment.GetStringSlice("children")) > 0 {
				// Tombstone: keep the record so the thread survives, but flag it
				// and wipe the original text. `content` is required, so it gets a
				// placeholder; the frontend keys the tombstone off the `deleted`
				// flag. The comment still counts, so comments_count is unchanged.
				comment.Set("deleted", true)
				comment.Set("content", "[deleted]")
				if err := app.Save(comment); err != nil {
					return c.InternalServerError("Failed to tombstone comment", err)
				}
			} else {
				if err := app.Delete(comment); err != nil {
					return c.InternalServerError("Failed to delete comment", err)
				}
				// Recompute the catalog counter from the true remaining count.
				if gameID != "" {
					if game, gerr := app.FindRecordById("games", gameID); gerr == nil {
						remaining, cerr := app.FindRecordsByFilter(
							"comments", "game = {:game}", "", 0, 0,
							dbx.Params{"game": gameID},
						)
						if cerr == nil {
							game.Set("comments_count", len(remaining))
							if err := app.Save(game); err != nil {
								return c.InternalServerError("Failed to update game record", err)
							}
						}
					}
				}
			}

			return c.JSON(http.StatusOK, map[string]bool{"success": true})
		}).Bind(apis.RequireAuth())

		type CommentPinPayload struct {
			CommentID string `json:"comment_id"`
			Pinned    bool   `json:"pinned"`
		}

		// Pin / unpin a comment (moderators only). Pinned top-level comments float
		// to the top of the thread. Only top-level comments may be pinned.
		apiGroup.POST("/comments/pin", func(c *core.RequestEvent) error {
			if !c.Auth.GetBool("isModerator") {
				return apis.NewForbiddenError("Only moderators can pin comments", nil)
			}
			payload := new(CommentPinPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			if payload.CommentID == "" {
				return c.BadRequestError("Missing comment_id", nil)
			}

			comment, err := app.FindRecordById("comments", payload.CommentID)
			if err != nil {
				return apis.NewNotFoundError("Comment not found", err)
			}
			if comment.GetString("parent") != "" {
				return c.BadRequestError("Only top-level comments can be pinned", nil)
			}

			comment.Set("pinned", payload.Pinned)
			if err := app.Save(comment); err != nil {
				return c.InternalServerError("Failed to update comment", err)
			}
			return c.JSON(http.StatusOK, map[string]bool{"success": true, "pinned": payload.Pinned})
		}).Bind(apis.RequireAuth())

		// Toggle a like on a comment. Mirrors the game-upvote handler: the caller's
		// id is added to / removed from the comment's `likes` relation and
		// `likes_count` is kept in sync. Written only here (comments.updateRule is
		// author-only and never carries likes from the client). No notification is
		// emitted — liking is high-frequency and would drown the bell.
		apiGroup.POST("/comments/{id}/like", func(c *core.RequestEvent) error {
			userID := c.Auth.Id
			commentID := c.Request.PathValue("id")

			var finalState bool
			var finalCount int

			err := app.RunInTransaction(func(txApp core.App) error {
				comment, err := txApp.FindRecordById("comments", commentID)
				if err != nil {
					return apis.NewNotFoundError("Comment not found", err)
				}

				likes := comment.GetStringSlice("likes")
				userIndex := -1
				for i, id := range likes {
					if id == userID {
						userIndex = i
						break
					}
				}

				if userIndex >= 0 {
					likes = append(likes[:userIndex], likes[userIndex+1:]...)
					finalState = false
				} else {
					likes = append(likes, userID)
					finalState = true
				}

				finalCount = len(likes)
				comment.Set("likes", likes)
				comment.Set("likes_count", finalCount)
				return txApp.Save(comment)
			})
			if err != nil {
				return err
			}
			return c.JSON(http.StatusOK, map[string]any{"id": commentID, "state": finalState, "count": finalCount})
		}).Bind(apis.RequireAuth())

		// Edit a comment's text. comments.updateRule is locked to Go-only, so this
		// is the single client path to edit — and it only ever touches `content`
		// (author-only, no tombstones). That closes the hole where a raw
		// PocketBase update let an author tamper with pinned/likes/author/game.
		type CommentEditPayload struct {
			CommentID string `json:"comment_id"`
			Content   string `json:"content"`
		}
		apiGroup.POST("/comments/edit", func(c *core.RequestEvent) error {
			payload := new(CommentEditPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			if payload.CommentID == "" || payload.Content == "" {
				return c.BadRequestError("Missing comment_id or content", nil)
			}
			comment, err := app.FindRecordById("comments", payload.CommentID)
			if err != nil {
				return apis.NewNotFoundError("Comment not found", err)
			}
			if comment.GetString("author") != c.Auth.Id {
				return apis.NewForbiddenError("You can only edit your own comments", nil)
			}
			if comment.GetBool("deleted") {
				return c.BadRequestError("Cannot edit a deleted comment", nil)
			}
			comment.Set("content", payload.Content)
			if err := app.Save(comment); err != nil {
				return c.InternalServerError("Failed to update comment", err)
			}
			return c.JSON(http.StatusOK, map[string]bool{"success": true})
		}).Bind(apis.RequireAuth())

		// Mark notifications as read. With no ids, marks ALL of the caller's
		// unread notifications read; with ids, only those (still scoped to the
		// caller so one user can't touch another's notifications).
		type NotifReadPayload struct {
			IDs []string `json:"ids"`
		}
		apiGroup.POST("/notifications/read", func(c *core.RequestEvent) error {
			userID := c.Auth.Id
			payload := new(NotifReadPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}

			filter := "recipient = {:user} && read = false"
			params := dbx.Params{"user": userID}
			if len(payload.IDs) > 0 {
				filter += " && id IN {:ids}"
				params["ids"] = payload.IDs
			}
			unread, err := app.FindRecordsByFilter("notifications", filter, "", 0, 0, params)
			if err != nil {
				return c.InternalServerError("Failed to load notifications", err)
			}
			for _, n := range unread {
				n.Set("read", true)
				if serr := app.Save(n); serr != nil {
					log.Printf("Warning: could not mark notification %s read: %v", n.Id, serr)
				}
			}
			return c.JSON(http.StatusOK, map[string]any{"success": true, "marked": len(unread)})
		}).Bind(apis.RequireAuth())

		// Update a moderation ticket (moderators only): triage its status, kind,
		// assignee or internal note. Only the provided fields change; assignee can
		// be cleared by sending an empty string.
		type ModRequestUpdatePayload struct {
			ID           string  `json:"id"`
			Status       *string `json:"status"`
			Kind         *string `json:"kind"`
			Assignee     *string `json:"assignee"`
			InternalNote *string `json:"internal_note"`
		}
		apiGroup.POST("/mod-requests/update", func(c *core.RequestEvent) error {
			if !c.Auth.GetBool("isModerator") {
				return apis.NewForbiddenError("Only moderators can update mod requests", nil)
			}
			payload := new(ModRequestUpdatePayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			if payload.ID == "" {
				return c.BadRequestError("Missing id", nil)
			}
			rec, err := app.FindRecordById("mod_requests", payload.ID)
			if err != nil {
				return apis.NewNotFoundError("Mod request not found", err)
			}
			if payload.Status != nil {
				if !validModStatuses[*payload.Status] {
					return c.BadRequestError("Invalid status", nil)
				}
				rec.Set("status", *payload.Status)
			}
			if payload.Kind != nil {
				if !validModKinds[*payload.Kind] {
					return c.BadRequestError("Invalid kind", nil)
				}
				rec.Set("kind", *payload.Kind)
			}
			if payload.Assignee != nil {
				rec.Set("assignee", *payload.Assignee)
			}
			if payload.InternalNote != nil {
				rec.Set("internal_note", *payload.InternalNote)
			}
			if err := app.Save(rec); err != nil {
				return c.InternalServerError("Failed to update mod request", err)
			}
			return c.JSON(http.StatusOK, map[string]any{"success": true})
		}).Bind(apis.RequireAuth())

		apiGroup.POST("/upvotes/{id}", func(c *core.RequestEvent) error {
			userID := c.Auth.Id
			gameID := c.Request.PathValue("id")

			var finalState bool
			var finalCount int

			err := app.RunInTransaction(func(txApp core.App) error {
				record, err := txApp.FindRecordById("games", gameID)
				if err != nil {
					log.Printf(
						"Upvote error: failed to find game %s. Actual error: %v",
						gameID,
						err,
					)
					return apis.NewNotFoundError("Game not found", err)
				}

				upvotes := record.GetStringSlice("upvotes")
				userLiked := false
				userIndex := -1

				for i, id := range upvotes {
					if id == userID {
						userLiked = true
						userIndex = i
						break
					}
				}

				if userLiked {
					upvotes = append(upvotes[:userIndex], upvotes[userIndex+1:]...)
					finalState = false
				} else {
					upvotes = append(upvotes, userID)
					finalState = true
				}

				finalCount = len(upvotes)
				record.Set("upvotes", upvotes)
				record.Set("upvotes_count", finalCount)

				return txApp.Save(record)
			})

			if err != nil {
				return err
			}

			return c.JSON(
				http.StatusOK,
				map[string]any{"id": gameID, "state": finalState, "count": finalCount},
			)
		}).Bind(apis.RequireAuth())

		// ── Tag voting ──────────────────────────────────────────────────
		// The whole tag-vote lifecycle is server-side so a user can only ever
		// add/remove THEMSELVES from a vote (no rigging someone else's
		// upVoters), and the privileged games.tags write happens under app
		// auth. game_tag_votes create/update is locked to the backend and
		// games.updateRule is moderator-only; the frontend only reads votes.
		//
		// Two independent scales share the single `votes` int:
		//   • Proposed tag — a suggestion not yet on the game. Encoded in a
		//     reserved low band: votes = proposedBase + miniScore, so any
		//     votes <= proposedBandMax means "proposed". miniScore = up - down
		//     on a small -5..+5 ballot; the author's own upvote starts it at
		//     +1. miniScore >= promoteAt promotes it to an accepted tag at a
		//     neutral 0 (ballot consumed, appended to games.tags); miniScore <=
		//     dropAt (or losing all support) deletes the proposal.
		//   • Accepted tag — already on the game. votes = up - down directly.
		//     score <= deleteAt removes the tag from the game (record deleted).
		// A seeded tag with no record yet counts as an accepted tag at 0.
		apiGroup.POST("/tag-vote", func(c *core.RequestEvent) error {
			const (
				proposedBase    = -1000 // proposed score = proposedBase + miniScore
				proposedBandMax = -500  // votes <= this  ⇒ proposed (accepted never gets this low)
				promoteAt       = 5     // proposed miniScore ≥ this ⇒ accepted at 0
				dropAt          = -5    // proposed miniScore ≤ this ⇒ proposal removed
				deleteAt        = -15   // accepted score ≤ this ⇒ tag removed from game
				goldThreshold   = 15    // accepted score ≥ this in an eligible category ⇒ gold
			)
			// Categories where a "gold" defining tag is meaningful. Mirrors the
			// frontend GOLD_ELIGIBLE (TagDisplay.tsx) and the Python backfill — keep
			// all three in sync. A gold tag's id is denormalized onto games.gold_tags
			// so the catalog can flag it without loading per-tag vote scores.
			goldEligible := map[string]bool{
				"POV": true, "Player Sexual Role": true, "Gameplay": true,
				"Genre": true, "Setting": true, "Tone": true,
				"Narrative Structure": true, "Power Level": true,
				"Visual Style": true, "Kinks": true, "Custom": true,
			}
			type TagVotePayload struct {
				GameID string `json:"game_id"`
				TagID  string `json:"tag_id"`
				Action string `json:"action"` // upvote | downvote | clear
			}
			userID := c.Auth.Id
			payload := new(TagVotePayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			if payload.GameID == "" || payload.TagID == "" {
				return c.BadRequestError("Missing game_id or tag_id", nil)
			}
			if payload.Action != "upvote" && payload.Action != "downvote" && payload.Action != "clear" {
				return c.BadRequestError("Invalid action", nil)
			}

			sliceWithout := func(s []string, v string) []string {
				out := make([]string, 0, len(s))
				for _, x := range s {
					if x != v {
						out = append(out, x)
					}
				}
				return out
			}
			sliceHas := func(s []string, v string) bool {
				for _, x := range s {
					if x == v {
						return true
					}
				}
				return false
			}
			// Add/remove a tag id in the game's denormalized gold_tags list.
			// Returns true if the slice changed (caller saves the game).
			setGold := func(g *core.Record, tagID string, want bool) bool {
				cur := g.GetStringSlice("gold_tags")
				has := sliceHas(cur, tagID)
				if want && !has {
					g.Set("gold_tags", append(cur, tagID))
					return true
				}
				if !want && has {
					g.Set("gold_tags", sliceWithout(cur, tagID))
					return true
				}
				return false
			}

			var voteRec *core.Record
			var activated bool
			var deleted bool

			err := app.RunInTransaction(func(txApp core.App) error {
				game, gerr := txApp.FindRecordById("games", payload.GameID)
				if gerr != nil {
					return apis.NewNotFoundError("Game not found", gerr)
				}

				vote, verr := txApp.FindFirstRecordByFilter(
					"game_tag_votes", "gameId = {:g} && tagId = {:t}",
					dbx.Params{"g": payload.GameID, "t": payload.TagID},
				)
				inGameTags := sliceHas(game.GetStringSlice("tags"), payload.TagID)

				isNew := verr != nil

				// Proposed vs accepted. A brand-new record is a proposal only when
				// the tag isn't already on the game; the first vote on a seeded or
				// already-accepted tag starts an ordinary up-down tally.
				var proposed bool
				if isNew {
					proposed = !inGameTags
					if proposed && payload.Action != "upvote" {
						return apis.NewNotFoundError("Vote not found", verr)
					}
					if !proposed && payload.Action == "clear" {
						return apis.NewNotFoundError("Vote not found", verr)
					}
					coll, cerr := txApp.FindCollectionByNameOrId("game_tag_votes")
					if cerr != nil {
						return cerr
					}
					vote = core.NewRecord(coll)
					vote.Set("gameId", payload.GameID)
					vote.Set("tagId", payload.TagID)
				} else {
					proposed = vote.GetInt("votes") <= proposedBandMax
				}

				up := sliceWithout(vote.GetStringSlice("upVoters"), userID)
				down := sliceWithout(vote.GetStringSlice("downVoters"), userID)
				switch payload.Action {
				case "upvote":
					up = append(up, userID)
				case "downvote":
					down = append(down, userID)
				case "clear":
					// already removed from both above
				}
				vote.Set("upVoters", up)
				vote.Set("downVoters", down)

				if proposed {
					mini := len(up) - len(down)
					switch {
					case mini >= promoteAt:
						// Won its mini-election → fresh accepted tag at neutral 0
						// (the ballot is consumed) and appended to games.tags below.
						vote.Set("upVoters", []string{})
						vote.Set("downVoters", []string{})
						vote.Set("votes", 0)
						activated = true
					case mini <= dropAt || (len(up) == 0 && len(down) == 0):
						// Rejected, or no support left — drop the proposal.
						if !isNew {
							if derr := txApp.Delete(vote); derr != nil {
								return derr
							}
						}
						deleted = true
						return nil
					default:
						vote.Set("votes", proposedBase+mini)
					}
				} else {
					score := len(up) - len(down)
					if score <= deleteAt {
						// Community pushed the tag off the game.
						tags := game.GetStringSlice("tags")
						gameDirty := setGold(game, payload.TagID, false)
						if sliceHas(tags, payload.TagID) {
							game.Set("tags", sliceWithout(tags, payload.TagID))
							gameDirty = true
						}
						if gameDirty {
							if err := txApp.Save(game); err != nil {
								return fmt.Errorf("failed to remove tag from game: %w", err)
							}
						}
						if !isNew {
							if derr := txApp.Delete(vote); derr != nil {
								return derr
							}
						}
						deleted = true
						return nil
					}
					if len(up) == 0 && len(down) == 0 {
						// No tally left on an accepted tag — drop the empty record
						// instead of persisting a zero-vote ghost. The tag itself
						// stays on the game via games.tags; the record is recreated
						// on the next vote. (Mirrors the proposed branch above.)
						// Score is 0 here, so it can no longer be gold.
						if setGold(game, payload.TagID, false) {
							if err := txApp.Save(game); err != nil {
								return fmt.Errorf("failed to update gold_tags: %w", err)
							}
						}
						if !isNew {
							if derr := txApp.Delete(vote); derr != nil {
								return derr
							}
						}
						deleted = true
						return nil
					}
					vote.Set("votes", score)

					// Gold denormalization: a tag is gold at goldThreshold+ in an
					// eligible category. Only the voted tag can change (gold is
					// per-tag, no per-game cap), so we touch just this one id.
					wantGold := false
					if score >= goldThreshold {
						cat, cerr := txApp.FindFirstRecordByFilter(
							"tag_categories", "tags ~ {:t}",
							dbx.Params{"t": payload.TagID},
						)
						if cerr == nil && goldEligible[cat.GetString("name")] {
							wantGold = true
						}
					}
					if setGold(game, payload.TagID, wantGold) {
						if err := txApp.Save(game); err != nil {
							return fmt.Errorf("failed to update gold_tags: %w", err)
						}
					}
				}

				if err := txApp.Save(vote); err != nil {
					return fmt.Errorf("failed to save tag vote: %w", err)
				}
				voteRec = vote

				if activated {
					tags := game.GetStringSlice("tags")
					if !sliceHas(tags, payload.TagID) {
						game.Set("tags", append(tags, payload.TagID))
						if err := txApp.Save(game); err != nil {
							return fmt.Errorf("failed to add tag to game: %w", err)
						}
					}
				}
				return nil
			})
			if err != nil {
				return err
			}

			resp := map[string]any{"activated": activated, "deleted": deleted}
			if voteRec != nil {
				resp["vote"] = map[string]any{
					"id":         voteRec.Id,
					"gameId":     voteRec.GetString("gameId"),
					"tagId":      voteRec.GetString("tagId"),
					"votes":      voteRec.GetInt("votes"),
					"upVoters":   voteRec.GetStringSlice("upVoters"),
					"downVoters": voteRec.GetStringSlice("downVoters"),
				}
			}
			return c.JSON(http.StatusOK, resp)
		}).Bind(apis.RequireAuth())

		// Crawler files, registered before either catch-all below — otherwise the SPA
		// fallback answers /robots.txt and /sitemap.xml with the HTML shell.
		registerSEORoutes(app, e)

		// Web push (VAPID). No keys in env → only /push/key answers, with
		// enabled:false, and the frontend hides the toggle.
		registerPushRoutes(app, e)

		isDevelopment := os.Getenv("NODE_ENV") == "development"
		if isDevelopment {
			log.Println(
				"Info: Running in development mode. Proxying frontend requests to http://localhost:8091",
			)
			remoteURL, err := url.Parse("http://localhost:8091")
			if err != nil {
				return err
			}
			proxy := httputil.NewSingleHostReverseProxy(remoteURL)
			e.Router.GET("/{path...}", func(c *core.RequestEvent) error {
				proxy.ServeHTTP(c.Response, c.Request)
				return nil
			})
		} else {
			log.Println(
				"Info: Running in production mode. Serving static files from embedded 'dist' directory.",
			)
			distDirFS, err := fs.Sub(assets, "dist")
			if err != nil {
				return err
			}
			earlyHintsLink := buildEarlyHintsLink(distDirFS)
			if earlyHintsLink != "" {
				log.Printf("Info: Early Hints Link header active: %s", earlyHintsLink)
			}

			// Read the SPA shell once; app routes get the catalog snapshot inlined.
			indexData, ierr := fs.ReadFile(distDirFS, "index.html")
			if ierr != nil {
				return fmt.Errorf("read index.html: %w", ierr)
			}
			indexHTML := string(indexData)

			// Build the default-catalog snapshot now and refresh it on a timer so
			// the origin always has a ready string to inline (see catalogSnapshot).
			// catalogInliningActive flips on here (prod only) so the games-create hook
			// rebuilds + purges; dev (vite proxy) never reaches this branch.
			catalogInliningActive = true
			catalogSnap.refresh(app)
			if catalogSnap.get() != "" {
				log.Println("Info: catalog snapshot inlining active")
			}
			go func() {
				ticker := time.NewTicker(5 * time.Minute)
				defer ticker.Stop()
				for range ticker.C {
					catalogSnap.refresh(app)
				}
			}()
			// Serve /assets/* with immutable cache headers and real 404 (no SPA fallback).
			// This prevents CF from caching index.html as a CSS/JS file during deploys.
			e.Router.GET("/assets/{path...}", func(c *core.RequestEvent) error {
				filePath := c.Request.PathValue("path")
				f, err := distDirFS.Open("assets/" + filePath)
				if err != nil {
					return c.NoContent(http.StatusNotFound)
				}
				defer f.Close()
				stat, err := f.Stat()
				if err != nil || stat.IsDir() {
					return c.NoContent(http.StatusNotFound)
				}
				c.Response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				http.ServeContent(c.Response, c.Request, stat.Name(), stat.ModTime(), f.(io.ReadSeeker))
				return nil
			})
			staticHandler := apis.Static(distDirFS, true)
			e.Router.GET("/{path...}", func(c *core.RequestEvent) error {
				p := c.Request.PathValue("path")
				// Real files (favicon.ico, manifest, robots.txt, ...) → static handler.
				if distFileExists(distDirFS, p) {
					return staticHandler(c)
				}
				// App route → serve the SPA shell with the catalog snapshot inlined.
				// Attach the Early Hints preload header so CF can replay it as a 103.
				if earlyHintsLink != "" {
					c.Response.Header().Set("Link", earlyHintsLink)
				}
				doc := indexHTML
				if snippet := catalogSnap.get(); snippet != "" {
					doc = strings.Replace(doc, "</head>", snippet+"</head>", 1)
				}
				// Per-game (or default) Open Graph / Twitter card + real <title> for
				// link-share previews and crawlers (which never run the React title set).
				metaBlock, pageTitle, cacheable := buildSocialMeta(app, p)
				doc = strings.Replace(doc, "</head>", metaBlock+"</head>", 1)
				doc = strings.Replace(doc, "<title>CYOA.CAFE</title>",
					"<title>"+html.EscapeString(pageTitle)+"</title>", 1)
				if cacheable {
					c.Response.Header().Set("Cache-Control", "public, max-age=3600")
				}
				// Belt and braces with the <meta robots> tag: a header also covers
				// crawlers that only fetch headers, and can't be lost to any HTML
				// rewriting on the edge.
				if isNoindexPath(p) {
					c.Response.Header().Set("X-Robots-Tag", "noindex")
				}
				c.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
				c.Response.WriteHeader(http.StatusOK)
				_, werr := c.Response.Write([]byte(doc))
				return werr
			})
		}

		return e.Next()
	})

	// hosting
	registerHostingRoutes(app)

	// шаутбокс (мини-чат сайта) — фиче-флаг SHOUTBOX_ENABLED
	registerShoutbox(app)

	// drip-feed публикация из очереди (game_pipeline_state → games)
	registerPublicationQueue(app)
	registerPublicationQueueAPI(app)

	// Пробелы по краям названий (игры/авторы/теги) — режем на входе в БД.
	// До registerGameEdits: слаг мнётся из уже чистого title (см. trim_names.go).
	registerNameTrim(app)

	// Правки карточек + бампы (append-only журнал game_revisions, архив файлов).
	registerGameEdits(app)

	// First-party счётчик просмотров игр (пишем всегда, показываем пока только
	// модератору на /moderator — коллекция game_views создаётся сама).
	registerViewCounter(app)

	// Рулетка бампов: сообщество голосует за игры, раз в сутки крон бампает одну
	// (bump_votes/bump_draws/bump_settings создаются сами, как game_views).
	registerBumpRoulette(app)

	// новая игра в каталоге → пересобрать инлайн-снимок + сбросить edge-кэш HTML
	registerCatalogSnapshotRefresh(app)

	// новая/удалённая игра → пересобрать sitemap.xml (см. seo.go)
	registerSitemapInvalidation(app)

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

func configureLogging(app *pocketbase.PocketBase) {
	resolvedLevel := resolveLogLevel()

	handlerOpts := &slog.HandlerOptions{
		AddSource: false,
		Level:     resolvedLevel,
	}

	authLogger = slog.
		New(slog.NewTextHandler(os.Stdout, handlerOpts)).
		With(slog.String("component", "auth-debug"))

	app.Logger().Info(
		"auth tracing logger initialized",
		slog.String("component", "auth-debug"),
		slog.String("level", levelToString(resolvedLevel)),
		slog.String("pb_log_level_env", os.Getenv("PB_LOG_LEVEL")),
		slog.String("pb_debug_env", os.Getenv("PB_DEBUG")),
	)
}

func resolveLogLevel() slog.Level {
	if os.Getenv("PB_DEBUG") == "1" {
		return slog.LevelDebug
	}

	switch strings.ToLower(os.Getenv("PB_LOG_LEVEL")) {
	case "trace":
		return traceLevel
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelDebug
	}
}

func levelToString(level slog.Level) string {
	switch level {
	case traceLevel:
		return "trace"
	case slog.LevelDebug:
		return "debug"
	case slog.LevelInfo:
		return "info"
	case slog.LevelWarn:
		return "warn"
	case slog.LevelError:
		return "error"
	default:
		return fmt.Sprintf("%d", level)
	}
}

func logAuthRequestStart(l *slog.Logger, c *core.RequestEvent) {
	path := c.Request.URL.Path
	queryValues := c.Request.URL.Query()

	reqAttrs := []slog.Attr{
		slog.String("method", c.Request.Method),
		slog.String("path", path),
		slog.Any("query", sanitizeQuery(queryValues)),
		slog.String("remote_ip", requestIP(c.Request)),
		slog.String("user_agent", c.Request.UserAgent()),
	}

	if provider := extractOAuthProvider(path); provider != "" {
		reqAttrs = append(reqAttrs, slog.String("provider", provider))
	}

	if state := queryValues.Get("state"); state != "" {
		reqAttrs = append(reqAttrs, slog.Int("state_length", len(state)))
	}

	if c.Auth != nil && c.Auth.Id != "" {
		reqAttrs = append(reqAttrs, slog.String("auth_record_id", c.Auth.Id))
	}

	l.LogAttrs(context.Background(), slog.LevelDebug, "auth request started", reqAttrs...)
}

func logAuthRequestEnd(l *slog.Logger, c *core.RequestEvent, recorder *statusRecorder, start time.Time) {
	path := c.Request.URL.Path
	queryValues := c.Request.URL.Query()

	status := recorder.status
	if status == 0 {
		status = http.StatusOK
	}

	duration := time.Since(start)
	respAttrs := []slog.Attr{
		slog.String("method", c.Request.Method),
		slog.String("path", path),
		slog.Int("status", status),
		slog.Int64("duration_ms", duration.Milliseconds()),
	}

	if location := c.Response.Header().Get("Location"); location != "" {
		respAttrs = append(respAttrs, slog.String("location", location))
	}

	if errParam := queryValues.Get("error"); errParam != "" {
		respAttrs = append(respAttrs, slog.String("oauth_error", errParam))
	}
	if desc := queryValues.Get("error_description"); desc != "" {
		respAttrs = append(respAttrs, slog.String("oauth_error_description", desc))
	}

	if status >= 400 {
		l.LogAttrs(
			context.Background(),
			slog.LevelWarn,
			"auth request finished with failure status",
			respAttrs...,
		)
	} else {
		l.LogAttrs(context.Background(), slog.LevelDebug, "auth request finished", respAttrs...)
	}
}

func shouldLogAuthRequest(path string) bool {
	lower := strings.ToLower(path)
	switch {
	case strings.Contains(lower, "oauth"):
		return true
	case strings.HasPrefix(lower, "/_/auth"):
		return true
	case strings.HasPrefix(lower, "/api/users/auth"):
		return true
	case strings.HasPrefix(lower, "/api/admins/auth"):
		return true
	case strings.HasPrefix(lower, "/api/auth"):
		return true
	default:
		return false
	}
}

func extractOAuthProvider(path string) string {
	segments := strings.Split(path, "/")
	for i := 0; i < len(segments); i++ {
		if segments[i] == "oauth2" && i+1 < len(segments) {
			candidate := segments[i+1]
			if candidate == "" {
				continue
			}
			switch strings.ToLower(candidate) {
			case "callback", "redirect", "authorize", "request":
				continue
			}
			return candidate
		}
	}
	return ""
}

func sanitizeQuery(values url.Values) map[string]string {
	if len(values) == 0 {
		return nil
	}

	sanitized := make(map[string]string, len(values))
	for key, vals := range values {
		joined := strings.Join(vals, ",")
		lower := strings.ToLower(key)

		switch {
		case strings.Contains(lower, "code"),
			strings.Contains(lower, "token"),
			strings.Contains(lower, "secret"),
			strings.Contains(lower, "password"):
			sanitized[key] = "[redacted]"
		default:
			if len(joined) > 512 {
				sanitized[key] = joined[:512] + "…"
			} else {
				sanitized[key] = joined
			}
		}
	}

	return sanitized
}

func requestIP(r *http.Request) string {
	if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
		parts := strings.Split(xf, ",")
		if len(parts) > 0 {
			return strings.TrimSpace(parts[0])
		}
	}

	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		return xr
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}

	return r.RemoteAddr
}
