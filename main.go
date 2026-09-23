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
	"path/filepath"
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

	oauth2 "github.com/DragonsWho/pocketbase-ext-oauth2"
)

// NB: plain `dist` (not `all:dist`) — `all:` would also embed dot/underscore files, including
// `.fuse_hidden*` copies ntfs-3g leaves when `dist/serve` is replaced while running (a whole stale
// copy of the binary). Real frontend assets never start with `.`/`_`.
//
//go:embed dist
var assets embed.FS

// Deploy survival: the only copy of /assets/* lives inside the binary, and `make ship` replaces it
// wholesale, so every hashed chunk of the previous build vanishes on restart while open tabs still
// hold the OLD index.html → their next lazy route import (~20 in App.tsx) 404s → blank screen. Fix:
// `make ship` also rsyncs each build's dist/assets/ into a never-truncated store dir on the server.
// Embedded copy first; the store answers only for retired chunks. Names are content hashes, so
// merging is safe. Missing store → old behaviour (404).
var assetsStoreFS fs.FS

// How long a retired chunk stays reachable: only has to outlive open tabs.
const assetsStoreKeep = 60 * 24 * time.Hour

// Store location independent of CWD (systemd unit need not set WorkingDirectory): ASSETS_STORE_DIR,
// else sibling of the binary's dir (/root/cyoa-cafe/dist/serve → /root/cyoa-cafe/assets_store),
// else a relative path. "" if none exists.
func resolveAssetsStoreDir() string {
	var candidates []string
	if env := os.Getenv("ASSETS_STORE_DIR"); env != "" {
		candidates = append(candidates, env)
	} else {
		if exe, err := os.Executable(); err == nil {
			candidates = append(candidates, filepath.Join(filepath.Dir(exe), "..", "assets_store"))
		}
		candidates = append(candidates, "assets_store")
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return ""
}

func initAssetsStore() {
	dir := resolveAssetsStoreDir()
	if dir == "" {
		log.Println("Info: assets store inactive — chunks of previous builds will 404 after a deploy")
		return
	}
	// os.DirFS enforces fs.ValidPath, so "../" can't escape the store.
	assetsStoreFS = os.DirFS(dir)
	log.Printf("Info: assets store active: %s", dir)
	go pruneAssetsStoreLoop(dir)
}

func pruneAssetsStoreLoop(dir string) {
	for {
		cutoff := time.Now().Add(-assetsStoreKeep)
		entries, err := os.ReadDir(dir)
		if err != nil {
			log.Printf("Warn: assets store prune failed: %v", err)
			return
		}
		removed := 0
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			info, ierr := e.Info()
			if ierr != nil || !info.ModTime().Before(cutoff) {
				continue
			}
			if rerr := os.Remove(filepath.Join(dir, e.Name())); rerr == nil {
				removed++
			}
		}
		if removed > 0 {
			log.Printf("Info: assets store pruned %d file(s) older than %s", removed, assetsStoreKeep)
		}
		time.Sleep(24 * time.Hour)
	}
}

func openAsset(distDirFS fs.FS, p string) (fs.File, error) {
	f, err := distDirFS.Open("assets/" + p)
	if err == nil {
		return f, nil
	}
	if assetsStoreFS == nil {
		return nil, err
	}
	return assetsStoreFS.Open(p)
}

// Early Hints: entry bundle names from index.html go into a `Link: rel=preload` header; CF (Early
// Hints on) replays it as 103 from the cached HTML. CF honours only preload/preconnect (not
// modulepreload). `crossorigin` must match Vite's tags or the preload isn't consumed and the file
// is fetched twice.
var assetJSRe = regexp.MustCompile(`<script[^>]+\bsrc="(/assets/[^"]+\.js)"`)
var assetCSSRe = regexp.MustCompile(`<link[^>]+\bhref="(/assets/[^"]+\.css)"`)

// appBuild = hashed entry-bundle name of the served FRONTEND build. Open tabs poll /api/app-build
// and silently refresh when it changes (src/utils/autoUpdate.ts). Deliberately not a Go build
// stamp: server-only deploys (most of them) don't disturb tabs.
var appBuild string

func buildAppBuild(distDirFS fs.FS) string {
	data, err := fs.ReadFile(distDirFS, "index.html")
	if err != nil {
		return ""
	}
	m := assetJSRe.FindStringSubmatch(string(data))
	if m == nil {
		return ""
	}
	return strings.TrimPrefix(m[1], "/assets/")
}

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

// Catalog snapshot inlining: cold-visit CLS was "empty shell → cards pop in later" (can't fetch
// until the 670K bundle parses). The default home view is inlined into index.html as
// `window.__CATALOG__` so SearchPage seeds its grid before any network round-trip. Same for every
// anon visitor — `-created` top page, SFW (nsfw/extreme tags excluded), shaped like a games getList
// with expand=authors,tags and the CATALOG_GAME_FIELDS whitelist (incl. image_base64) — so the doc
// stays shared and CF rule [R6] edge-caches it. Frontend seeds only on the exact default SFW home
// view, then a normal fetch reconciles by id. Rebuilt in-process on a timer.
const catalogSnapshotSize = 25

// Package var so the games-create hook (registerCatalogSnapshotRefresh) can rebuild it immediately.
// catalogInliningActive keeps the hook inert in dev (vite proxy, no embedded dist); only the prod
// serve branch sets it.
var (
	catalogSnap           = &catalogSnapshot{}
	catalogInliningActive bool
	catalogPurge          = &cfPurger{}
)

type catalogSnapshot struct {
	mu        sync.RWMutex
	scriptTag string
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

// On error keep the previous value (frontend falls back to its normal fetch).
func (s *catalogSnapshot) refresh(app core.App) {
	tag, err := buildCatalogScriptTag(app)
	if err != nil {
		log.Printf("Warn: catalog snapshot refresh failed: %v", err)
		return
	}
	s.set(tag)
}

// cfPurger coalesces a burst of publishes into one CF purge (a new game changes the "recent" set,
// so the edge-cached shell with a stale snapshot must go). Counts (likes/comments) are NOT purged —
// the 5-min snapshot timer covers them.
type cfPurger struct {
	mu      sync.Mutex
	pending bool
}

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
		time.Sleep(15 * time.Second)
		p.mu.Lock()
		p.pending = false
		p.mu.Unlock()
		catalogSnap.refresh(app)
		if err := purgeCatalogHTMLCache(); err != nil {
			app.Logger().Warn("catalog HTML cache purge failed", "error", err.Error())
			return
		}
		app.Logger().Info("catalog HTML cache purged after new game publish")
	}()
}

func purgeCatalogHTMLCache() error {
	return purgeCFURLs([]string{"https://cyoa.cafe", "https://cyoa.cafe/", "https://cyoa.cafe/search"})
}

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

// Social/OG meta: crawlers (Telegram, Discord, X, Facebook) don't run JS; for /game/{id} we load
// the game and inject og:/twitter: tags + real <title> into the shell; other routes get site
// defaults.
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

// staticPageMeta: per-route <title>/description, keyed by path without leading slash (home = "").
// og:title drops the " — CYOA.CAFE" suffix (og:site_name shows the brand). noindexPaths: routes
// whose shell carries robots noindex, matched by first segment (/moderator/tickets → "moderator").
// Chat is noindex by the author's decision: a cosy room stops feeling private once its posts are
// searchable (spec §11).
var noindexPaths = map[string]bool{
	"chat": true,
	// Old chat lab URLs and feed-lab stands: frontend redirects them, but their shell is still noindex
	// so an old link can't lead a bot into a catalog duplicate.
	"moderator": true,
	"profile":   true,
	// These used to be robots.txt Disallow. That didn't work: Disallow forbids FETCHING the page,
	// hence reading noindex, and a linked URL still sat in the index as a bare title. Now the bot
	// enters and reads the noindex.
	"add-next":      true,
	"confirm-email": true,
	"create":        true,
	"login":         true,
	"recovery":      true,
	"verification":  true,
	"log":           true,
	"roulette":      true,
}

func isNoindexPath(path string) bool {
	seg, _, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	// Any "*-lab" route is noindex by name: labs come and go constantly and none may reach search.
	if isLabPath(seg) {
		return true
	}
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
	// Chat isn't indexed, so this is the tab title / PWA shortcut name, not SEO copy.
	"chat": {
		title: "Chat — CYOA.CAFE",
		desc:  "The CYOA.CAFE chat: rooms, images and direct messages.",
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

func plainExcerpt(htmlStr string, max int) string {
	s := htmlTagRe.ReplaceAllString(htmlStr, " ")
	s = html.UnescapeString(s)
	s = strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
	r := []rune(s)
	if len(r) > max {
		s = strings.TrimSpace(string(r[:max])) + "…"
	}
	return s
}

// badgesFor builds the share-card description prefix: one badge per high-signal category in fixed
// order — Interactivity · Rating · Status (only if not Full) · Playtime · POV. Vocabularies are
// prod tag_categories matched by lowercase name (no per-request lookup). Kinks/sexual-role/tone are
// deliberately NOT here (platform-flag risk).
func badgesFor(app core.App, rec *core.Record) string {
	app.ExpandRecord(rec, []string{"tags"}, nil)
	have := map[string]bool{}
	for _, t := range rec.ExpandedAll("tags") {
		if n := strings.ToLower(strings.TrimSpace(t.GetString("name"))); n != "" {
			have[n] = true
		}
	}
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

	add(pick(
		[2]string{"extreme", "Extreme"},
		[2]string{"nsfw", "NSFW"},
		[2]string{"ecchi", "Ecchi"},
		[2]string{"sfw", "SFW"},
	))
	add(pick(
		[2]string{"demo", "Demo"},
		[2]string{"upd", "Upd"},
		[2]string{"dlc", "DLC"},
	))
	add(pick(
		[2]string{"1min", "1min"}, [2]string{"5min", "5min"}, [2]string{"15min", "15min"},
		[2]string{"30min", "30min"}, [2]string{"60+min", "60+min"},
	))
	add(pick(
		[2]string{"malepov", "MalePov"}, [2]string{"fempov", "FemPov"},
		[2]string{"futapov", "FutaPov"}, [2]string{"monster pov", "Monster Pov"},
		[2]string{"custom pov", "Custom Pov"},
	))
	return strings.Join(parts, " · ")
}

// buildSocialMeta: cacheable=true for game pages (safe to edge-cache 1h). notFound=true for phantom
// URLs (/en…) or a /game/<key> resolving to nothing → caller answers 404 (shell still served;
// frontend catch-all sends the human home). redirectTo set when reached by a non-canonical key
// (legacy id, retired slug) → caller answers 301.
func buildSocialMeta(app core.App, path string) (metaBlock, pageTitle string, cacheable, notFound bool, redirectTo string) {
	const socialDescBudget = 155

	pageTitle = defaultOGTitle
	ogTitle := defaultOGTitle
	desc := defaultOGDesc
	image := defaultOGImage
	pageURL := siteURL + "/" + path
	// noindex on unresolvable /game/<key> and private surfaces: a Disallow only asks not to fetch; a
	// linked URL still lands in the index as a bare title. The meta tag keeps it out.
	noindex := isNoindexPath(path)
	jsonLD := ""

	if m := gamePathRe.FindStringSubmatch(path); m != nil {
		// Resolve the key (slug / legacy id / retired slug) the same way the frontend does — plain
		// FindRecordById left every /game/<slug> share with the default card.
		if rec := findGameByURLKey(app, m[1]); rec != nil {
			gameTitle := strings.TrimSpace(rec.GetString("title"))
			if gameTitle == "" {
				gameTitle = "Untitled Game"
			}
			pageTitle = gameTitle + " — " + siteName
			ogTitle = gameTitle
			// Canonical is always the current pretty /game/<slug>, whatever form was requested.
			pageURL = siteURL + "/game/" + gameURLKey(rec)
			// Canonical alone leaves both URLs alive (Google merges slowly, people copy the old form). A 301
			// settles it.
			if m[1] != gameURLKey(rec) {
				redirectTo = "/game/" + gameURLKey(rec)
				return
			}

			if img := rec.GetString("image"); img != "" {
				image = siteURL + "/cdn-cgi/image/width=1200,quality=80,format=auto" +
					"/api/files/" + rec.Collection().Id + "/" + rec.Id + "/" + img
			}

			prefix := badgesFor(app, rec)
			budget := socialDescBudget
			if prefix != "" {
				budget -= len([]rune(prefix)) + 3
			}
			if budget < 30 {
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
			jsonLD = gameJSONLD(app, rec, pageURL, image, gameTitle)
			cacheable = true
		} else {
			// Deleted game / typo'd slug: SPA shows its own "not found" (no redirect — the reader asked for
			// a specific game), but the response is 404 + noindex so a dead slug never lingers as a soft
			// 404.
			noindex = true
			notFound = true
		}
	} else if meta, ok := staticPageMeta[path]; ok {
		pageTitle = meta.title
		ogTitle = strings.TrimSuffix(meta.title, " — "+siteName)
		desc = meta.desc
	}

	if !isKnownAppPath(path) {
		noindex = true
		notFound = true
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
	// No canonical for phantom URLs: self-canonical invites keeping the duplicate, "/" would launder
	// it into a home-page alias. 404 + noindex is the whole answer.
	if !notFound {
		b.WriteString(`<link rel="canonical" href="` + esc(pageURL) + `">`)
	}
	if noindex {
		b.WriteString(`<meta name="robots" content="noindex">`)
	}
	b.WriteString(jsonLD)
	return b.String(), pageTitle, cacheable, notFound, ""
}

func registerCatalogSnapshotRefresh(app core.App) {
	app.OnRecordAfterCreateSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		catalogPurge.trigger(e.App)
		return e.Next()
	})
}

func buildCatalogScriptTag(app core.App) (string, error) {
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

	// ALL array (the 'all' filter-mode view). Blur thumbnails are ~1px so no meaningful imagery in
	// source; the inline script uses it only when the cyoa_filter_mode cookie isn't 'sfw'.
	allJSON, err := buildCatalogItemsJSON(app, "", dbx.Params{})
	if err != nil {
		return "", fmt.Errorf("all snapshot: %w", err)
	}

	return "<script>window.__CATALOG__=" + sfwJSON +
		";window.__CATALOG_ALL__=" + allJSON + "</script>", nil
}

// Default json.Marshal escapes <, >, & and U+2028/2029, so the payload is safe inside <script> (no
// </script> breakout from description HTML).
func buildCatalogItemsJSON(app core.App, filter string, params dbx.Params) (string, error) {
	// Direct DB read bypasses the listRule ('hidden != true'): exclude soft-hidden games explicitly or
	// they leak into the snapshot. Sort mirrors the frontend "new" tab (-bumped_at).
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
		log.Printf("Warn: catalog snapshot expand had %d errors", len(errs))
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		item := map[string]any{
			"id":             r.Id,
			"collectionId":   r.Collection().Id,
			"slug":           r.GetString("slug"),
			"title":          r.GetString("title"),
			"description":    r.GetString("description"),
			"image":          r.GetString("image"),
			"image_base64":   r.GetString("image_base64"),
			"upvotes_count":  r.GetInt("upvotes_count"),
			"comments_count": r.GetInt("comments_count"),
			// created + original_release are needed by the "New" badge (GameCard → isFreshOriginal); without
			// them a game falling off the pinned strip loses its badge until the live fetch. Mirror
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

// distFileExists: real files go to the static handler; index.html (with injection) is reserved for
// app routes.
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

// Non-word char required before "@" so email addresses don't trigger a mention.
var mentionRE = regexp.MustCompile(`(^|[^\w@])@([a-zA-Z0-9._-]{2,30})`)

// Best-effort (never affects the comment write). One notification per recipient (priority reply >
// comment_on_game > mention); the actor never notifies themselves.
func createCommentNotifications(app core.App, comment *core.Record, actorID, gameID string, parentID *string, content string) {
	coll, err := app.FindCollectionByNameOrId("notifications")
	if err != nil {
		log.Printf("notifications: collection missing, skipping fan-out: %v", err)
		return
	}

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

	if parentID != nil && *parentID != "" {
		if parent, perr := app.FindRecordById("comments", *parentID); perr == nil {
			add(parent.GetString("author"), "reply")
		}
	}

	// Skip reserved/system uploaders: catalog imports are attributed to a reserved account
	// ("Archive"); notifying it is noise, and a person later claiming a same-named account would get
	// pings for games they never touched.
	if game, gerr := app.FindRecordById("games", gameID); gerr == nil {
		if up := game.GetString("uploader"); up != "" {
			if uploader, uerr := app.FindRecordById("users", up); uerr == nil && !uploader.GetBool("is_reserved") {
				add(up, "comment_on_game")
			}
		}
	}

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

var moderatorMentionRE = regexp.MustCompile(`(?i)(^|[^\w@])@moderators?\b`)

var validModKinds = map[string]bool{
	"wrong_author": true, "dead_link": true, "missing_images": true,
	"change_tag": true, "update_version": true, "relation": true,
	"duplicate": true, "illegal": true, "other": true,
}
var validModStatuses = map[string]bool{
	"open": true, "in_progress": true, "resolved": true, "trash": true,
}

// @moderator in a comment opens a mod_requests ticket: the comment is the public face, the ticket
// holds private state (status/assignee/internal note). Best-effort.
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

// SQLite page cache is PER CONNECTION and PocketBase defaults suit a far bigger machine than our 1
// vCPU / 961 MB droplet: cache_size(-32000) = 32 MB/connection × up to 120 data + 20 aux = ~4.5 GB
// ceiling. ~15 warm idle connections pinned `serve` at ~550 MB anonymous memory (invisible in Go
// heap profiles: it's inside the pure-Go modernc sqlite allocator), hit the cgroup ceiling, and the
// box spent hours in direct reclaim. See wiki/log.md 2026-07-29 (3). Worst case now (10+1 + 4+1) ×
// 4 MB ≈ 64 MB. All env-tunable.
const (
	defaultSQLiteCacheKB   = 4000
	defaultDataMaxOpenConn = 10
	defaultDataMaxIdleConn = 5
	defaultAuxMaxOpenConn  = 4
	defaultAuxMaxIdleConn  = 2
)

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

// Mirrors core.DefaultDBConnect; only cache_size differs. busy_timeout must stay FIRST — upstream
// blocks on it before WAL mode is negotiated, otherwise a concurrent connection can fail the mode
// switch.
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

	registerPushKeysCmd(app)
	registerSeedCmd(app)

	app.RootCmd.ParseFlags(os.Args[1:])

	configureLogging(app)

	hooksDir := "pb_hooks"
	if _, err := os.Stat(hooksDir); os.IsNotExist(err) {
		log.Printf("Info: Hooks directory '%s' not found, skipping JS hooks loading.", hooksDir)
	} else {
		jsvm.MustRegister(app, jsvm.Config{HooksDir: hooksDir})
		log.Printf("Info: Registered JS hooks from directory: %s", hooksDir)
	}

	// The OAuth2 plugin builds discovery metadata (issuer + endpoints) ONCE inside Register(),
	// synchronously — BEFORE PocketBase loads settings from data.db. So Settings().Meta.AppURL is
	// still "http://localhost:8090" and the issuer in /.well-known/openid-configuration freezes on
	// localhost regardless of Admin UI. Set the prod URL from env before registering.
	if appURL := os.Getenv("PB_APP_URL"); appURL != "" {
		app.Settings().Meta.AppURL = appURL
	}

	oauth2.MustRegister(app, &oauth2.Config{
		BaseConfig: &oauth2.BaseConfig{
			AccessTokenLifespan:   time.Hour,
			AuthorizeCodeLifespan: time.Minute * 15,
			// PKCE protects PUBLIC clients. Our only client — the forum (Flarum floxum-oidc) — is
			// confidential (client_secret_basic), same protection. floxum doesn't send PKCE, so
			// EnforcePKCE=true broke login.
			EnforcePKCE:        false,
			RefreshTokenScopes: []string{},
		},
		PathPrefix:     "/oauth2",
		UserCollection: "users",
		// Dynamic client registration off; clients are registered by hand in Admin UI.
		EnableRFC7591DynamicClientRegistration: false,
		EnableRFC9728ProtectedResourceMetadata: true,
	})

	registerUsernameHooks(app)
	registerModAuditHooks(app)

	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		// Loopback diagnostic port: after a memory spike we'd otherwise know only "how much", not
		// "where". Profiles are taken by cyoa-watch.
		startPprof(func(format string, args ...any) {
			app.Logger().Info(fmt.Sprintf(format, args...))
		})

		// Concurrency limiter for /api/*, registered FIRST so a rejection costs only this check. See
		// overload.go: without a ceiling, slow SQLite turns a normal 7 rps into 200 in-memory handlers →
		// swap thrash (incident 2026-07-26, one hour down).
		registerOverloadGuard(app.Logger(), e)

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

		// Forum SSO cookie rolling refresh: a forum-only user's session rides on the pb_auth cookie (30d
		// mirror of the PB token) that /oauth2/auth adopts for the invisible forum→site hop. It's
		// otherwise renewed only by visiting the main site (refreshAuth/syncSsoCookie in pocketbase.ts),
		// so forum-only users got a login form after 30d. On every hop with a still-valid pb_auth,
		// reissue the token and reset the cookie (stateless JWT, nothing invalidated). Cookie attributes
		// byte-for-byte identical to the JS-set cookie so it overwrites in place.
		e.Router.BindFunc(func(c *core.RequestEvent) error {
			if c.Request.Method == http.MethodGet && c.Request.URL.Path == "/oauth2/auth" {
				if ck, cerr := c.Request.Cookie("pb_auth"); cerr == nil && ck.Value != "" {
					if rec, rerr := app.FindAuthRecordByToken(ck.Value, core.TokenTypeAuth); rerr == nil && rec != nil {
						if fresh, terr := rec.NewAuthToken(); terr == nil {
							http.SetCookie(c.Response, &http.Cookie{
								Name:     "pb_auth",
								Value:    fresh,
								Path:     "/oauth2",
								MaxAge:   2592000,
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

				// comments_count counts BOTH top-level comments and replies (catalog counter). game.comments
				// only lists top-level ones, so recount real comment records.
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

			// Notifications outside the transaction: a notification failure must never roll back a posted
			// comment.
			createCommentNotifications(app, newComment, userID, payload.GameID, payload.ParentID, payload.Content)

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

		// Authors delete their own, moderators any. Comments with replies are tombstoned (content
		// blanked) to keep the thread; leaves are hard-deleted.
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
			if !isOwner && !hasPerm(c, permComments) {
				return apis.NewForbiddenError("You can only delete your own comments", nil)
			}

			gameID := comment.GetString("game")

			// Snapshot before the change so a moderator deletion can be undone by hand.
			commentBefore := modSnapshot(comment, "author", "game", "parent", "content", "deleted", "pinned")

			if len(comment.GetStringSlice("children")) > 0 {
				// Tombstone: `content` is required → placeholder; frontend keys off `deleted`. Still counts,
				// comments_count unchanged.
				comment.Set("deleted", true)
				comment.Set("content", "[deleted]")
				if err := app.Save(comment); err != nil {
					return c.InternalServerError("Failed to tombstone comment", err)
				}
			} else {
				if err := app.Delete(comment); err != nil {
					return c.InternalServerError("Failed to delete comment", err)
				}
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

			logModAction(app, c, modAction{
				Action:     "comment.delete",
				Target:     payload.CommentID,
				Game:       gameID,
				Before:     commentBefore,
				Reversible: true,
				Note:       commentDeleteNote(comment),
			})

			return c.JSON(http.StatusOK, map[string]bool{"success": true})
		}).Bind(apis.RequireAuth())

		type CommentPinPayload struct {
			CommentID string `json:"comment_id"`
			Pinned    bool   `json:"pinned"`
		}

		apiGroup.POST("/comments/pin", func(c *core.RequestEvent) error {
			if !hasPerm(c, permComments) {
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

			wasPinned := comment.GetBool("pinned")
			comment.Set("pinned", payload.Pinned)
			if err := app.Save(comment); err != nil {
				return c.InternalServerError("Failed to update comment", err)
			}
			logModAction(app, c, modAction{
				Action:     "comment.pin",
				Target:     payload.CommentID,
				Game:       comment.GetString("game"),
				Before:     map[string]any{"pinned": wasPinned},
				After:      map[string]any{"pinned": payload.Pinned},
				Reversible: true,
			})
			return c.JSON(http.StatusOK, map[string]bool{"success": true, "pinned": payload.Pinned})
		}).Bind(apis.RequireAuth())

		// Like toggle, mirrors game upvote. Written only here (comments.updateRule is author-only and
		// never carries likes). No notification — too high-frequency.
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

		// comments.updateRule is Go-only, so this is the single client edit path and it only touches
		// `content` — closes the hole where a raw PB update let an author tamper with
		// pinned/likes/author/game.
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

		type NotifReadPayload struct {
			IDs      []string          `json:"ids"`
			Messages map[string]string `json:"messages"`
			Through  string            `json:"through"`
		}
		apiGroup.POST("/notifications/read", func(c *core.RequestEvent) error {
			userID := c.Auth.Id
			payload := new(NotifReadPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}

			marked, err := chatMarkNotificationsRead(app, userID, payload.IDs, payload.Messages, payload.Through)
			if err != nil {
				return c.InternalServerError("Failed to mark notifications read", err)
			}
			return c.JSON(http.StatusOK, map[string]any{"success": true, "marked": len(marked), "ids": marked})
		}).Bind(apis.RequireAuth())

		type ModRequestUpdatePayload struct {
			ID           string  `json:"id"`
			Status       *string `json:"status"`
			Kind         *string `json:"kind"`
			Assignee     *string `json:"assignee"`
			InternalNote *string `json:"internal_note"`
		}
		apiGroup.POST("/mod-requests/update", func(c *core.RequestEvent) error {
			if !hasPerm(c, permTickets) {
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
			ticketFields := []string{"status", "kind", "assignee", "internal_note"}
			ticketBefore := modSnapshot(rec, ticketFields...)
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
			logModAction(app, c, modAction{
				Action:     "mod_request.update",
				Target:     payload.ID,
				Game:       rec.GetString("game"),
				Before:     ticketBefore,
				After:      modSnapshot(rec, ticketFields...),
				Reversible: true,
			})
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

		// Tag voting, fully server-side: a user can only add/remove THEMSELVES from a vote, and
		// games.tags is written under app auth (game_tag_votes create/update backend-only;
		// games.updateRule moderator-only). One `votes` int, two scales: PROPOSED (tag not on the game)
		// lives in a reserved low band: votes = proposedBase + miniScore (votes <= proposedBandMax ⇒
		// proposed); miniScore = up−down on a −5..+5 ballot, author's upvote starts it at +1; >=
		// promoteAt → accepted at 0 (ballot consumed, appended to games.tags); <= dropAt or no support →
		// deleted. ACCEPTED: votes = up−down; <= deleteAt removes the tag. A seeded tag with no record =
		// accepted at 0.
		// INVARIANT: `votes` is ALWAYS len(upVoters) − len(downVoters) (shifted into the band for
		// proposals). Never write a score the voter lists don't reproduce — that made tallies jump and
		// silently snap back. Hence moderators have NO vote weight: mod_override is a decision, not extra
		// points.
		apiGroup.POST("/tag-vote", func(c *core.RequestEvent) error {
			const (
				proposedBase    = -1000
				proposedBandMax = -500
				promoteAt       = 5
				dropAt          = -5
				deleteAt        = -15
				goldThreshold   = 15
			)
			// Mirrors frontend GOLD_ELIGIBLE (TagDisplay.tsx) and the Python backfill — keep all three in
			// sync. Gold tag ids are denormalized onto games.gold_tags so the catalog needn't load per-tag
			// scores.
			goldEligible := map[string]bool{
				"POV": true, "Player Sexual Role": true, "Gameplay": true,
				"Genre": true, "Setting": true, "Tone": true,
				"Narrative Structure": true, "Power Level": true,
				"Visual Style": true, "Kinks": true, "Custom": true,
			}
			type TagVotePayload struct {
				GameID      string `json:"game_id"`
				TagID       string `json:"tag_id"`
				Action      string `json:"action"`
				ModOverride bool   `json:"mod_override"`
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
			// Moderator decision log: filled inside the transaction, written after it commits, so
			// rolled-back actions never reach mod_actions.
			var modJournal *modAction

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

				// A new record is a proposal only if the tag isn't on the game; first vote on a seeded/accepted
				// tag starts a plain up−down tally.
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
				}
				voteBefore := map[string]any{
					"votes":      vote.GetInt("votes"),
					"upVoters":   vote.GetStringSlice("upVoters"),
					"downVoters": vote.GetStringSlice("downVoters"),
				}
				vote.Set("upVoters", up)
				vote.Set("downVoters", down)

				// mod_override ("Approve/Remove as moderator") applies immediately. A plain carousel click by a
				// moderator weighs 1 like anyone's, so a misclick never nukes a tag. Deciding needs an explicit
				// direction — "clear" decides nothing.
				modDecision := ""
				if hasPerm(c, permTags) && payload.ModOverride {
					switch payload.Action {
					case "upvote":
						modDecision = "accept"
					case "downvote":
						modDecision = "remove"
					}
				}

				upCount, downCount := len(up), len(down)

				// "Approve" on a tag already on the game and not negative: nothing to decide. The accept branch
				// zeroes both vote columns and drops gold, so this silently wiped a live score (15+ votes) and
				// gold status. Downgrade to a plain upvote: moderator check stays, score intact. See
				// wiki/components/moderator-access.md §5.
				modNoop := false
				if modDecision == "accept" && !proposed && inGameTags && upCount-downCount >= 0 {
					modDecision = ""
					modNoop = true
				}

				if hasPerm(c, permTags) && payload.ModOverride {
					before := map[string]any{
						"votes":      voteBefore["votes"],
						"upVoters":   voteBefore["upVoters"],
						"downVoters": voteBefore["downVoters"],
						"onGame":     inGameTags,
						"gold":       sliceHas(game.GetStringSlice("gold_tags"), payload.TagID),
					}
					note := "moderator override: " + payload.Action
					if modNoop {
						note = "moderator override downgraded to a plain upvote — tag was already accepted with a non-negative score"
					}
					modJournal = &modAction{
						Action:     "tag.mod_override",
						Target:     payload.TagID,
						Game:       payload.GameID,
						Before:     before,
						Reversible: true,
						Note:       note,
					}
				}

				switch {
				case modDecision == "remove":
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

				case modDecision == "accept":
					vote.Set("upVoters", []string{})
					vote.Set("downVoters", []string{})
					vote.Set("votes", 0)
					if setGold(game, payload.TagID, false) {
						if err := txApp.Save(game); err != nil {
							return fmt.Errorf("failed to update gold_tags: %w", err)
						}
					}
					activated = true

				case proposed:
					mini := upCount - downCount
					switch {
					case mini >= promoteAt:
						vote.Set("upVoters", []string{})
						vote.Set("downVoters", []string{})
						vote.Set("votes", 0)
						activated = true
					case mini <= dropAt || (len(up) == 0 && len(down) == 0):
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

				default:
					score := upCount - downCount
					if score <= deleteAt {
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
						// No tally left on an accepted tag → delete the empty record instead of a zero-vote ghost
						// (tag stays via games.tags; record recreated on next vote).
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

			if modJournal != nil {
				after := map[string]any{"activated": activated, "deleted": deleted}
				if voteRec != nil {
					after["votes"] = voteRec.GetInt("votes")
					after["upVoters"] = voteRec.GetStringSlice("upVoters")
					after["downVoters"] = voteRec.GetStringSlice("downVoters")
				}
				modJournal.After = after
				logModAction(app, c, *modJournal)
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

		// Registered before both catch-alls, otherwise the SPA fallback answers /robots.txt and
		// /sitemap.xml with the HTML shell.
		registerSEORoutes(app, e)

		// Build marker for silent self-update of open tabs. Empty in dev. Never cache: it IS the signal.
		e.Router.GET("/api/app-build", func(c *core.RequestEvent) error {
			c.Response.Header().Set("Cache-Control", "no-store")
			return c.JSON(http.StatusOK, map[string]string{"build": appBuild})
		})

		// No VAPID keys in env → only /push/key answers (enabled:false), frontend hides the toggle.
		registerPushRoutes(app, e)

		registerAccountEmailRoutes(app, e)
		registerModCommentRoutes(app, e)

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
			initAssetsStore()

			appBuild = buildAppBuild(distDirFS)
			log.Printf("Info: frontend build marker: %q", appBuild)

			earlyHintsLink := buildEarlyHintsLink(distDirFS)
			if earlyHintsLink != "" {
				log.Printf("Info: Early Hints Link header active: %s", earlyHintsLink)
			}

			indexData, ierr := fs.ReadFile(distDirFS, "index.html")
			if ierr != nil {
				return fmt.Errorf("read index.html: %w", ierr)
			}
			indexHTML := string(indexData)

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
			// /assets/* with immutable headers and a real 404 (no SPA fallback), so CF never caches
			// index.html as a CSS/JS file during deploys.
			e.Router.GET("/assets/{path...}", func(c *core.RequestEvent) error {
				filePath := c.Request.PathValue("path")
				// Current build first, then the retired-chunks store (openAsset): tabs opened before the deploy
				// still ask for old chunks.
				f, err := openAsset(distDirFS, filePath)
				if err != nil {
					return c.NoContent(http.StatusNotFound)
				}
				defer f.Close()
				stat, err := f.Stat()
				if err != nil || stat.IsDir() {
					return c.NoContent(http.StatusNotFound)
				}
				rs, ok := f.(io.ReadSeeker)
				if !ok {
					return c.NoContent(http.StatusNotFound)
				}
				c.Response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				http.ServeContent(c.Response, c.Request, stat.Name(), stat.ModTime(), rs)
				return nil
			})
			staticHandler := apis.Static(distDirFS, true)
			e.Router.GET("/{path...}", func(c *core.RequestEvent) error {
				p := c.Request.PathValue("path")
				if distFileExists(distDirFS, p) {
					return staticHandler(c)
				}
				if earlyHintsLink != "" {
					c.Response.Header().Set("Link", earlyHintsLink)
				}
				doc := indexHTML
				if snippet := catalogSnap.get(); snippet != "" {
					doc = strings.Replace(doc, "</head>", snippet+"</head>", 1)
				}
				metaBlock, pageTitle, cacheable, notFound, redirectTo := buildSocialMeta(app, p)
				if redirectTo != "" {
					if q := c.Request.URL.RawQuery; q != "" {
						redirectTo += "?" + q
					}
					c.Response.Header().Set("Cache-Control", "public, max-age=3600")
					return c.Redirect(http.StatusMovedPermanently, redirectTo)
				}
				doc = strings.Replace(doc, "</head>", metaBlock+"</head>", 1)
				doc = strings.Replace(doc, "<title>CYOA.CAFE</title>",
					"<title>"+html.EscapeString(pageTitle)+"</title>", 1)
				if cacheable && !notFound {
					c.Response.Header().Set("Cache-Control", "public, max-age=3600")
				}
				// X-Robots-Tag header alongside <meta robots>: covers header-only crawlers and survives any
				// edge HTML rewriting.
				if isNoindexPath(p) || notFound {
					c.Response.Header().Set("X-Robots-Tag", "noindex")
				}
				c.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
				// A missing page says so in the status line (the only signal crawlers trust); the shell still
				// goes out so the frontend catch-all walks the human home. no-store is only the origin's
				// intent: CF rule "[R7] SPA HTML" overrides it (edge 1h, browser 120s), so a 404 IS pinned at
				// the edge for an hour (verified). What prevents a forgotten route from 404ing is
				// TestKnownAppPathsMatchFrontendRoutes, which fails the build. Edge-caching junk-path 404s is
				// otherwise a feature: scanners never reach origin.
				status := http.StatusOK
				if notFound {
					status = http.StatusNotFound
					c.Response.Header().Set("Cache-Control", "no-store")
				}
				c.Response.WriteHeader(status)
				_, werr := c.Response.Write([]byte(doc))
				return werr
			})
		}

		return e.Next()
	})

	registerHostingRoutes(app)

	registerShoutbox(app)

	// Chat emoji pack (chat_emoji): separate from the shoutbox and not feature-flagged — the reactions
	// handler validates names against it, so it must be loaded even with chat off.
	registerChatEmoji(app)

	registerBuildImages(app)

	// Register before other moderator handlers — they call hasPerm().
	registerModPerms(app)

	registerPublicationQueue(app)
	registerPublicationQueueAPI(app)

	// Trim whitespace around game/author/tag names on DB write. Before registerGameEdits: the slug is
	// minted from the trimmed title (trim_names.go).
	registerNameTrim(app)

	registerGameEdits(app)

	registerGameVariants(app)

	// CF purge after card edits, otherwise a removed tag lingers until TTL (game_cache_purge.go).
	registerGameCachePurge(app)

	// First-party view counter (always written, shown only to moderators on /moderator/stats;
	// game_views self-creates).
	registerViewCounter(app)

	// Bump roulette: community votes, a daily cron bumps one (bump_votes/bump_draws/bump_settings
	// self-create).
	registerBumpRoulette(app)

	registerCatalogSnapshotRefresh(app)

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
