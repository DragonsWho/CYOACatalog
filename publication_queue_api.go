// Moderator-only endpoints for /moderator/queue. game_pipeline_state / publication_settings are
// admin-only, so we use privileged $app and check isModerator ourselves. Spec:
// Documentation/publication_queue_spec.md §5. The actual queue→games move is the Go cron
// (publication_queue.go).
package main

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

var pqListableStates = map[string]bool{
	"approved": true, "publishing": true, "publish_failed": true,
	"dismissed": true, "published": true,
}

func registerPublicationQueueAPI(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		g := e.Router.Group("/api/pipeline/queue")
		g.Bind(apis.RequireAuth())

		g.GET("/status", pqGuard(func(c *core.RequestEvent) error { return pqStatus(app, c) }))
		g.GET("/items", pqGuard(func(c *core.RequestEvent) error { return pqItems(app, c) }))
		g.PATCH("/settings", pqGuard(func(c *core.RequestEvent) error { return pqUpdateSettings(app, c) }))
		g.POST("/publish-now", pqGuard(func(c *core.RequestEvent) error { return pqPublishNow(app, c) }))
		g.POST("/items/{id}/publish", pqGuard(func(c *core.RequestEvent) error { return pqPublishItemNow(app, c) }))
		g.POST("/items/{id}/dismiss", pqGuard(func(c *core.RequestEvent) error { return pqSetItemState(app, c, "dismissed") }))
		g.POST("/items/{id}/requeue", pqGuard(func(c *core.RequestEvent) error { return pqSetItemState(app, c, "approved") }))
		g.POST("/items/{id}/check", pqGuard(func(c *core.RequestEvent) error { return pqCheckModUpload(app, c) }))
		g.GET("/items/{id}/cover", pqGuard(func(c *core.RequestEvent) error { return pqItemCover(app, c) }))

		return e.Next()
	})
}

func pqGuard(h func(*core.RequestEvent) error) func(*core.RequestEvent) error {
	return func(c *core.RequestEvent) error {
		if !hasPerm(c, permQueue) {
			return c.ForbiddenError("moderator only", nil)
		}
		return h(c)
	}
}

func pqCount(app core.App, sql string) int64 {
	n, err := app.CountRecords(pqQueueCol, dbx.NewExp(sql))
	if err != nil {
		return 0
	}
	return n
}

func pqStatus(app core.App, c *core.RequestEvent) error {
	s, err := loadSettings(app)
	if err != nil {
		return c.InternalServerError("settings unavailable", err)
	}
	approved := pqCount(app, "state = 'approved'")
	approvedNsfw := pqCount(app, "state = 'approved' AND nsfw = 1")

	interval := s.GetInt("interval_minutes")
	etaHours := 0.0
	if interval > 0 {
		etaHours = float64(approved) * float64(interval) / 60.0
	}

	return c.JSON(http.StatusOK, map[string]any{
		"enabled":           s.GetBool("enabled"),
		"interval_minutes":  s.GetInt("interval_minutes"),
		"jitter_minutes":    s.GetInt("jitter_minutes"),
		"next_publish_at":   s.GetDateTime("next_publish_at").String(),
		"last_published_at": s.GetDateTime("last_published_at").String(),
		"publish_uploader":  s.GetString("publish_uploader"),
		"counts": map[string]any{
			"approved":           approved,
			"approved_nsfw":      approvedNsfw,
			"approved_sfw":       approved - approvedNsfw,
			"approved_community": pqCount(app, "state = 'approved' AND submitted_by != ''"),
			"publishing":         pqCount(app, "state = 'publishing'"),
			"publish_failed":     pqCount(app, "state = 'publish_failed'"),
			"published":          pqCount(app, "state = 'published'"),
			"dismissed":          pqCount(app, "state = 'dismissed'"),
			"mod_unchecked":      pqCountModUnchecked(app),
		},
		"drain_eta_hours": etaHours,
	})
}

// Per-request id→name cache; without it a 30-row page with many tags does hundreds of point
// queries.
type pqNameCache struct {
	app  core.App
	coll string
	seen map[string]string
}

func newPQNameCache(app core.App, coll string) *pqNameCache {
	return &pqNameCache{app: app, coll: coll, seen: map[string]string{}}
}

func (c *pqNameCache) refs(ids []string) []map[string]any {
	out := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		name, ok := c.seen[id]
		if !ok {
			if rec, err := c.app.FindRecordById(c.coll, id); err == nil && rec != nil {
				name = rec.GetString("name")
			}
			c.seen[id] = name
		}
		if name == "" {
			name = id
		}
		out = append(out, map[string]any{"id": id, "name": name})
	}
	return out
}

func pqItems(app core.App, c *core.RequestEvent) error {
	q := c.Request.URL.Query()
	state := q.Get("state")
	if state == "" {
		state = "approved"
	}
	if !pqListableStates[state] {
		return c.BadRequestError("unsupported state filter", nil)
	}
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	perPage, _ := strconv.Atoi(q.Get("perPage"))
	if perPage < 1 || perPage > 100 {
		perPage = 30
	}
	offset := (page - 1) * perPage

	expr := dbx.NewExp("state = {:s}", dbx.Params{"s": state})
	total, _ := app.CountRecords(pqQueueCol, expr)

	sort := "-created"
	if state == "approved" {
		// Community suggestions first — the cron publishes them first, the panel shows the same order.
		// DESC on a relation field puts non-empty ids first.
		sort = "-submitted_by,-created"
	}
	recs, err := app.FindRecordsByFilter(
		pqQueueCol,
		"state = {:s}",
		sort,
		perPage, offset,
		dbx.Params{"s": state},
	)
	if err != nil {
		return c.InternalServerError("list failed", err)
	}

	// `aliases` in game_pipeline_state is added by hand; until then has_aliases:false and the frontend
	// hides the input instead of losing typed text.
	hasAliases := false
	if col, cerr := app.FindCollectionByNameOrId(pqQueueCol); cerr == nil && col != nil {
		hasAliases = col.Fields.GetByName("aliases") != nil
	}
	authorNames := newPQNameCache(app, "authors")
	tagNames := newPQNameCache(app, "tags")

	items := make([]map[string]any, 0, len(recs))
	for _, r := range recs {
		submittedBy := r.GetString("submitted_by")
		submitter := ""
		if submittedBy != "" {
			if u, uerr := app.FindRecordById("users", submittedBy); uerr == nil && u != nil {
				submitter = u.GetString("name")
				if submitter == "" {
					submitter = u.GetString("username")
				}
			}
		}
		items = append(items, map[string]any{
			"id":           r.Id,
			"title":        r.GetString("title"),
			"slug":         r.GetString("slug"),
			"nsfw":         r.GetBool("nsfw"),
			"img_or_link":  r.GetString("img_or_link"),
			"publish_mode": r.GetString("publish_mode"),
			"state":        r.GetString("state"),
			"npages":       len(r.GetStringSlice("cyoa_pages")),
			"ntags":        len(r.GetStringSlice("tags")),
			"has_image":    r.GetString("image") != "",
			// `game` decides which adapter the shared editor uses: edits to a published row must go to the
			// catalog, not silently stay in the queue.
			"game":            r.GetString("game"),
			"author":          r.GetString("author"),
			"authors":         authorNames.refs(r.GetStringSlice("authors")),
			"tags":            tagNames.refs(r.GetStringSlice("tags")),
			"aliases":         r.GetString("aliases"),
			"has_aliases":     hasAliases,
			"original_url":    r.GetString("original_url"),
			"attempts":        r.GetInt("attempts"),
			"error":           r.GetString("error"),
			"created":         r.GetDateTime("created").String(),
			"review_reasons":  r.GetStringSlice("review_reasons"),
			"dedup_note":      r.GetString("dedup_note"),
			"dedup_candidate": r.GetString("dedup_candidate"),
			"moderator_note":  r.GetString("moderator_note"),
			"community":       submittedBy != "",
			"submitter":       submitter,
			"mod_upload":      modUploadInfo(r),
			// Only moderator uploads need the text here (the checker reads it before approving).
			"description": func() string {
				if modUploadInfo(r) == nil {
					return ""
				}
				return r.GetString("description")
			}(),
			"hosted_url":      r.GetString("hosted_url"),
			"source_url":      r.GetString("source_url"),
		})
	}

	return c.JSON(http.StatusOK, map[string]any{
		"page":       page,
		"perPage":    perPage,
		"totalItems": total,
		"totalPages": (total + int64(perPage) - 1) / int64(perPage),
		"items":      items,
	})
}

type pqSettingsPatch struct {
	Enabled         *bool   `json:"enabled"`
	IntervalMinutes *int    `json:"interval_minutes"`
	JitterMinutes   *int    `json:"jitter_minutes"`
	PublishUploader *string `json:"publish_uploader"`
}

func pqUpdateSettings(app core.App, c *core.RequestEvent) error {
	s, err := loadSettings(app)
	if err != nil {
		return c.InternalServerError("settings unavailable", err)
	}
	body := &pqSettingsPatch{}
	if err := c.BindBody(body); err != nil {
		return c.BadRequestError("invalid body", err)
	}
	pqFields := []string{"enabled", "interval_minutes", "jitter_minutes", "publish_uploader"}
	pqBefore := modSnapshot(s, pqFields...)
	if body.Enabled != nil {
		s.Set("enabled", *body.Enabled)
	}
	if body.IntervalMinutes != nil {
		if *body.IntervalMinutes < 1 {
			return c.BadRequestError("interval_minutes must be >= 1", nil)
		}
		s.Set("interval_minutes", *body.IntervalMinutes)
	}
	if body.JitterMinutes != nil {
		if *body.JitterMinutes < 0 {
			return c.BadRequestError("jitter_minutes must be >= 0", nil)
		}
		s.Set("jitter_minutes", *body.JitterMinutes)
	}
	if body.PublishUploader != nil {
		s.Set("publish_uploader", *body.PublishUploader)
	}
	if err := app.Save(s); err != nil {
		return c.InternalServerError("save failed", err)
	}
	logModAction(app, c, modAction{
		Action:     "queue.settings",
		Target:     s.Id,
		Before:     pqBefore,
		After:      modSnapshot(s, pqFields...),
		Reversible: true,
	})
	return pqStatus(app, c)
}

func pqPublishNow(app core.App, c *core.RequestEvent) error {
	s, err := loadSettings(app)
	if err != nil {
		return c.InternalServerError("settings unavailable", err)
	}
	prevNext := s.GetDateTime("next_publish_at").String()
	s.Set("next_publish_at", time.Now())
	if err := app.Save(s); err != nil {
		return c.InternalServerError("save failed", err)
	}
	logModAction(app, c, modAction{
		Action:     "queue.publish_now",
		Target:     s.Id,
		Before:     map[string]any{"next_publish_at": prevNext},
		After:      map[string]any{"next_publish_at": s.GetDateTime("next_publish_at").String()},
		Reversible: true,
		Note:       "the next tick publishes immediately; the published card itself is not undone by restoring the timer",
	})
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "next_publish_at": s.GetDateTime("next_publish_at").String()})
}

// Publish THIS row now, synchronously, bypassing queue/timer; next_publish_at unchanged (manual
// publish mustn't eat the next auto slot).
func pqPublishItemNow(app core.App, c *core.RequestEvent) error {
	id := c.Request.PathValue("id")
	rec, err := app.FindRecordById(pqQueueCol, id)
	if err != nil {
		return c.NotFoundError("queue item not found", err)
	}
	state := rec.GetString("state")
	if state != "approved" && state != "publish_failed" && state != "dismissed" {
		return c.BadRequestError("item is not publishable (state="+state+")", nil)
	}
	if rec.GetString("publish_mode") == "skip" {
		return c.BadRequestError("publish_mode=skip", nil)
	}
	// Publishing a moderator's upload by hand counts as the check, so the same second-pair-of-eyes
	// rule applies.
	checkedNow := false
	if modUploadAwaitingCheck(rec) {
		if err := canCheckModUpload(c, rec); err != nil {
			return err
		}
		markModUploadChecked(c, rec)
		checkedNow = true
	}

	settings, err := loadSettings(app)
	if err != nil {
		return c.InternalServerError("settings unavailable", err)
	}

	// Lock so the cron tick can't grab the same row concurrently.
	now := time.Now()
	stateBefore := modSnapshot(rec, "state", "error", "attempts")
	rec.Set("state", "publishing")
	rec.Set("locked_until", now.Add(pqLockMinutes*time.Minute))
	rec.Set("locked_by", "moderator")
	if err := app.Save(rec); err != nil {
		return c.InternalServerError("lock failed", err)
	}

	gameID, perr := publishOne(app, rec, settings)
	if perr != nil {
		handlePublishFailure(app, rec, perr)
		return c.InternalServerError("publish failed: "+perr.Error(), perr)
	}

	rec.Set("state", "published")
	rec.Set("game", gameID)
	rec.Set("error", "")
	rec.Set("locked_until", nil)
	rec.Set("locked_by", "")
	clearQueueFiles(rec)
	if err := app.Save(rec); err != nil {
		app.Logger().Error("manual publish: failed to finalize queue record", "id", rec.Id, "error", err.Error())
		return c.InternalServerError("published, but queue record not finalized", err)
	}
	app.Logger().Info("published game from queue (manual)", "queue_id", rec.Id, "game_id", gameID, "mode", rec.GetString("publish_mode"))

	if checkedNow {
		logModAction(app, c, modAction{
			Action: "queue.mod_upload_checked", Target: id + " " + rec.GetString("slug"), Game: gameID,
			After: modUploadInfo(rec), Reversible: false, Note: "checked by publishing it",
		})
	}
	logModAction(app, c, modAction{
		Action:     "queue.item_publish_now",
		Target:     id + " " + rec.GetString("slug"),
		Game:       gameID,
		Before:     stateBefore,
		After:      modSnapshot(rec, "state", "error", "attempts"),
		Reversible: false,
		Note:       "card is live in the catalogue; undo = hide/delete the games record",
	})
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "id": id, "game": gameID})
}

func pqSetItemState(app core.App, c *core.RequestEvent, newState string) error {
	id := c.Request.PathValue("id")
	rec, err := app.FindRecordById(pqQueueCol, id)
	if err != nil {
		return c.NotFoundError("queue item not found", err)
	}
	stateBefore := modSnapshot(rec, "state", "error", "attempts")
	rec.Set("state", newState)
	rec.Set("locked_until", nil)
	rec.Set("locked_by", "")
	if newState == "approved" {
		rec.Set("error", "")
		rec.Set("attempts", 0)
	}
	if err := app.Save(rec); err != nil {
		return c.InternalServerError("save failed", err)
	}
	logModAction(app, c, modAction{
		Action:     "queue.item_" + newState,
		Target:     id + " " + rec.GetString("slug"),
		Game:       rec.GetString("game"),
		Before:     stateBefore,
		After:      modSnapshot(rec, "state", "error", "attempts"),
		Reversible: true,
	})
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "id": id, "state": newState})
}

func pqCountModUnchecked(app core.App) int64 {
	var n int64
	err := app.ConcurrentDB().NewQuery(
		"SELECT COUNT(*) FROM " + pqQueueCol + " WHERE state = 'approved' AND " +
			"(CASE WHEN json_valid(data) THEN json_extract(data, '$.mod_upload.by') END) IS NOT NULL AND " +
			"COALESCE(CASE WHEN json_valid(data) THEN json_extract(data, '$.mod_upload.checked') END, 0) = 0",
	).Row(&n)
	if err != nil {
		return 0
	}
	return n
}

// The uploader can't check their own card; the site owner (review permission) and superusers can.
func canCheckModUpload(c *core.RequestEvent, rec *core.Record) error {
	mu := modUploadInfo(rec)
	by, _ := mu["by"].(string)
	if c.Auth != nil && c.Auth.Id == by && !hasPerm(c, permReview) {
		return c.ForbiddenError("Another moderator has to check your own upload.", nil)
	}
	return nil
}

func markModUploadChecked(c *core.RequestEvent, rec *core.Record) {
	data := recordJSONMap(rec, "data")
	mu, _ := data["mod_upload"].(map[string]any)
	if mu == nil {
		return
	}
	mu["checked"] = true
	mu["checked_at"] = time.Now().UTC().Format(time.RFC3339)
	if c.Auth != nil {
		mu["checked_by"] = c.Auth.Id
		mu["checked_by_name"] = c.Auth.GetString("username")
	}
	data["mod_upload"] = mu
	rec.Set("data", data)
}

func pqCheckModUpload(app core.App, c *core.RequestEvent) error {
	id := c.Request.PathValue("id")
	rec, err := app.FindRecordById(pqQueueCol, id)
	if err != nil {
		return c.NotFoundError("queue item not found", err)
	}
	if !modUploadAwaitingCheck(rec) {
		return c.BadRequestError("not a moderator upload waiting for a check", nil)
	}
	if err := canCheckModUpload(c, rec); err != nil {
		return err
	}
	markModUploadChecked(c, rec)
	if err := app.Save(rec); err != nil {
		return c.InternalServerError("save failed", err)
	}
	logModAction(app, c, modAction{
		Action: "queue.mod_upload_checked", Target: id + " " + rec.GetString("slug"),
		After: modUploadInfo(rec), Reversible: true,
		Note: "the timer may now publish it; undo = dismiss the item",
	})
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "id": id, "mod_upload": modUploadInfo(rec)})
}

// Staged cover of a queue row (game_pipeline_state files are superuser-only, so moderators get
// them through here; fetched with the auth header and shown as an object URL).
func pqItemCover(app core.App, c *core.RequestEvent) error {
	rec, err := app.FindRecordById(pqQueueCol, c.Request.PathValue("id"))
	if err != nil {
		return c.NotFoundError("queue item not found", err)
	}
	name := rec.GetString("image")
	if name == "" {
		return c.NotFoundError("no cover staged", nil)
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return c.InternalServerError("storage unavailable", err)
	}
	defer fsys.Close()
	r, err := fsys.GetReader(rec.BaseFilesPath() + "/" + name)
	if err != nil {
		return c.NotFoundError("cover file missing", err)
	}
	defer r.Close()
	ct := "image/webp"
	switch {
	case strings.HasSuffix(strings.ToLower(name), ".png"):
		ct = "image/png"
	case strings.HasSuffix(strings.ToLower(name), ".jpg"), strings.HasSuffix(strings.ToLower(name), ".jpeg"):
		ct = "image/jpeg"
	}
	c.Response.Header().Set("Content-Type", ct)
	c.Response.Header().Set("Cache-Control", "private, max-age=300")
	c.Response.WriteHeader(http.StatusOK)
	_, err = io.Copy(c.Response, r)
	return err
}
