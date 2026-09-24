// Drip-feed publishing: a server cron moves one approved row from game_pipeline_state
// (state=approved) into games on a timer, independent of the laptop. Dedup verdict (publish_mode)
// is baked at processing time; the cron just executes it plus a cheap exact check. Files copied via
// core.Filesystem (local disk or R2). Spec: Documentation/publication_pipeline_architecture.md,
// PB/schema_changes_publication_queue.md (§3,§6,§7).
package main

import (
	"fmt"
	"io"
	"math/rand"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

const (
	pqSettingsCol = "publication_settings"
	pqQueueCol    = "game_pipeline_state"
	pqGamesCol    = "games"
	pqLockMinutes = 10
	pqMaxAttempts = 5
)

var pqFileFields = []string{"image", "cyoa_pages", "cyoa_pages_preview"}

// uploader is NOT here — set only on create (§7), never on update.
var pqScalarMap = map[string]string{
	"title":        "title",
	"description":  "description",
	"image_base64": "image_base64",
	"img_or_link":  "img_or_link",
	"hosted_url":   "iframe_url",
	"release_date": "release_date",
}

func registerPublicationQueue(app core.App) {
	app.Cron().MustAdd("publication_queue", "* * * * *", func() {
		if err := publicationTick(app); err != nil {
			app.Logger().Error("publication queue tick failed", "error", err.Error())
		}
	})
}

func publicationTick(app core.App) error {
	settings, err := loadSettings(app)
	if err != nil {
		return err
	}

	// Stuck-record recovery runs ALWAYS, even with the timer off.
	recoverStuck(app)

	if !settings.GetBool("enabled") {
		return nil
	}

	now := time.Now()
	next := settings.GetDateTime("next_publish_at").Time()
	if next.IsZero() {
		next = now
	}
	if now.Before(next) {
		return nil
	}

	cand, err := pickCandidate(app)
	if err != nil {
		return err
	}
	if cand == nil {
		return nil
	}

	cand.Set("state", "publishing")
	cand.Set("locked_until", now.Add(pqLockMinutes*time.Minute))
	cand.Set("locked_by", "cron")
	if err := app.Save(cand); err != nil {
		return fmt.Errorf("lock candidate %s: %w", cand.Id, err)
	}

	gameID, perr := publishOne(app, cand, settings)
	if perr != nil {
		handlePublishFailure(app, cand, perr)
	} else {
		cand.Set("state", "published")
		cand.Set("game", gameID)
		cand.Set("error", "")
		cand.Set("locked_until", nil)
		cand.Set("locked_by", "")
		clearQueueFiles(cand)
		if err := app.Save(cand); err != nil {
			app.Logger().Error("publish: failed to finalize queue record", "id", cand.Id, "error", err.Error())
		} else {
			app.Logger().Info("published game from queue", "queue_id", cand.Id, "game_id", gameID, "mode", cand.GetString("publish_mode"))
		}
	}

	// Re-arm regardless of outcome so one broken row isn't retried every minute.
	armNext(app, settings, now)
	return nil
}

func loadSettings(app core.App) (*core.Record, error) {
	recs, err := app.FindRecordsByFilter(pqSettingsCol, "", "", 1, 0)
	if err != nil {
		return nil, fmt.Errorf("load %s: %w", pqSettingsCol, err)
	}
	if len(recs) == 0 {
		return nil, fmt.Errorf("%s singleton missing", pqSettingsCol)
	}
	return recs[0], nil
}

// Community suggestions (/add-next, submitted_by != "") first, FIFO — people wait for "their" game.
// Rest: random approved row (NSFW/SFW balance follows from proportions).
func pickCandidate(app core.App) (*core.Record, error) {
	community, err := app.FindRecordsByFilter(
		pqQueueCol,
		"state = 'approved' && publish_mode != 'skip' && submitted_by != ''",
		"created", 1, 0,
	)
	if err == nil && len(community) > 0 {
		return community[0], nil
	}
	recs, err := app.FindRecordsByFilter(
		pqQueueCol,
		"state = 'approved' && publish_mode != 'skip'",
		"", 200, 0,
	)
	if err != nil {
		return nil, fmt.Errorf("pick candidate: %w", err)
	}
	ready := recs[:0]
	for _, r := range recs {
		if !modUploadAwaitingCheck(r) {
			ready = append(ready, r)
		}
	}
	if len(ready) == 0 {
		return nil, nil
	}
	return ready[rand.Intn(len(ready))], nil
}

// Cards submitted by a moderator through Mod Tools (data.mod_upload) wait in the queue until a
// second moderator marks them checked; the timer skips them until then.
func modUploadInfo(q *core.Record) map[string]any {
	data := recordJSONMap(q, "data")
	mu, _ := data["mod_upload"].(map[string]any)
	return mu
}

func modUploadAwaitingCheck(q *core.Record) bool {
	mu := modUploadInfo(q)
	if mu == nil {
		return false
	}
	checked, _ := mu["checked"].(bool)
	return !checked
}

func publishOne(app core.App, q *core.Record, settings *core.Record) (string, error) {
	mode := q.GetString("publish_mode")
	if mode == "" {
		mode = "create"
	}

	gamesCol, err := app.FindCollectionByNameOrId(pqGamesCol)
	if err != nil {
		return "", err
	}

	var rec *core.Record
	isUpdate := mode == "update"

	// Legacy guard: a create-mode (or empty) row already linked to a catalog record (q.game) is an
	// UPDATE. Otherwise create would duplicate it under the queue id. Affects rows from before s06b
	// publish_mode stamping.
	if !isUpdate {
		if target := q.GetString("game"); target != "" {
			if g, _ := app.FindRecordById(pqGamesCol, target); g != nil {
				isUpdate = true
				rec = g
			}
		}
	}

	if isUpdate {
		if rec == nil {
			target := q.GetString("game")
			if target == "" {
				return "", fmt.Errorf("publish_mode=update but queue.game is empty")
			}
			rec, err = app.FindRecordById(pqGamesCol, target)
			if err != nil {
				return "", fmt.Errorf("update target %s not found: %w", target, err)
			}
		}
	} else {
		// create: deterministic id = queue row id (§6, idempotency) — a retry updates in place.
		existing, _ := app.FindRecordById(pqGamesCol, q.Id)
		if existing != nil {
			rec = existing
		} else {
			rec = core.NewRecord(gamesCol)
			rec.Id = q.Id
		}
	}

	for qf, gf := range pqScalarMap {
		rec.Set(gf, q.Get(qf))
	}
	// rich_description NOT in pqScalarMap (which sets unconditionally): an update with empty staging
	// would wipe the catalog's backfilled description.
	if rd := q.GetString("rich_description"); rd != "" {
		rec.Set("rich_description", rd)
	}
	// aliases the same way: a moderator may have typed aliases on the card; an unconditional Set would
	// blank them on republish.
	if al := q.GetString("aliases"); al != "" {
		rec.Set("aliases", al)
	}
	orig := q.GetString("source_url")
	if orig == "" {
		orig = q.GetString("original_url")
	}
	rec.Set("original_link", orig)
	// original_release is a bool field (not a tag): frontend pins and badges "New" by original_release
	// && created within N days (SearchPage/GameCard).
	rec.Set("original_release", q.GetBool("original"))
	rec.Set("tags", q.GetStringSlice("tags"))
	rec.Set("authors", q.GetStringSlice("authors"))
	if !isUpdate {
		rec.Set("uploader", settings.GetString("publish_uploader"))
	}

	fsys, err := app.NewFilesystem()
	if err != nil {
		return "", err
	}
	defer fsys.Close()

	for _, field := range pqFileFields {
		names := q.GetStringSlice(field)
		if len(names) == 0 {
			continue
		}
		files, err := copyFiles(fsys, q, names)
		if err != nil {
			return "", fmt.Errorf("copy %s: %w", field, err)
		}
		rec.Set(field, files)
	}

	if err := app.Save(rec); err != nil {
		return "", fmt.Errorf("save games record: %w", err)
	}
	return rec.Id, nil
}

func copyFiles(fsys *filesystem.System, q *core.Record, names []string) ([]*filesystem.File, error) {
	base := q.BaseFilesPath()
	out := make([]*filesystem.File, 0, len(names))
	for _, name := range names {
		key := base + "/" + name
		reader, err := fsys.GetFile(key)
		if err != nil {
			return nil, fmt.Errorf("get %s: %w", key, err)
		}
		b, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", key, err)
		}
		f, err := filesystem.NewFileFromBytes(b, name)
		if err != nil {
			return nil, fmt.Errorf("wrap %s: %w", key, err)
		}
		out = append(out, f)
	}
	return out, nil
}

func handlePublishFailure(app core.App, q *core.Record, perr error) {
	attempts := q.GetInt("attempts") + 1
	q.Set("attempts", attempts)
	q.Set("error", perr.Error())
	q.Set("locked_until", nil)
	q.Set("locked_by", "")
	if attempts >= pqMaxAttempts {
		q.Set("state", "publish_failed")
		app.Logger().Error("publish failed permanently", "queue_id", q.Id, "attempts", attempts, "error", perr.Error())
	} else {
		q.Set("state", "approved")
		app.Logger().Warn("publish failed, will retry", "queue_id", q.Id, "attempts", attempts, "error", perr.Error())
	}
	if err := app.Save(q); err != nil {
		app.Logger().Error("publish: failed to record failure", "id", q.Id, "error", err.Error())
	}
}

// publishing rows past locked_until: games record exists → published; else back to approved.
func recoverStuck(app core.App) {
	now := time.Now()
	recs, err := app.FindRecordsByFilter(
		pqQueueCol,
		"state = 'publishing' && locked_until != '' && locked_until < {:now}",
		"", 100, 0,
		map[string]any{"now": now},
	)
	if err != nil || len(recs) == 0 {
		return
	}
	for _, q := range recs {
		target := q.Id
		if q.GetString("publish_mode") == "update" {
			target = q.GetString("game")
		}
		found := false
		if target != "" {
			if g, _ := app.FindRecordById(pqGamesCol, target); g != nil {
				found = true
				q.Set("game", g.Id)
			}
		}
		q.Set("locked_until", nil)
		q.Set("locked_by", "")
		if found {
			q.Set("state", "published")
			clearQueueFiles(q)
		} else {
			q.Set("state", "approved")
		}
		if err := app.Save(q); err != nil {
			app.Logger().Error("recover stuck: save failed", "id", q.Id, "error", err.Error())
			continue
		}
		app.Logger().Info("recovered stuck publishing record", "queue_id", q.Id, "recovered_as", q.GetString("state"))
	}
}

func armNext(app core.App, settings *core.Record, now time.Time) {
	interval := settings.GetInt("interval_minutes")
	if interval <= 0 {
		interval = 120
	}
	jitter := settings.GetInt("jitter_minutes")
	delta := 0
	if jitter > 0 {
		delta = rand.Intn(2*jitter+1) - jitter
	}
	mins := interval + delta
	if mins < 1 {
		mins = 1
	}
	settings.Set("next_publish_at", now.Add(time.Duration(mins)*time.Minute))
	settings.Set("last_published_at", now)
	if err := app.Save(settings); err != nil {
		app.Logger().Error("arm next: save settings failed", "error", err.Error())
	}
}

func clearQueueFiles(q *core.Record) {
	for _, field := range pqFileFields {
		q.Set(field, nil)
	}
}
