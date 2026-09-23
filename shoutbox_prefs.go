// Per-ROOM notification overrides. Push subscription is per device ("wake me for everything" /
// "mentions only"); a room overrides it, in its own direction only:
// ""         no override (no DB row at all) — follow the device
// "all"      wake on any message, even if device is mentions-only
// "mentions" mentions/replies only, even if device wants all
// "mute"     never wake, INCLUDING mentions (muted-but-pinged-by-name is the annoying case)
// Setting is per PERSON, not per device. Cost (author's main requirement): sending a message needs
// the prefs of everyone who set something in THIS room — one `channel`-indexed query cached
// shoutPrefsTTL; the common "nobody set anything" case caches an empty map, cost zero. Collection
// is closed to the outside (Go superuser only), like blocks and push subs.
package main

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

const (
	shoutPrefsCol = "shoutbox_channel_prefs"

	// 5 min: prefs change rarely, but longer and people think the button is broken. Own change is
	// visible at once — the handler drops this room's cache.
	shoutPrefsTTL = 5 * time.Minute

	// Cap is not for memory: rooms are dozens, but DM rows are unbounded and mustn't turn the cache
	// into a dump.
	shoutPrefsCacheMax = 128

	shoutPrefsMax = 200

	// Max room-overrides-device people served per message; each costs a subscription query.
	shoutPrefsBoostMax = 30
)

func shoutPrefValid(m string) bool {
	switch m {
	case "", "all", "mentions", "mute", "mute1h", "mute24h":
		return true
	}
	return false
}

// Timed mute stored as `mute:<unix>` inside `mode` (text max 16; `mute:1785000000` is 15). A
// separate field would be cleaner but not worth a prod schema change; plain `mute` = untimed,
// backward compatible. The SERVER computes the expiry — client clocks can't be trusted.
func shoutPrefStore(m string) string {
	switch m {
	case "mute1h":
		return "mute:" + strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	case "mute24h":
		return "mute:" + strconv.FormatInt(time.Now().Add(24*time.Hour).Unix(), 10)
	}
	return m
}

// Expired mute reads as "" (follow device); the row isn't cleaned up — the next pref edit rewrites
// it.
func shoutMode(raw string) string {
	rest, ok := strings.CutPrefix(raw, "mute:")
	if !ok {
		return raw
	}
	until, err := strconv.ParseInt(rest, 10, 64)
	if err != nil || time.Now().Unix() >= until {
		return ""
	}
	return "mute"
}

type shoutPrefEntry struct {
	at    time.Time
	modes map[string]string
}

type shoutPrefCache struct {
	mu   sync.Mutex
	byCh map[string]shoutPrefEntry
}

var shoutPrefs = &shoutPrefCache{byCh: map[string]shoutPrefEntry{}}

// Empty map is a valid, cached answer. A query error (collection missing, schema not applied) is
// also cached as empty, so chat behaves exactly as before this feature instead of hammering a
// failing query per message.
func (c *shoutPrefCache) forChannel(app core.App, chID string) map[string]string {
	if chID == "" {
		return nil
	}
	c.mu.Lock()
	e, ok := c.byCh[chID]
	c.mu.Unlock()
	if ok && time.Since(e.at) < shoutPrefsTTL {
		return e.modes
	}

	modes := map[string]string{}
	recs, err := app.FindRecordsByFilter(shoutPrefsCol, "channel = {:c}", "", 0, 0,
		dbx.Params{"c": chID})
	if err == nil {
		for _, r := range recs {
			uid, m := r.GetString("user"), r.GetString("mode")
			if uid != "" && m != "" {
				modes[uid] = m
			}
		}
	}

	c.mu.Lock()
	if len(c.byCh) >= shoutPrefsCacheMax {
		for k, v := range c.byCh {
			if time.Since(v.at) > shoutPrefsTTL {
				delete(c.byCh, k)
			}
		}
	}
	c.byCh[chID] = shoutPrefEntry{at: time.Now(), modes: modes}
	c.mu.Unlock()
	return modes
}

// Called right after a write so the user sees their setting on the next message, not in 5 minutes.
func (c *shoutPrefCache) drop(chID string) {
	c.mu.Lock()
	delete(c.byCh, chID)
	c.mu.Unlock()
}

// Loaded lazily (when the menu opens), never on chat load.
func shoutPrefsOfUser(app core.App, uid string) map[string]string {
	out := map[string]string{}
	if uid == "" {
		return out
	}
	recs, err := app.FindRecordsByFilter(shoutPrefsCol, "user = {:u}", "",
		shoutPrefsMax, 0, dbx.Params{"u": uid})
	if err != nil {
		return out
	}
	for _, r := range recs {
		// Expose the effective mode, not the storage format (`mute:<unix>` stays server-side).
		ch, m := r.GetString("channel"), shoutMode(r.GetString("mode"))
		if ch != "" && m != "" {
			out[ch] = m
		}
	}
	return out
}

func registerShoutboxPrefs(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	g.GET("/notify-prefs", func(c *core.RequestEvent) error {
		return c.JSON(http.StatusOK, map[string]any{
			"prefs": shoutPrefsOfUser(app, c.Auth.Id),
		})
	}).Bind(apis.RequireAuth())

	// Empty mode = remove the row (a "same as everywhere" row would still affect the query).
	g.POST("/notify-prefs", func(c *core.RequestEvent) error {
		var p struct {
			Channel string `json:"channel"`
			Mode    string `json:"mode"`
		}
		if err := c.BindBody(&p); err != nil {
			return c.BadRequestError("Invalid body", err)
		}
		ch := strings.TrimSpace(p.Channel)
		mode := strings.TrimSpace(p.Mode)
		if ch == "" {
			return c.BadRequestError("Missing channel", nil)
		}
		if !shoutPrefValid(mode) {
			return c.BadRequestError("Unknown mode", nil)
		}
		// Room the caller can't enter → 404 either way (like shoutResolveChannel): existence of a private
		// room is private too. `enabled` not checked: removing a pref from a disabled room must work.
		chRec, err := app.FindRecordById(shoutChannelsCol, ch)
		if err != nil {
			return c.NotFoundError("Unknown channel", err)
		}
		if chRec.GetBool("is_private") && !shoutIsMember(chRec, c.Auth.Id) {
			return c.NotFoundError("Unknown channel", nil)
		}

		rec, err := app.FindFirstRecordByFilter(shoutPrefsCol,
			"user = {:u} && channel = {:c}",
			dbx.Params{"u": c.Auth.Id, "c": ch})

		switch {
		case mode == "":
			if err == nil {
				if e := app.Delete(rec); e != nil {
					return c.InternalServerError("Failed to clear the setting", e)
				}
			}
		case err == nil:
			rec.Set("mode", shoutPrefStore(mode))
			if e := app.Save(rec); e != nil {
				return c.InternalServerError("Failed to save the setting", e)
			}
		default:
			if len(shoutPrefsOfUser(app, c.Auth.Id)) >= shoutPrefsMax {
				return c.BadRequestError("Too many per-room settings.", nil)
			}
			coll, e := app.FindCollectionByNameOrId(shoutPrefsCol)
			if e != nil {
				return c.InternalServerError("Notification settings storage missing", e)
			}
			fresh := core.NewRecord(coll)
			fresh.Set("user", c.Auth.Id)
			fresh.Set("channel", ch)
			fresh.Set("mode", shoutPrefStore(mode))
			if e := app.Save(fresh); e != nil {
				return c.InternalServerError("Failed to save the setting", e)
			}
		}

		shoutPrefs.drop(ch)
		// Reply with the effective mode: client sent "mute24h", should remember "mute"; the expiry lives
		// on the server.
		return c.JSON(http.StatusOK, map[string]any{"ok": true, "mode": shoutMode(shoutPrefStore(mode))})
	}).Bind(apis.RequireAuth())
}
