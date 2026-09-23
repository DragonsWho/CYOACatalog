// Cloudflare cache purge after card edits. The SPA shell is `public, max-age=3600` (main.go) and
// game records are fetched WITHOUT Authorization on purpose (`gamesCollectionPublic` in
// pocketbase.ts) so CF caches them. Cost: a moderator removes a tag and the page shows it for
// minutes ("edit didn't save").
// On every meaningful edit (tags, description, cover, pages, iframe_url, title, authors, hidden)
// purge: games record + catalog lists (`/api/collections/games/records…` by PREFIX — slug lookups
// are list queries); game page HTML (`/game/<slug>`, `/game/<id>`); home and search HTML (embedded
// window.__CATALOG__ snapshot).
// Same token/zone as `make cf-purge`, via purgeCFURLs (main.go). Runs in a goroutine and NEVER
// fails the user's request (worst case: expires by TTL). Bursts are coalesced into one call (CF
// rate-limits purges).
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// Likes, views, counters and bumped_at are excluded: they change constantly (same choice as
// cfPurger in main.go).
var gameCacheFields = []string{
	"title", "aliases", "slug", "description", "tags", "authors",
	"image", "image_base64", "cyoa_pages", "iframe_url", "original_link",
	"img_or_link", "release_date", "hidden",
}

type gameCachePurger struct {
	mu      sync.Mutex
	pending map[string]string
	timer   bool
}

var gamePurge = &gameCachePurger{pending: map[string]string{}}

// Coalesce window: short enough that the moderator sees the result before reloading.
const purgeGameWindow = 3 * time.Second

func (p *gameCachePurger) trigger(app core.App, id, slug string) {
	// Dev (vite proxy, no embedded dist) has no CF cache — same signal cfPurger uses.
	if !catalogInliningActive {
		return
	}
	p.mu.Lock()
	p.pending[id] = slug
	if p.timer {
		p.mu.Unlock()
		return
	}
	p.timer = true
	p.mu.Unlock()

	go func() {
		time.Sleep(purgeGameWindow)
		p.mu.Lock()
		batch := p.pending
		p.pending = map[string]string{}
		p.timer = false
		p.mu.Unlock()
		if len(batch) == 0 {
			return
		}
		p.flush(app, batch)
	}()
}

func (p *gameCachePurger) flush(app core.App, batch map[string]string) {
	// Rebuild the embedded catalog snapshot BEFORE purging, or the edge refetches the same stale HTML
	// from origin.
	catalogSnap.refresh(app)

	prefixes := []string{
		"cyoa.cafe/api/collections/games/records",
		"www.cyoa.cafe/api/collections/games/records",
	}
	for id, slug := range batch {
		prefixes = append(prefixes, "cyoa.cafe/game/"+id)
		if slug != "" && slug != id {
			prefixes = append(prefixes, "cyoa.cafe/game/"+slug)
		}
	}

	// Two independent purges so one CF refusal doesn't cancel the other. Prefix purge isn't on every
	// plan → fall back to exact URLs (can't reach slug list queries, but covers the record and page
	// HTML).
	if err := purgeCFPrefixes(prefixes); err != nil {
		app.Logger().Warn("game cache purge (prefixes) failed, falling back to exact URLs",
			"error", err.Error(), "games", len(batch))
		var urls []string
		for id, slug := range batch {
			urls = append(urls,
				"https://cyoa.cafe/api/collections/games/records/"+id,
				"https://cyoa.cafe/game/"+id)
			if slug != "" && slug != id {
				urls = append(urls, "https://cyoa.cafe/game/"+slug)
			}
		}
		if err := purgeCFURLs(urls); err != nil {
			app.Logger().Warn("game cache purge (exact urls) failed", "error", err.Error())
		}
	}
	if err := purgeCatalogHTMLCache(); err != nil {
		app.Logger().Warn("game cache purge (catalog html) failed", "error", err.Error())
		return
	}
	app.Logger().Info("game cache purged after edit", "games", len(batch))
}

func purgeCFPrefixes(prefixes []string) error {
	zone := os.Getenv("CLOUDFLARE_ZONE_ID")
	token := os.Getenv("CLOUDFLARE_API_TOKEN")
	if zone == "" || token == "" {
		return fmt.Errorf("CLOUDFLARE_ZONE_ID/CLOUDFLARE_API_TOKEN not set")
	}
	// CF accepts max 30 prefixes per call.
	const maxPerCall = 30
	if len(prefixes) > maxPerCall {
		for start := 0; start < len(prefixes); start += maxPerCall {
			end := start + maxPerCall
			if end > len(prefixes) {
				end = len(prefixes)
			}
			if err := purgeCFPrefixes(prefixes[start:end]); err != nil {
				return err
			}
		}
		return nil
	}
	payload, err := json.Marshal(map[string]any{"prefixes": prefixes})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost,
		"https://api.cloudflare.com/client/v4/zones/"+zone+"/purge_cache",
		strings.NewReader(string(payload)))
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

// One hook on any successful `games` update instead of per-endpoint calls: edits come from /edit,
// tag votes (mod override saves under app rights), hiding, PB scripts and the admin UI.
func registerGameCachePurge(app *pocketbase.PocketBase) {
	app.OnRecordAfterUpdateSuccess("games").BindFunc(func(e *core.RecordEvent) error {
		old := e.Record.Original()
		changed := old == nil
		if old != nil {
			for _, f := range gameCacheFields {
				if fmt.Sprint(e.Record.Get(f)) != fmt.Sprint(old.Get(f)) {
					changed = true
					break
				}
			}
		}
		if changed {
			gamePurge.trigger(e.App, e.Record.Id, e.Record.GetString("slug"))
		}
		return e.Next()
	})
}
