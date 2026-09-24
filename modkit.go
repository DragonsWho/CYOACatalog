// Mod Tools: moderators download games on their own computer with the helper app
// (tools/cyoa-helper) and drive it from /moderator/mod-tools. The helper never listens for the
// site: it pairs once (device code), then long-polls /api/modkit/helper/next for jobs and reports
// back, so no browser has to reach localhost. Moderators then upload the build under the AUTHOR's
// reserved hosting account (author.cyoa.cafe/game/, never the moderator's) and submit a card
// (title/authors/tags/description/cover) into the publication queue, where it waits, flagged, until
// another moderator checks it (publication_queue*.go).
// Collections helper_devices/helper_jobs: pb_scripts/2026-09-24_helper_collections.py; without
// them every endpoint here answers 503. Permission: mod_upload (mod_perms.go).
package main

import (
	"crypto/rand"
	"encoding/json"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

const (
	helperDevicesColl = "helper_devices"
	helperJobsColl    = "helper_jobs"

	helperTokenHeader  = "X-Helper-Token"
	pairTTL            = 10 * time.Minute
	pairMaxPerIP       = 5
	pairMaxTotal       = 500
	helperOnlineWindow = 75 * time.Second
	helperLongPoll     = 25 * time.Second
	helperMaxQueued    = 10
	helperLogMax       = 200_000
	helperSlotLockTTL  = 2 * time.Hour
	modCardImageMax    = 5 << 20
)

var (
	helperItemRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,79}$`)
	jobKinds     = map[string]bool{"download": true, "import": true, "check": true, "upload": true}
)

// ---- pairing (device code flow, in memory: a restart only drops codes that were never confirmed) ----

type helperPairing struct {
	Code, Secret, IP          string
	Name, Platform, Version   string
	Expires                   time.Time
	DeviceID, Token, Username string
}

var (
	pairMu       sync.Mutex
	pairByCode   = map[string]*helperPairing{}
	pairBySecret = map[string]*helperPairing{}
)

func prunePairingsLocked(now time.Time) {
	for code, p := range pairByCode {
		if now.After(p.Expires) {
			delete(pairByCode, code)
			delete(pairBySecret, p.Secret)
		}
	}
}

// Unambiguous alphabet: the code is read off a terminal and typed by hand.
const pairAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

func randomFrom(alphabet string, n int) string {
	var b strings.Builder
	max := big.NewInt(int64(len(alphabet)))
	for i := 0; i < n; i++ {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		b.WriteByte(alphabet[v.Int64()])
	}
	return b.String()
}

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func normalizePairCode(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.NewReplacer("-", "", " ", "").Replace(s)
	if len(s) == 8 {
		return s[:4] + "-" + s[4:]
	}
	return s
}

// ---- slot locks: two uploads must not write into the same new version prefix ----

type slotLock struct {
	job     string
	expires time.Time
}

var (
	slotMu    sync.Mutex
	slotLocks = map[string]slotLock{}
)

func lockSlot(key, jobID string) bool {
	slotMu.Lock()
	defer slotMu.Unlock()
	now := time.Now()
	if l, ok := slotLocks[key]; ok && l.job != jobID && now.Before(l.expires) {
		return false
	}
	slotLocks[key] = slotLock{job: jobID, expires: now.Add(helperSlotLockTTL)}
	return true
}

func unlockSlot(key string) {
	slotMu.Lock()
	delete(slotLocks, key)
	slotMu.Unlock()
}

// ---- job wake-up: long-polling helpers sleep on a per-device channel ----

var (
	wakeMu sync.Mutex
	wakeCh = map[string]chan struct{}{}
)

func deviceWake(deviceID string) chan struct{} {
	wakeMu.Lock()
	defer wakeMu.Unlock()
	ch, ok := wakeCh[deviceID]
	if !ok {
		ch = make(chan struct{}, 1)
		wakeCh[deviceID] = ch
	}
	return ch
}

func wakeDevice(deviceID string) {
	select {
	case deviceWake(deviceID) <- struct{}{}:
	default:
	}
}

// claimMu serializes queued→running so two polls of the same device can't take one job twice.
var claimMu sync.Mutex

// ---- helpers ----

func modkitReady(app core.App) bool {
	if _, err := app.FindCollectionByNameOrId(helperDevicesColl); err != nil {
		return false
	}
	_, err := app.FindCollectionByNameOrId(helperJobsColl)
	return err == nil
}

func jsonErr(c *core.RequestEvent, status int, msg string) error {
	return c.JSON(status, map[string]any{"error": msg, "message": msg})
}

// Moderator (browser) endpoints.
func modkitMod(app core.App, fn func(*core.RequestEvent) error) func(*core.RequestEvent) error {
	return requirePerm(permModUpload, func(c *core.RequestEvent) error {
		if c.Auth == nil || c.Auth.Collection().Name != "users" {
			return jsonErr(c, http.StatusForbidden, "sign in with your moderator account")
		}
		if !modkitReady(app) {
			return jsonErr(c, http.StatusServiceUnavailable,
				"Mod Tools are not set up yet: run pb_scripts/2026-09-24_helper_collections.py")
		}
		return fn(c)
	})
}

// Helper endpoints: device token → device + owner. The owner must still be a moderator with
// mod_upload, so revoking the permission (or isModerator) disables all their helpers at once.
func modkitHelper(app core.App, fn func(*core.RequestEvent, *core.Record) error) func(*core.RequestEvent) error {
	return func(c *core.RequestEvent) error {
		if !modkitReady(app) {
			return jsonErr(c, http.StatusServiceUnavailable, "Mod Tools are not set up on the server yet")
		}
		token := strings.TrimSpace(c.Request.Header.Get(helperTokenHeader))
		if len(token) < 32 {
			return jsonErr(c, http.StatusUnauthorized, "helper is not paired")
		}
		dev, err := app.FindFirstRecordByFilter(helperDevicesColl, "token_hash = {:h}",
			dbx.Params{"h": sha256Hex(token)})
		if err != nil || dev == nil || dev.GetBool("revoked") {
			return jsonErr(c, http.StatusUnauthorized, "this helper was disconnected — pair it again")
		}
		user, err := app.FindRecordById("users", dev.GetString("user"))
		if err != nil || !authHasPerm(user, permModUpload) {
			return jsonErr(c, http.StatusForbidden, "your account has no \"mod_upload\" permission")
		}
		// logModAction and requestIP-based helpers read c.Auth.
		c.Auth = user
		if time.Since(dev.GetDateTime("last_seen").Time()) > 20*time.Second {
			dev.Set("last_seen", time.Now().UTC())
			if v := strings.TrimSpace(c.Request.Header.Get("X-Helper-Version")); v != "" {
				dev.Set("client_version", trimModField(v, 40))
			}
			if err := app.Save(dev); err != nil {
				app.Logger().Warn("modkit: last_seen save failed", "device", dev.Id, "error", err.Error())
			}
		}
		return fn(c, dev)
	}
}

func deviceJSON(dev *core.Record) map[string]any {
	last := dev.GetDateTime("last_seen").Time()
	return map[string]any{
		"id":             dev.Id,
		"name":           dev.GetString("name"),
		"platform":       dev.GetString("platform"),
		"client_version": dev.GetString("client_version"),
		"last_seen":      dev.GetDateTime("last_seen").String(),
		"online":         !last.IsZero() && time.Since(last) < helperOnlineWindow,
		"created":        dev.GetDateTime("created").String(),
	}
}

func recordJSONMap(rec *core.Record, field string) map[string]any {
	out := map[string]any{}
	if rec == nil {
		return out
	}
	if err := rec.UnmarshalJSONField(field, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func jobJSON(job *core.Record, withLog bool) map[string]any {
	out := map[string]any{
		"id":       job.Id,
		"device":   job.GetString("device"),
		"kind":     job.GetString("kind"),
		"status":   job.GetString("status"),
		"input":    recordJSONMap(job, "input"),
		"progress": recordJSONMap(job, "progress"),
		"result":   recordJSONMap(job, "result"),
		"error":    job.GetString("error"),
		"created":  job.GetDateTime("created").String(),
		"updated":  job.GetDateTime("updated").String(),
	}
	if withLog {
		out["log"] = job.GetString("log")
	}
	return out
}

func strField(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// Canonical source URL, same algorithm as the pipeline (pb_hooks /api/pipeline/submit and
// state_pb._canonical_url): drop the wayback prefix, query/fragment, dir index, trailing slash;
// lowercase scheme+host only (neocities paths are case-sensitive).
var (
	waybackPrefixRe = regexp.MustCompile(`(?i)^https?://web\.archive\.org/web/[^/]+/`)
	dirIndexRe      = regexp.MustCompile(`(?i)/index\.(html?|php|aspx?)$`)
	schemeHostRe    = regexp.MustCompile(`(?i)^https?://[^/]+`)
	waybackWrapRe   = regexp.MustCompile(`(?i)^https?://web\.archive\.org/web/\d+(?:[a-z]{2,3}_)?/(https?://.*)$`)
	anySchemeRe     = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.\-]*://`)
	digitsDotsRe    = regexp.MustCompile(`^[0-9.]+$`)
	httpWWWPrefixRe = regexp.MustCompile(`(?i)^https?://(www\.)?`)
	likeEscaper     = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
)

func canonicalSourceURL(u string) string {
	s := strings.TrimSpace(u)
	s = waybackPrefixRe.ReplaceAllString(s, "")
	if i := strings.IndexAny(s, "#?"); i >= 0 {
		s = s[:i]
	}
	s = dirIndexRe.ReplaceAllString(s, "")
	s = strings.TrimRight(s, "/")
	return schemeHostRe.ReplaceAllStringFunc(s, strings.ToLower)
}

// Comparison key for catalog links: host without www + decoded path, lowercased.
func urlDedupKey(u string) string {
	s := strings.TrimSpace(u)
	for i := 0; i < 10; i++ {
		m := waybackWrapRe.FindStringSubmatch(s)
		if m == nil {
			break
		}
		s = m[1]
	}
	s = anySchemeRe.ReplaceAllString(s, "")
	if i := strings.IndexAny(s, "#?"); i >= 0 {
		s = s[:i]
	}
	host, path := s, ""
	if i := strings.Index(s, "/"); i >= 0 {
		host, path = s[:i], s[i:]
	}
	host = strings.ToLower(strings.SplitN(host, ":", 2)[0])
	host = strings.TrimPrefix(host, "www.")
	if p, err := url.PathUnescape(path); err == nil {
		path = p
	}
	path = dirIndexRe.ReplaceAllString(path, "/")
	path = strings.TrimRight(path, "/")
	if host == "" {
		return ""
	}
	return strings.ToLower(host + path)
}

func publicHTTPURL(raw string) (*url.URL, error) {
	if len(raw) > 2000 {
		return nil, errors.New("the link is too long")
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("paste a full http(s) link")
	}
	host := strings.ToLower(u.Hostname())
	if !strings.Contains(host, ".") || host == "localhost" || strings.HasSuffix(host, ".local") ||
		digitsDotsRe.MatchString(host) || strings.Contains(host, ":") {
		return nil, errors.New("that link doesn't look like a public website")
	}
	return u, nil
}

type dupHit struct {
	Where string `json:"where"` // "catalog" | "pipeline"
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state,omitempty"`
	Link  string `json:"link,omitempty"`
	Why   string `json:"why"`
}

// Candidates for "this game is already here": same source link in the catalog or the pipeline,
// same title/alias in the catalog. Advisory; the moderator decides (translations and ports are
// legitimately separate).
func findDuplicates(app core.App, sourceURL, title string) []dupHit {
	hits := []dupHit{}
	seen := map[string]bool{}
	add := func(h dupHit) {
		k := h.Where + ":" + h.ID
		if !seen[k] {
			seen[k] = true
			hits = append(hits, h)
		}
	}

	if sourceURL != "" {
		canon := canonicalSourceURL(sourceURL)
		want := urlDedupKey(canon)
		rows, _ := app.FindAllRecords("game_pipeline_state", dbx.NewExp(
			"LOWER(original_url) = {:c} OR LOWER(RTRIM(source_url, '/')) = {:c}",
			dbx.Params{"c": strings.ToLower(canon)}))
		for _, r := range rows {
			add(dupHit{Where: "pipeline", ID: r.Id, Title: r.GetString("title"), State: r.GetString("state"),
				Link: r.GetString("source_url"), Why: "same link"})
		}
		needle := likeEscaper.Replace(strings.ToLower(httpWWWPrefixRe.ReplaceAllString(canon, "")))
		if needle != "" {
			games, _ := app.FindAllRecords("games", dbx.NewExp(
				`LOWER(original_link) LIKE {:p} ESCAPE '\' OR LOWER(iframe_url) LIKE {:p} ESCAPE '\'`,
				dbx.Params{"p": "%" + needle + "%"}))
			for _, g := range games {
				if want != "" && (urlDedupKey(g.GetString("original_link")) == want ||
					urlDedupKey(g.GetString("iframe_url")) == want) {
					add(dupHit{Where: "catalog", ID: g.Id, Title: g.GetString("title"),
						Link: g.GetString("original_link"), Why: "same link"})
				}
			}
		}
	}

	if t := strings.TrimSpace(title); len(t) >= 3 {
		games, _ := app.FindAllRecords("games", dbx.NewExp(
			"title = {:t} COLLATE NOCASE", dbx.Params{"t": t}))
		for _, g := range games {
			add(dupHit{Where: "catalog", ID: g.Id, Title: g.GetString("title"),
				Link: g.GetString("original_link"), Why: "same title"})
		}
		if col, err := app.FindCollectionByNameOrId("games"); err == nil && col.Fields.GetByName("aliases") != nil {
			esc := likeEscaper.Replace(strings.ToLower(t))
			games, _ = app.FindAllRecords("games", dbx.NewExp(
				`LOWER(aliases) LIKE {:p} ESCAPE '\'`, dbx.Params{"p": "%" + esc + "%"}))
			for _, g := range games {
				for _, a := range strings.Split(g.GetString("aliases"), "\n") {
					if strings.EqualFold(strings.TrimSpace(a), t) {
						add(dupHit{Where: "catalog", ID: g.Id, Title: g.GetString("title"),
							Link: g.GetString("original_link"), Why: "same alias"})
					}
				}
			}
		}
	}
	return hits
}

// Suggested hosting slug for an author name; same shape as the pipeline's reserved accounts.
func suggestHostingSlug(name string) string {
	s := deriveHostingSlug(name)
	if len(s) > 40 {
		s = strings.Trim(s[:40], "-")
	}
	if reservedSubdomains[s] {
		s += "-games"
	}
	return s
}

func usernameOrSlugTaken(app core.App, slug string) *core.Record {
	var id string
	err := app.ConcurrentDB().Select("id").From("users").
		AndWhere(dbx.NewExp("hosting_slug = {:s} OR username = {:s} COLLATE NOCASE", dbx.Params{"s": slug})).
		Limit(1).Row(&id)
	if err != nil || id == "" {
		return nil
	}
	rec, _ := app.FindRecordById("users", id)
	return rec
}

func hostingAccountJSON(app core.App, u *core.Record) map[string]any {
	n, _ := app.CountRecords("hosted_games", dbx.HashExp{"owner": u.Id})
	return map[string]any{
		"id":           u.Id,
		"username":     u.GetString("username"),
		"name":         u.GetString("name"),
		"hosting_slug": u.GetString("hosting_slug"),
		"reserved":     u.GetBool("is_reserved"),
		"games":        n,
		"home":         makeHomeURL(u.GetString("hosting_slug")),
	}
}

// ---- routes ----

func registerModkit(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		g := se.Router.Group("/api/modkit")

		// --- pairing ---

		g.POST("/pair/start", func(c *core.RequestEvent) error {
			var body struct{ Name, Platform, Version string }
			_ = c.BindBody(&body)
			ip := requestIP(c.Request)
			now := time.Now()

			pairMu.Lock()
			defer pairMu.Unlock()
			prunePairingsLocked(now)
			perIP := 0
			for _, p := range pairByCode {
				if p.IP == ip {
					perIP++
				}
			}
			if perIP >= pairMaxPerIP || len(pairByCode) >= pairMaxTotal {
				return jsonErr(c, http.StatusTooManyRequests, "too many pairing attempts, try again in a few minutes")
			}
			code := ""
			for i := 0; i < 5 && (code == "" || pairByCode[code] != nil); i++ {
				raw := randomFrom(pairAlphabet, 8)
				code = raw[:4] + "-" + raw[4:]
			}
			p := &helperPairing{
				Code: code, Secret: randomHex(32), IP: ip,
				Name:     trimModField(strings.TrimSpace(body.Name), 100),
				Platform: trimModField(strings.TrimSpace(body.Platform), 40),
				Version:  trimModField(strings.TrimSpace(body.Version), 40),
				Expires:  now.Add(pairTTL),
			}
			pairByCode[code] = p
			pairBySecret[p.Secret] = p
			return c.JSON(http.StatusOK, map[string]any{
				"code":       code,
				"secret":     p.Secret,
				"expires_in": int(pairTTL.Seconds()),
				"pair_url":   "/moderator/mod-tools?pair=" + code,
			})
		})

		g.POST("/pair/poll", func(c *core.RequestEvent) error {
			var body struct{ Secret string }
			_ = c.BindBody(&body)
			pairMu.Lock()
			defer pairMu.Unlock()
			prunePairingsLocked(time.Now())
			p := pairBySecret[strings.TrimSpace(body.Secret)]
			if p == nil {
				return jsonErr(c, http.StatusNotFound, "the pairing code expired — start again")
			}
			if p.Token == "" {
				return c.JSON(http.StatusOK, map[string]any{"status": "pending"})
			}
			// The token leaves the server exactly once.
			delete(pairByCode, p.Code)
			delete(pairBySecret, p.Secret)
			return c.JSON(http.StatusOK, map[string]any{
				"status": "paired", "token": p.Token, "device_id": p.DeviceID, "user": p.Username,
			})
		})

		g.POST("/pair/confirm", modkitMod(app, func(c *core.RequestEvent) error {
			var body struct{ Code string }
			_ = c.BindBody(&body)
			code := normalizePairCode(body.Code)

			pairMu.Lock()
			prunePairingsLocked(time.Now())
			p := pairByCode[code]
			if p == nil || p.Token != "" {
				pairMu.Unlock()
				return jsonErr(c, http.StatusNotFound, "no helper is waiting with this code (codes expire after 10 minutes)")
			}
			// Reserve it before the DB write so a double click can't create two devices.
			token := randomHex(32)
			p.Token = "pending"
			pairMu.Unlock()

			col, err := app.FindCollectionByNameOrId(helperDevicesColl)
			if err != nil {
				return jsonErr(c, http.StatusServiceUnavailable, "helper_devices collection is missing")
			}
			dev := core.NewRecord(col)
			dev.Set("user", c.Auth.Id)
			name := p.Name
			if name == "" {
				name = "Helper"
			}
			dev.Set("name", name)
			dev.Set("platform", p.Platform)
			dev.Set("client_version", p.Version)
			dev.Set("token_hash", sha256Hex(token))
			dev.Set("last_seen", time.Now().UTC())
			if err := app.Save(dev); err != nil {
				pairMu.Lock()
				p.Token = ""
				pairMu.Unlock()
				return jsonErr(c, http.StatusInternalServerError, "could not save the device: "+err.Error())
			}

			pairMu.Lock()
			p.Token, p.DeviceID, p.Username = token, dev.Id, c.Auth.GetString("username")
			pairMu.Unlock()

			logModAction(app, c, modAction{
				Action: "helper.pair", Target: helperDevicesColl + ":" + dev.Id,
				After:  map[string]any{"name": name, "platform": p.Platform, "ip": p.IP},
				Reversible: true, Note: "undo = disconnect the helper on the Mod Tools page",
			})
			return c.JSON(http.StatusOK, map[string]any{"device": deviceJSON(dev)})
		})).Bind(apis.RequireAuth())

		// --- devices ---

		g.GET("/devices", modkitMod(app, func(c *core.RequestEvent) error {
			devs, err := app.FindRecordsByFilter(helperDevicesColl, "user = {:u} && revoked = false",
				"-last_seen", 50, 0, dbx.Params{"u": c.Auth.Id})
			if err != nil {
				return jsonErr(c, http.StatusInternalServerError, "list failed")
			}
			out := make([]map[string]any, 0, len(devs))
			for _, d := range devs {
				out = append(out, deviceJSON(d))
			}
			return c.JSON(http.StatusOK, map[string]any{"devices": out})
		})).Bind(apis.RequireAuth())

		g.POST("/devices/{id}/revoke", modkitMod(app, func(c *core.RequestEvent) error {
			dev, err := app.FindRecordById(helperDevicesColl, c.Request.PathValue("id"))
			if err != nil || dev.GetString("user") != c.Auth.Id {
				return jsonErr(c, http.StatusNotFound, "device not found")
			}
			dev.Set("revoked", true)
			if err := app.Save(dev); err != nil {
				return jsonErr(c, http.StatusInternalServerError, "save failed")
			}
			jobs, _ := app.FindRecordsByFilter(helperJobsColl,
				"device = {:d} && (status = 'queued' || status = 'running')", "", 200, 0, dbx.Params{"d": dev.Id})
			for _, j := range jobs {
				j.Set("status", "cancelled")
				j.Set("error", "helper disconnected")
				_ = app.Save(j)
			}
			wakeDevice(dev.Id)
			logModAction(app, c, modAction{
				Action: "helper.revoke", Target: helperDevicesColl + ":" + dev.Id,
				Before: map[string]any{"name": dev.GetString("name")}, Reversible: false,
			})
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		})).Bind(apis.RequireAuth())

		// --- jobs (moderator side) ---

		g.POST("/jobs", modkitMod(app, func(c *core.RequestEvent) error {
			var body struct {
				Device string         `json:"device"`
				Kind   string         `json:"kind"`
				Input  map[string]any `json:"input"`
			}
			if err := c.BindBody(&body); err != nil {
				return jsonErr(c, http.StatusBadRequest, "invalid body")
			}
			dev, err := app.FindRecordById(helperDevicesColl, body.Device)
			if err != nil || dev.GetString("user") != c.Auth.Id || dev.GetBool("revoked") {
				return jsonErr(c, http.StatusNotFound, "pick one of your connected helpers")
			}
			if body.Input == nil {
				body.Input = map[string]any{}
			}
			input, verr := validateJobInput(app, body.Kind, body.Input)
			if verr != nil {
				return jsonErr(c, http.StatusBadRequest, verr.Error())
			}
			queued, _ := app.CountRecords(helperJobsColl, dbx.NewExp(
				"device = {:d} AND status = 'queued'", dbx.Params{"d": dev.Id}))
			if queued >= helperMaxQueued {
				return jsonErr(c, http.StatusTooManyRequests, "this helper already has too many queued jobs")
			}
			job, err := newHelperJob(app, c.Auth.Id, dev.Id, body.Kind, "queued", input)
			if err != nil {
				return jsonErr(c, http.StatusInternalServerError, "could not create the job: "+err.Error())
			}
			wakeDevice(dev.Id)
			return c.JSON(http.StatusOK, jobJSON(job, false))
		})).Bind(apis.RequireAuth())

		g.GET("/jobs", modkitMod(app, func(c *core.RequestEvent) error {
			limit, _ := strconv.Atoi(c.Request.URL.Query().Get("limit"))
			if limit <= 0 || limit > 100 {
				limit = 30
			}
			jobs, err := app.FindRecordsByFilter(helperJobsColl, "user = {:u}", "-created", limit, 0,
				dbx.Params{"u": c.Auth.Id})
			if err != nil {
				return jsonErr(c, http.StatusInternalServerError, "list failed")
			}
			out := make([]map[string]any, 0, len(jobs))
			for _, j := range jobs {
				out = append(out, jobJSON(j, false))
			}
			return c.JSON(http.StatusOK, map[string]any{"jobs": out})
		})).Bind(apis.RequireAuth())

		g.GET("/jobs/{id}", modkitMod(app, func(c *core.RequestEvent) error {
			job, err := app.FindRecordById(helperJobsColl, c.Request.PathValue("id"))
			if err != nil || job.GetString("user") != c.Auth.Id {
				return jsonErr(c, http.StatusNotFound, "job not found")
			}
			return c.JSON(http.StatusOK, jobJSON(job, true))
		})).Bind(apis.RequireAuth())

		g.POST("/jobs/{id}/cancel", modkitMod(app, func(c *core.RequestEvent) error {
			job, err := app.FindRecordById(helperJobsColl, c.Request.PathValue("id"))
			if err != nil || job.GetString("user") != c.Auth.Id {
				return jsonErr(c, http.StatusNotFound, "job not found")
			}
			if st := job.GetString("status"); st != "queued" && st != "running" {
				return jsonErr(c, http.StatusBadRequest, "the job has already finished")
			}
			job.Set("status", "cancelled")
			if err := app.Save(job); err != nil {
				return jsonErr(c, http.StatusInternalServerError, "save failed")
			}
			return c.JSON(http.StatusOK, jobJSON(job, false))
		})).Bind(apis.RequireAuth())

		// --- author hosting accounts ---

		g.GET("/hosting-accounts", modkitMod(app, func(c *core.RequestEvent) error {
			q := strings.TrimSpace(c.Request.URL.Query().Get("q"))
			if q == "" {
				return c.JSON(http.StatusOK, map[string]any{"accounts": []any{}})
			}
			slug := suggestHostingSlug(q)
			users, _ := app.FindAllRecords("users", dbx.NewExp(
				"hosting_slug = {:s} OR hosting_slug LIKE {:p} ESCAPE '\\' OR username = {:q} COLLATE NOCASE OR username = {:s} COLLATE NOCASE",
				dbx.Params{"s": slug, "q": q, "p": likeEscaper.Replace(slug) + "-%"}))
			accounts := []map[string]any{}
			for i, u := range users {
				if i >= 20 {
					break
				}
				accounts = append(accounts, hostingAccountJSON(app, u))
			}
			suggestion := map[string]any{"slug": slug, "available": true, "reason": ""}
			if !isValidSlug(slug) {
				suggestion["available"], suggestion["reason"] = false, "can't build a valid address from this name"
			} else if taken := usernameOrSlugTaken(app, slug); taken != nil {
				suggestion["available"], suggestion["reason"] = false, "taken by "+taken.GetString("username")
			}
			return c.JSON(http.StatusOK, map[string]any{"accounts": accounts, "suggestion": suggestion})
		})).Bind(apis.RequireAuth())

		g.POST("/hosting-accounts", modkitMod(app, func(c *core.RequestEvent) error {
			var body struct{ Name, Slug string }
			if err := c.BindBody(&body); err != nil {
				return jsonErr(c, http.StatusBadRequest, "invalid body")
			}
			name := strings.TrimSpace(body.Name)
			slug := strings.ToLower(strings.TrimSpace(body.Slug))
			if slug == "" {
				slug = suggestHostingSlug(name)
			}
			if name == "" || len(name) > 100 {
				return jsonErr(c, http.StatusBadRequest, "author name is required")
			}
			if !isValidSlug(slug) || slug == "_home" || len(slug) > 40 {
				return jsonErr(c, http.StatusBadRequest, "address: 3-40 chars, a-z 0-9 hyphens")
			}
			if reservedSubdomains[slug] {
				return jsonErr(c, http.StatusBadRequest, "this address is reserved by the site")
			}
			if taken := usernameOrSlugTaken(app, slug); taken != nil {
				return c.JSON(http.StatusConflict, map[string]any{
					"error":   "the address or username is already taken",
					"account": hostingAccountJSON(app, taken),
				})
			}
			users, err := app.FindCollectionByNameOrId("users")
			if err != nil {
				return jsonErr(c, http.StatusInternalServerError, "users collection missing")
			}
			u := core.NewRecord(users)
			u.Set("username", slug)
			if users.Fields.GetByName("name") != nil {
				u.Set("name", name)
			}
			u.SetEmail(slug + "@reserved.cyoa.cafe")
			u.SetEmailVisibility(false)
			u.SetPassword(randomHex(32)) // 64 chars: under bcrypt's 72-byte cap; nobody logs in as a reserved stub
			u.Set("is_reserved", true)
			u.Set("hosting_slug", slug)
			u.Set("hosting_max_games", 999)
			u.Set("hosting_daily_uploaded", 0)
			if err := app.Save(u); err != nil {
				return jsonErr(c, http.StatusBadRequest, "could not create the account: "+err.Error())
			}
			logModAction(app, c, modAction{
				Action: "modkit.reserved_create", Target: "users:" + u.Id + " " + slug,
				After:  map[string]any{"username": slug, "hosting_slug": slug, "name": name},
				Reversible: true,
				Note:       "reserved author account; the real author can claim it at " + makeHomeURL(slug),
			})
			return c.JSON(http.StatusOK, map[string]any{"account": hostingAccountJSON(app, u)})
		})).Bind(apis.RequireAuth())

		// --- duplicates ---

		g.GET("/dupcheck", modkitMod(app, func(c *core.RequestEvent) error {
			q := c.Request.URL.Query()
			return c.JSON(http.StatusOK, map[string]any{
				"hits": findDuplicates(app, strings.TrimSpace(q.Get("url")), strings.TrimSpace(q.Get("title"))),
			})
		})).Bind(apis.RequireAuth())

		// --- card → publication queue ---

		g.POST("/cards", modkitMod(app, func(c *core.RequestEvent) error {
			return modkitSubmitCard(app, c)
		})).Bind(apis.RequireAuth(), apis.BodyLimit(modCardImageMax+(1<<20)))

		// --- helper side ---

		g.GET("/helper/me", modkitHelper(app, func(c *core.RequestEvent, dev *core.Record) error {
			return c.JSON(http.StatusOK, map[string]any{
				"device": deviceJSON(dev), "user": c.Auth.GetString("username"),
			})
		}))

		g.GET("/helper/next", modkitHelper(app, func(c *core.RequestEvent, dev *core.Record) error {
			wait := helperLongPoll
			if s, err := strconv.Atoi(c.Request.URL.Query().Get("wait")); err == nil && s >= 0 && s < 25 {
				wait = time.Duration(s) * time.Second
			}
			deadline := time.Now().Add(wait)
			wake := deviceWake(dev.Id)
			for {
				job, err := claimNextJob(app, dev.Id)
				if err != nil {
					return jsonErr(c, http.StatusInternalServerError, "claim failed")
				}
				if job != nil {
					return c.JSON(http.StatusOK, map[string]any{"job": jobJSON(job, false)})
				}
				left := time.Until(deadline)
				if left <= 0 {
					return c.NoContent(http.StatusNoContent)
				}
				select {
				case <-wake:
				case <-time.After(left):
				case <-c.Request.Context().Done():
					return nil
				}
			}
		}))

		// Jobs the helper starts itself (its own menu): download/import/check, never upload — an
		// upload needs the author chosen on the site.
		g.POST("/helper/jobs", modkitHelper(app, func(c *core.RequestEvent, dev *core.Record) error {
			var body struct {
				Kind   string         `json:"kind"`
				Status string         `json:"status"`
				Input  map[string]any `json:"input"`
				Result map[string]any `json:"result"`
			}
			if err := c.BindBody(&body); err != nil {
				return jsonErr(c, http.StatusBadRequest, "invalid body")
			}
			if body.Kind == "upload" {
				return jsonErr(c, http.StatusBadRequest, "uploads are started from the Mod Tools page")
			}
			if body.Input == nil {
				body.Input = map[string]any{}
			}
			input, verr := validateJobInput(app, body.Kind, body.Input)
			if verr != nil {
				return jsonErr(c, http.StatusBadRequest, verr.Error())
			}
			status := "running"
			if body.Status == "done" {
				status = "done"
			}
			job, err := newHelperJob(app, c.Auth.Id, dev.Id, body.Kind, status, input)
			if err != nil {
				return jsonErr(c, http.StatusInternalServerError, "could not create the job")
			}
			if body.Result != nil {
				job.Set("result", body.Result)
				if err := app.Save(job); err != nil {
					return jsonErr(c, http.StatusBadRequest, "result rejected: "+err.Error())
				}
			}
			return c.JSON(http.StatusOK, map[string]any{"job": jobJSON(job, false)})
		}))

		g.POST("/helper/jobs/{id}/progress", modkitHelper(app, func(c *core.RequestEvent, dev *core.Record) error {
			var body struct {
				Status   string         `json:"status"`
				Progress map[string]any `json:"progress"`
				Log      string         `json:"log"`
				Result   map[string]any `json:"result"`
				Error    string         `json:"error"`
			}
			if err := c.BindBody(&body); err != nil {
				return jsonErr(c, http.StatusBadRequest, "invalid body")
			}
			job, err := app.FindRecordById(helperJobsColl, c.Request.PathValue("id"))
			if err != nil || job.GetString("device") != dev.Id {
				return jsonErr(c, http.StatusNotFound, "job not found")
			}
			if job.GetString("status") == "cancelled" {
				return c.JSON(http.StatusOK, map[string]any{"ok": true, "cancelled": true})
			}
			if job.GetString("status") != "running" {
				return jsonErr(c, http.StatusConflict, "job is not running")
			}
			if body.Progress != nil {
				job.Set("progress", body.Progress)
			}
			if body.Log != "" {
				logText := job.GetString("log") + body.Log
				if len(logText) > helperLogMax {
					logText = "…\n" + logText[len(logText)-helperLogMax+2000:]
				}
				job.Set("log", logText)
			}
			if body.Result != nil {
				// Server-owned keys (upload outcome) survive a helper-side result.
				prev := recordJSONMap(job, "result")
				if h, ok := prev["hosted"]; ok {
					body.Result["hosted"] = h
				}
				job.Set("result", body.Result)
			}
			switch body.Status {
			case "done":
				if job.GetString("kind") == "upload" {
					if _, ok := recordJSONMap(job, "result")["hosted"]; !ok {
						if _, ok2 := body.Result["hosted"]; !ok2 {
							return jsonErr(c, http.StatusConflict, "upload is not finished on the server")
						}
					}
				}
				job.Set("status", "done")
			case "failed":
				job.Set("status", "failed")
				job.Set("error", trimModField(body.Error, 2000))
			}
			if err := app.Save(job); err != nil {
				return jsonErr(c, http.StatusBadRequest, "save failed: "+err.Error())
			}
			return c.JSON(http.StatusOK, map[string]any{"ok": true, "cancelled": false})
		}))

		// Upload parts for an upload job. Target account, slot and title come from the job the
		// moderator created on the site, never from the form.
		g.POST("/helper/upload-part", modkitHelper(app, func(c *core.RequestEvent, dev *core.Record) error {
			if hostingR2 == nil {
				return jsonErr(c, http.StatusServiceUnavailable, "hosting storage is not configured on this server")
			}
			job, err := app.FindRecordById(helperJobsColl, strings.TrimSpace(c.Request.FormValue("job")))
			if err != nil || job.GetString("device") != dev.Id || job.GetString("kind") != "upload" {
				return jsonErr(c, http.StatusNotFound, "upload job not found")
			}
			if job.GetString("status") != "running" {
				return jsonErr(c, http.StatusConflict, "upload job is not running (cancelled?)")
			}
			in := recordJSONMap(job, "input")
			userSlug, slug, title := strField(in, "user_slug"), strField(in, "slug"), strField(in, "title")
			target, err := app.FindFirstRecordByFilter("users", "hosting_slug = {:s}", dbx.Params{"s": userSlug})
			if err != nil || target == nil || !target.GetBool("is_reserved") {
				return jsonErr(c, http.StatusConflict, "the author account is gone or no longer reserved")
			}
			slotKey := userSlug + "/" + slug
			if !lockSlot(slotKey, job.Id) {
				return jsonErr(c, http.StatusConflict, "another upload to "+slotKey+" is in progress")
			}
			res, err := uploadPartForUser(app, c, hostingR2, hostingBucket, target, uploadPartOpts{
				NewOnly: true, Actor: "moderator " + c.Auth.GetString("username"),
				Slug: slug, Title: title,
			})
			if res == nil || !res.Final {
				return err
			}
			unlockSlot(slotKey)
			result := recordJSONMap(job, "result")
			result["hosted"] = map[string]any{
				"id": res.RecordID, "url": res.URL, "user_slug": userSlug, "slug": res.Slug,
				"version": res.Version, "files": res.Files, "size": res.Size,
			}
			job.Set("result", result)
			job.Set("status", "done")
			if serr := app.Save(job); serr != nil {
				app.Logger().Error("modkit: upload finished but job not saved", "job", job.Id, "error", serr.Error())
			}
			logModAction(app, c, modAction{
				Action: "modkit.upload", Target: "hosted_games:" + res.RecordID + " " + slotKey,
				After:  map[string]any{"url": res.URL, "files": res.Files, "size": res.Size, "job": job.Id},
				Reversible: true, Note: "undo = block/purge the hosted game on the hosting moderation page",
			})
			return err
		})).Bind(apis.BodyLimit(maxZipSize))

		return se.Next()
	})
}

func newHelperJob(app core.App, userID, deviceID, kind, status string, input map[string]any) (*core.Record, error) {
	col, err := app.FindCollectionByNameOrId(helperJobsColl)
	if err != nil {
		return nil, err
	}
	job := core.NewRecord(col)
	job.Set("user", userID)
	job.Set("device", deviceID)
	job.Set("kind", kind)
	job.Set("status", status)
	job.Set("input", input)
	if err := app.Save(job); err != nil {
		return nil, err
	}
	return job, nil
}

func claimNextJob(app core.App, deviceID string) (*core.Record, error) {
	claimMu.Lock()
	defer claimMu.Unlock()
	jobs, err := app.FindRecordsByFilter(helperJobsColl, "device = {:d} && status = 'queued'", "created", 1, 0,
		dbx.Params{"d": deviceID})
	if err != nil || len(jobs) == 0 {
		return nil, nil
	}
	job := jobs[0]
	job.Set("status", "running")
	if err := app.Save(job); err != nil {
		return nil, err
	}
	return job, nil
}

// Whitelist of job inputs. Local paths never come from the server: the helper only works inside its
// own workspace folder and refers to games by item id.
func validateJobInput(app core.App, kind string, in map[string]any) (map[string]any, error) {
	if !jobKinds[kind] {
		return nil, errors.New("unknown job kind")
	}
	out := map[string]any{}
	switch kind {
	case "download":
		u, err := publicHTTPURL(strField(in, "url"))
		if err != nil {
			return nil, err
		}
		out["url"] = u.String()
		if item := strField(in, "item"); item != "" {
			if !helperItemRe.MatchString(item) {
				return nil, errors.New("bad item id")
			}
			out["item"] = item
		}
	case "import", "check":
		item := strField(in, "item")
		if !helperItemRe.MatchString(item) {
			return nil, errors.New("bad item id")
		}
		out["item"] = item
		if name := strField(in, "name"); name != "" {
			out["name"] = trimModField(name, 200)
		}
	case "upload":
		item := strField(in, "item")
		if !helperItemRe.MatchString(item) {
			return nil, errors.New("bad item id")
		}
		userSlug := strings.ToLower(strField(in, "user_slug"))
		slug := strings.ToLower(strField(in, "slug"))
		title := strField(in, "title")
		if title == "" || len(title) > maxTitleLen {
			return nil, errors.New("title is required")
		}
		if !isValidSlug(slug) || slug == "_home" {
			return nil, errors.New("game address: 3-60 chars, a-z 0-9 hyphens")
		}
		target, err := app.FindFirstRecordByFilter("users", "hosting_slug = {:s}", dbx.Params{"s": userSlug})
		if err != nil || target == nil {
			return nil, errors.New("pick or create the author's hosting account first")
		}
		if !target.GetBool("is_reserved") {
			return nil, errors.New("this author has a real account on the site — moderators can only upload to reserved author accounts; ask the author or an admin")
		}
		if dup, _ := app.FindFirstRecordByFilter("hosted_games", "owner = {:o} && slug = {:s}",
			dbx.Params{"o": target.Id, "s": slug}); dup != nil {
			return nil, fmt.Errorf("%s already exists — pick another game address", makeGameURL(userSlug, slug))
		}
		out["item"], out["user_slug"], out["slug"], out["title"] = item, userSlug, slug, title
		if s := strField(in, "source_url"); s != "" {
			out["source_url"] = trimModField(s, 2000)
		}
	}
	return out, nil
}

// ---- card submission ----

type modCardPayload struct {
	Title               string   `json:"title"`
	Description         string   `json:"description"`
	Authors             []string `json:"authors"`
	Tags                []string `json:"tags"`
	NSFW                bool     `json:"nsfw"`
	SourceURL           string   `json:"source_url"`
	UploadJob           string   `json:"upload_job"`
	Aliases             string   `json:"aliases"`
	ImageBase64         string   `json:"image_base64"`
	ConfirmNotDuplicate bool     `json:"confirm_not_duplicate"`
	Note                string   `json:"note"`
}

func modkitSubmitCard(app core.App, c *core.RequestEvent) error {
	var p modCardPayload
	if err := json.Unmarshal([]byte(c.Request.FormValue("payload")), &p); err != nil {
		return jsonErr(c, http.StatusBadRequest, "invalid payload")
	}
	p.Title = strings.TrimSpace(p.Title)
	p.Description = strings.TrimSpace(p.Description)
	switch {
	case p.Title == "" || len(p.Title) > maxTitleLen:
		return jsonErr(c, http.StatusBadRequest, "title is required")
	case p.Description == "":
		return jsonErr(c, http.StatusBadRequest, "write a short description")
	case len(p.Description) > maxDescLen:
		return jsonErr(c, http.StatusBadRequest, "description is too long")
	case len(p.Authors) == 0:
		return jsonErr(c, http.StatusBadRequest, "pick at least one author")
	case len(p.Tags) == 0:
		return jsonErr(c, http.StatusBadRequest, "pick the tags")
	case len(p.ImageBase64) > 200_000:
		return jsonErr(c, http.StatusBadRequest, "placeholder image is too large")
	}

	job, err := app.FindRecordById(helperJobsColl, p.UploadJob)
	if err != nil || job.GetString("user") != c.Auth.Id || job.GetString("kind") != "upload" {
		return jsonErr(c, http.StatusBadRequest, "upload the game with your helper first")
	}
	hosted, _ := recordJSONMap(job, "result")["hosted"].(map[string]any)
	hostedURL, hostedID := strField(hosted, "url"), strField(hosted, "id")
	if hostedURL == "" {
		return jsonErr(c, http.StatusBadRequest, "that upload hasn't finished")
	}
	if prev, _ := app.FindFirstRecordByFilter("game_pipeline_state", "hosted_url = {:u}",
		dbx.Params{"u": hostedURL}); prev != nil {
		return jsonErr(c, http.StatusConflict, "a card for this upload was already submitted ("+prev.GetString("slug")+")")
	}

	authorNames := make([]string, 0, len(p.Authors))
	for _, id := range p.Authors {
		a, err := app.FindRecordById("authors", id)
		if err != nil {
			return jsonErr(c, http.StatusBadRequest, "unknown author "+id)
		}
		authorNames = append(authorNames, a.GetString("name"))
	}
	for _, id := range p.Tags {
		if _, err := app.FindRecordById("tags", id); err != nil {
			return jsonErr(c, http.StatusBadRequest, "unknown tag "+id)
		}
	}

	source := strings.TrimSpace(p.SourceURL)
	if source != "" {
		if _, err := publicHTTPURL(source); err != nil {
			return jsonErr(c, http.StatusBadRequest, "original link: "+err.Error())
		}
	}
	if hits := findDuplicates(app, source, p.Title); len(hits) > 0 && !p.ConfirmNotDuplicate {
		return c.JSON(http.StatusConflict, map[string]any{
			"error":      "this looks like a game that is already on the site",
			"duplicates": hits,
		})
	}

	originalURL := canonicalSourceURL(source)
	if originalURL == "" {
		originalURL = strings.TrimRight(hostedURL, "/")
	}
	if prev, _ := app.FindFirstRecordByFilter("game_pipeline_state", "original_url = {:u}",
		dbx.Params{"u": originalURL}); prev != nil {
		return jsonErr(c, http.StatusConflict, fmt.Sprintf(
			"this link is already in the pipeline as %q (state: %s) — it may be a duplicate",
			prev.GetString("slug"), prev.GetString("state")))
	}

	col, err := app.FindCollectionByNameOrId("game_pipeline_state")
	if err != nil {
		return jsonErr(c, http.StatusInternalServerError, "pipeline collection missing")
	}
	rec := core.NewRecord(col)

	baseSlug := strField(hosted, "user_slug") + "__" + strField(hosted, "slug")
	slug := baseSlug
	for i := 2; i < 50; i++ {
		if ex, _ := app.FindFirstRecordByFilter("game_pipeline_state", "slug = {:s}", dbx.Params{"s": slug}); ex == nil {
			break
		}
		slug = fmt.Sprintf("%s-%d", baseSlug, i)
	}

	rec.Set("slug", slug)
	rec.Set("original_url", originalURL)
	rec.Set("source_url", source)
	rec.Set("state", "approved")
	rec.Set("publish_mode", "create")
	rec.Set("title", p.Title)
	rec.Set("author", strings.Join(authorNames, ", "))
	rec.Set("authors", p.Authors)
	rec.Set("tags", p.Tags)
	rec.Set("nsfw", p.NSFW)
	if p.NSFW {
		rec.Set("type", "NSFW")
	} else {
		rec.Set("type", "SFW")
	}
	rec.Set("hosted_url", hostedURL)
	if hostedID != "" {
		rec.Set("hosted_game", hostedID)
	}
	rec.Set("img_or_link", "link")
	rec.Set("description", p.Description)
	rec.Set("image_base64", p.ImageBase64)
	if col.Fields.GetByName("aliases") != nil {
		rec.Set("aliases", strings.TrimSpace(p.Aliases))
	}
	if note := strings.TrimSpace(p.Note); note != "" {
		rec.Set("moderator_note", trimModField(note, 2000))
	}
	rec.Set("data", map[string]any{
		"mod_upload": map[string]any{
			"by": c.Auth.Id, "by_name": c.Auth.GetString("username"),
			"at": time.Now().UTC().Format(time.RFC3339), "job": job.Id, "checked": false,
		},
	})

	file, header, err := c.Request.FormFile("image")
	if err != nil {
		return jsonErr(c, http.StatusBadRequest, "attach the cover screenshot")
	}
	defer file.Close()
	if header.Size > modCardImageMax {
		return jsonErr(c, http.StatusBadRequest, "cover is larger than 5 MB")
	}
	imgBytes, err := io.ReadAll(io.LimitReader(file, modCardImageMax+1))
	if err != nil || len(imgBytes) > modCardImageMax {
		return jsonErr(c, http.StatusBadRequest, "cover is larger than 5 MB")
	}
	ct := http.DetectContentType(imgBytes)
	ext := map[string]string{"image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg"}[ct]
	if ext == "" {
		return jsonErr(c, http.StatusBadRequest, "cover must be a WebP, PNG or JPEG image")
	}
	f, err := filesystem.NewFileFromBytes(imgBytes, "cover"+ext)
	if err != nil {
		return jsonErr(c, http.StatusInternalServerError, "cover rejected")
	}
	rec.Set("image", f)

	if err := app.Save(rec); err != nil {
		return jsonErr(c, http.StatusBadRequest, "could not queue the card: "+err.Error())
	}
	logModAction(app, c, modAction{
		Action: "modkit.card_submit", Target: "game_pipeline_state:" + rec.Id + " " + slug,
		After: map[string]any{
			"title": p.Title, "hosted_url": hostedURL, "source_url": source,
			"duplicates_confirmed": p.ConfirmNotDuplicate,
		},
		Reversible: true, Note: "undo = dismiss it in the publication queue",
	})
	return c.JSON(http.StatusOK, map[string]any{"id": rec.Id, "slug": slug})
}
