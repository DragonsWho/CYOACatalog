// publication_queue.go
//
// Drip-feed публикация: сервер сам по таймеру переносит одну одобренную запись из
// очереди (game_pipeline_state, state=approved) в каталог (games), независимо от
// ноута. Вердикт дедупа (publish_mode) уже запечён на стадии обработки — крон лишь
// исполняет его + дешёвый exact-чек, файлы копирует через core.Filesystem (работает
// и с локальным диском, и с R2).
//
// Спека: site-frontend-backend/Documentation/publication_pipeline_architecture.md
//        PB/schema_changes_publication_queue.md (§3,§6,§7)

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
	pqLockMinutes = 10 // через сколько «зависшая» publishing-запись считается брошенной
	pqMaxAttempts = 5  // после стольких неудач → publish_failed (ждёт человека)
)

// Файловые поля, зеркалящие games. Копируются queue → games.
var pqFileFields = []string{"image", "cyoa_pages", "cyoa_pages_preview"}

// Простые (не-файловые) публикуемые поля: queueField -> gamesField.
// uploader НЕ здесь — он ставится только при create (см. §7, при update не трогаем).
var pqScalarMap = map[string]string{
	"title":        "title",
	"description":  "description",
	"image_base64": "image_base64",
	"img_or_link":  "img_or_link",
	"hosted_url":   "iframe_url",
	"release_date": "release_date",
}

// registerPublicationQueue вешает крон-тик раз в минуту. Сам тик решает, наступило
// ли время публиковать (по publication_settings.next_publish_at).
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

	// 1) Восстановление брошенных publishing-записей делаем ВСЕГДА (даже при выкл. таймере).
	recoverStuck(app)

	if !settings.GetBool("enabled") {
		return nil
	}

	now := time.Now()
	next := settings.GetDateTime("next_publish_at").Time()
	if next.IsZero() {
		// первый запуск с включённым таймером — взводим, публикуем сразу.
		next = now
	}
	if now.Before(next) {
		return nil // ещё не время
	}

	// 2) Кандидат: случайная approved-запись (баланс NSFW/SFW соблюдается долей сам).
	cand, err := pickCandidate(app)
	if err != nil {
		return err
	}
	if cand == nil {
		// очередь пуста — не двигаем таймер агрессивно, проверим через минуту снова.
		return nil
	}

	// 3) Лок: переводим в publishing.
	cand.Set("state", "publishing")
	cand.Set("locked_until", now.Add(pqLockMinutes*time.Minute))
	cand.Set("locked_by", "cron")
	if err := app.Save(cand); err != nil {
		return fmt.Errorf("lock candidate %s: %w", cand.Id, err)
	}

	// 4) Публикация.
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

	// 5) Перевзвести таймер (двигаем независимо от исхода, чтобы не долбить один битый).
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

// pickCandidate — кого публиковать следующим. Приоритет у community-предложений
// (/add-next, submitted_by != ""): их FIFO, люди ждут «свою» игру. Остальной
// бэклог — случайная approved-запись (баланс NSFW/SFW соблюдается долей сам).
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
	if len(recs) == 0 {
		return nil, nil
	}
	return recs[rand.Intn(len(recs))], nil
}

// publishOne создаёт или обновляет запись games. Возвращает id games.
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

	// Легаси-страховка: строка с режимом create (или пустым → create), которая уже
	// связана с существующей записью каталога (q.game), — это НЕ новая игра, а апдейт.
	// Без этого create сделал бы дубль под id очереди (≠ id каталога). Касается строк
	// до s06b-стампинга publish_mode (напр. старые approved, уже опубликованные).
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
		// create: детерминированный id = id записи очереди (§6, идемпотентность).
		existing, _ := app.FindRecordById(pqGamesCol, q.Id)
		if existing != nil {
			rec = existing // повторный тик/ретрай — апдейтим на месте, дубля нет
		} else {
			rec = core.NewRecord(gamesCol)
			rec.Id = q.Id
		}
	}

	// скалярные поля
	for qf, gf := range pqScalarMap {
		rec.Set(gf, q.Get(qf))
	}
	// rich_description (hidden, семантический поиск): НЕ в pqScalarMap — тот сетит
	// безусловно, а update с пустым стейджингом затёр бы backfill-описание каталога.
	if rd := q.GetString("rich_description"); rd != "" {
		rec.Set("rich_description", rd)
	}
	// original_link: source_url приоритетнее original_url
	orig := q.GetString("source_url")
	if orig == "" {
		orig = q.GetString("original_url")
	}
	rec.Set("original_link", orig)
	// «свежий авторский релиз» — булев флаг (не тег): фронт закрепляет и рисует
	// бейдж «New» по original_release && created within N дней (см. SearchPage/
	// GameCard). Раньше сигнал ехал тегом Original; теперь чистое поле.
	rec.Set("original_release", q.GetBool("original"))
	// relations
	rec.Set("tags", q.GetStringSlice("tags"))
	rec.Set("authors", q.GetStringSlice("authors"))
	// uploader — ТОЛЬКО при create (§7: при update не трогаем)
	if !isUpdate {
		rec.Set("uploader", settings.GetString("publish_uploader"))
	}

	// файлы: копируем из стораджа очереди в games через core.Filesystem
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

// copyFiles читает файлы записи очереди из текущего стораджа (диск или R2) и
// оборачивает в filesystem.File для последующей записи на games при Save.
func copyFiles(fsys *filesystem.System, q *core.Record, names []string) ([]*filesystem.File, error) {
	base := q.BaseFilesPath() // "<collectionId>/<recordId>"
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
		q.Set("state", "approved") // вернём в очередь на ретрай
		app.Logger().Warn("publish failed, will retry", "queue_id", q.Id, "attempts", attempts, "error", perr.Error())
	}
	if err := app.Save(q); err != nil {
		app.Logger().Error("publish: failed to record failure", "id", q.Id, "error", err.Error())
	}
}

// recoverStuck — записи в publishing с истёкшим locked_until: смотрим, доехала ли
// games-запись. Доехала → published; нет → обратно в approved.
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
		// для create целевой id = q.id; для update — q.game
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

// armNext выставляет next_publish_at = now + interval ± jitter и last_published_at.
func armNext(app core.App, settings *core.Record, now time.Time) {
	interval := settings.GetInt("interval_minutes")
	if interval <= 0 {
		interval = 120
	}
	jitter := settings.GetInt("jitter_minutes")
	delta := 0
	if jitter > 0 {
		delta = rand.Intn(2*jitter+1) - jitter // [-jitter, +jitter]
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
