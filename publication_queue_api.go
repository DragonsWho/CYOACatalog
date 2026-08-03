// publication_queue_api.go
//
// Moderator-only эндпоинты для страницы /moderator/queue (фронт зовёт через
// pb.send('/api/pipeline/queue/...'), как и существующая ревью-панель). Коллекции
// game_pipeline_state / publication_settings admin-only, поэтому ходим через
// привилегированный $app и сами проверяем isModerator.
//
// Спека: site-frontend-backend/Documentation/publication_queue_spec.md §5
// Сам перенос очередь→games делает Go-крон (publication_queue.go).

package main

import (
	"net/http"
	"strconv"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// состояния очереди, которые панель может листать
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
		g.POST("/items/{id}/dismiss", pqGuard(func(c *core.RequestEvent) error { return pqSetItemState(app, c, "dismissed") }))
		g.POST("/items/{id}/requeue", pqGuard(func(c *core.RequestEvent) error { return pqSetItemState(app, c, "approved") }))

		return e.Next()
	})
}

func pqGuard(h func(*core.RequestEvent) error) func(*core.RequestEvent) error {
	return func(c *core.RequestEvent) error {
		if c.Auth == nil || !c.Auth.GetBool("isModerator") {
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

// GET /status — настройки + счётчики очереди.
func pqStatus(app core.App, c *core.RequestEvent) error {
	s, err := loadSettings(app)
	if err != nil {
		return c.InternalServerError("settings unavailable", err)
	}
	approved := pqCount(app, "state = 'approved'")
	approvedNsfw := pqCount(app, "state = 'approved' AND nsfw = 1")

	// грубая оценка темпа: сколько часов до опустошения при текущем интервале
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
			"publishing":     pqCount(app, "state = 'publishing'"),
			"publish_failed": pqCount(app, "state = 'publish_failed'"),
			"published":      pqCount(app, "state = 'published'"),
			"dismissed":      pqCount(app, "state = 'dismissed'"),
		},
		"drain_eta_hours": etaHours,
	})
}

// GET /items?state=approved&page=1&perPage=30 — компактный пагинированный список.
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
		// community-предложения (submitted_by != "") — в голову списка: крон
		// публикует их первыми, панель должна показывать тот же порядок.
		// DESC по relation-полю ставит непустые id раньше пустых.
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
			"id":            r.Id,
			"title":         r.GetString("title"),
			"slug":          r.GetString("slug"),
			"nsfw":          r.GetBool("nsfw"),
			"img_or_link":   r.GetString("img_or_link"),
			"publish_mode":  r.GetString("publish_mode"),
			"state":         r.GetString("state"),
			"npages":        len(r.GetStringSlice("cyoa_pages")),
			"ntags":         len(r.GetStringSlice("tags")),
			"has_image":     r.GetString("image") != "",
			"original_url":  r.GetString("original_url"),
			"attempts":      r.GetInt("attempts"),
			"error":         r.GetString("error"),
			"created":       r.GetDateTime("created").String(),
			// dedup trace (baked at s06b, dedup v3) — visible for post-approval audit
			"review_reasons":  r.GetStringSlice("review_reasons"),
			"dedup_note":      r.GetString("dedup_note"),
			"dedup_candidate": r.GetString("dedup_candidate"),
			"moderator_note":  r.GetString("moderator_note"),
			"community":       submittedBy != "",
			"submitter":       submitter,
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

// PATCH /settings — правка синглтона (только переданные поля).
func pqUpdateSettings(app core.App, c *core.RequestEvent) error {
	s, err := loadSettings(app)
	if err != nil {
		return c.InternalServerError("settings unavailable", err)
	}
	body := &pqSettingsPatch{}
	if err := c.BindBody(body); err != nil {
		return c.BadRequestError("invalid body", err)
	}
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
	return pqStatus(app, c)
}

// POST /publish-now — следующий тик опубликует немедленно.
func pqPublishNow(app core.App, c *core.RequestEvent) error {
	s, err := loadSettings(app)
	if err != nil {
		return c.InternalServerError("settings unavailable", err)
	}
	s.Set("next_publish_at", time.Now())
	if err := app.Save(s); err != nil {
		return c.InternalServerError("save failed", err)
	}
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "next_publish_at": s.GetDateTime("next_publish_at").String()})
}

// POST /items/{id}/{dismiss|requeue} — сменить state записи очереди.
func pqSetItemState(app core.App, c *core.RequestEvent, newState string) error {
	id := c.Request.PathValue("id")
	rec, err := app.FindRecordById(pqQueueCol, id)
	if err != nil {
		return c.NotFoundError("queue item not found", err)
	}
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
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "id": id, "state": newState})
}
