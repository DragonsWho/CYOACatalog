package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/core"
)

// Tag dictionary: the whole tag taxonomy in one response. The frontend used to page through the
// tags table 2-3 times (different field sets per module), plus tag_categories, plus every game's
// tags to learn which tags are in use — ~13 sequential requests on a cold visit, and the home feed
// waited for them. Now: one in-memory JSON, versioned by content hash. The version and the two
// rating tag ids are inlined into every HTML shell (tagDictScript), so the feed can filter
// NSFW/Extreme immediately and a browser holding the current version makes no request at all.
// `?v=<version>` responses are immutable; a stale HTML shell (edge TTL 1h) only means one extra
// fetch of the newer version.

type tagDictTag struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Aliases string `json:"aliases,omitempty"`
}

type tagDictCategory struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Tags []string `json:"tags"`
}

type tagDictPayload struct {
	Version    string            `json:"v"`
	Tags       []tagDictTag      `json:"tags"`
	Categories []tagDictCategory `json:"categories"`
	// Ids of tags carried by at least one visible game (search suggestions hide empty tags).
	Used    []string `json:"used"`
	NSFW    string   `json:"nsfw"`
	Extreme string   `json:"extreme"`
}

type tagDictionary struct {
	mu      sync.RWMutex
	body    []byte
	version string
	script  string
}

var tagDict = &tagDictionary{}

func (d *tagDictionary) get() ([]byte, string, string) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.body, d.version, d.script
}

// On error keep the previous value (the frontend falls back to fetching without a version).
func (d *tagDictionary) refresh(app core.App) {
	body, version, script, err := buildTagDictionary(app)
	if err != nil {
		log.Printf("Warn: tag dictionary refresh failed: %v", err)
		return
	}
	d.mu.Lock()
	d.body, d.version, d.script = body, version, script
	d.mu.Unlock()
}

func buildTagDictionary(app core.App) ([]byte, string, string, error) {
	p := tagDictPayload{Tags: []tagDictTag{}, Categories: []tagDictCategory{}, Used: []string{}}

	tagRecs, err := app.FindRecordsByFilter("tags", "id != ''", "name", 0, 0)
	if err != nil {
		return nil, "", "", fmt.Errorf("load tags: %w", err)
	}
	for _, t := range tagRecs {
		name := t.GetString("name")
		p.Tags = append(p.Tags, tagDictTag{ID: t.Id, Name: name, Aliases: t.GetString("aliases")})
		switch strings.ToLower(name) {
		case "nsfw":
			p.NSFW = t.Id
		case "extreme":
			p.Extreme = t.Id
		}
	}

	catRecs, err := app.FindRecordsByFilter("tag_categories", "id != ''", "name", 0, 0)
	if err != nil {
		return nil, "", "", fmt.Errorf("load tag_categories: %w", err)
	}
	for _, c := range catRecs {
		ids := c.GetStringSlice("tags")
		if ids == nil {
			ids = []string{}
		}
		p.Categories = append(p.Categories, tagDictCategory{ID: c.Id, Name: c.GetString("name"), Tags: ids})
	}

	// Direct DB read bypasses the listRule: exclude soft-hidden games like the public list does.
	var used []struct {
		ID string `db:"id"`
	}
	err = app.DB().NewQuery(
		"SELECT DISTINCT je.value AS id FROM games, json_each(games.tags) je " +
			"WHERE COALESCE(games.hidden, FALSE) = FALSE AND je.value != '' ORDER BY id",
	).All(&used)
	if err != nil {
		return nil, "", "", fmt.Errorf("used tags: %w", err)
	}
	for _, u := range used {
		p.Used = append(p.Used, u.ID)
	}

	// Version = hash of the content without the version field itself.
	raw, err := json.Marshal(p)
	if err != nil {
		return nil, "", "", err
	}
	sum := sha256.Sum256(raw)
	p.Version = hex.EncodeToString(sum[:])[:12]
	body, err := json.Marshal(p)
	if err != nil {
		return nil, "", "", err
	}
	meta, _ := json.Marshal(map[string]string{"v": p.Version, "nsfw": p.NSFW, "extreme": p.Extreme})
	return body, p.Version, "<script>window.__TAGDICT__=" + string(meta) + "</script>", nil
}

func registerTagDictionary(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		tagDict.refresh(e.App)
		e.Router.GET("/api/custom/tag-dictionary", func(c *core.RequestEvent) error {
			body, version, _ := tagDict.get()
			if body == nil {
				tagDict.refresh(c.App)
				body, version, _ = tagDict.get()
				if body == nil {
					return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "tag dictionary unavailable"})
				}
			}
			if v := c.Request.URL.Query().Get("v"); v != "" && v == version {
				c.Response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				c.Response.Header().Set("Cache-Control", "public, max-age=60")
			}
			c.Response.Header().Set("Content-Type", "application/json")
			c.Response.WriteHeader(http.StatusOK)
			_, err := c.Response.Write(body)
			return err
		})
		return e.Next()
	})

	// Tag/category edits are rare and the rebuild is cheap: rebuild right away. Game tag changes
	// (the `used` set) ride the 5-minute catalog timer.
	rebuild := func(e *core.RecordEvent) error {
		tagDict.refresh(e.App)
		return e.Next()
	}
	for _, coll := range []string{"tags", "tag_categories"} {
		app.OnRecordAfterCreateSuccess(coll).BindFunc(rebuild)
		app.OnRecordAfterUpdateSuccess(coll).BindFunc(rebuild)
		app.OnRecordAfterDeleteSuccess(coll).BindFunc(rebuild)
	}
}
