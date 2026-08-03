package main

// Game card edits, bumps and soft-hide — the user-facing write path for `games`.
//
// games.updateRule is moderator-only, so these endpoints are the ONLY way a
// regular user (the game's uploader) can change a card. Every mutation:
//   1. records an append-only revision in `game_revisions` (old values of the
//      changed fields only), and
//   2. archives any storage files it would displace under
//      revisions/<gameId>/<revisionId>/<filename> (PocketBase deletes replaced
//      record files from storage, and R2 has no bucket versioning — the archive
//      copy is the only thing that makes file edits reversible).
// Nothing here ever hard-deletes: "delete" is hidden=true, and a revert is just
// another revision. See PB/schema_changes_edits_bumps.md for the full design.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	bumpCooldown  = 14 * 24 * time.Hour
	editRateMax   = 30 // revisions per editor per rolling 24h
	maxTitleLen   = 300
	maxAliasesLen = 2000 // альт-названия скопом: ~десяток строк с запасом
	maxNoteLen    = 1000
	maxDescLen    = 200_000
	maxLinkLen    = 1000
	// Потолок blur-плейсхолдера = лимит текстового поля games.image_base64 в PB
	// (5000 → 20000, см. PB/bump_image_base64_max.py). Раньше тут было 64 КБ —
	// сильно шире схемы, поэтому «шумная» обложка проходила гард и валилась
	// уже на save с сырой ошибкой валидации PB.
	maxBase64Len  = 20000
	revisionsColl = "game_revisions"

	// Сколько от формы редактирования держать в памяти; остальное — во временные
	// файлы. Обложка укладывается в единицы мегабайт, страницы статики читаются
	// лениво, так что 8 МБ хватает и потолок памяти на запрос теперь известен.
	editFormMemory = 8 << 20
	// Общий потолок на тело запроса. Совпадает со старым аргументом
	// ParseMultipartForm, чтобы ничего работавшего не сломать, но теперь это
	// настоящий лимит на принятые байты, а не на буфер в RAM.
	maxEditFormBytes = 256 << 20
)

// Fields the uploader may edit. Moderators additionally get modOnlyEditable.
// Content-swap fields (iframe_url, files) stay out of the uploader set on
// purpose: replacing the playable game itself must not be a silent self-serve
// action (hosted-game versions go through the hosting upload, which never
// deletes old prefixes).
var ownerEditable = map[string]bool{
	"title": true, "description": true, "release_date": true,
	"original_link": true,
}
// `aliases` (альт-названия, по одному в строке) — модерский рычаг: поле
// участвует в поиске (title ~ q || aliases ~ q), поэтому владелец игры не
// должен уметь подтягивать чужие запросы на свою карточку.
var modOnlyEditable = map[string]bool{
	"iframe_url": true, "img_or_link": true, "aliases": true,
}

// Альт-названия хранятся строками через \n. Нормализуем то, что пришло из
// формы/скрипта: режем по переводам строк, трим, выкидываем пустые и повторы
// (без учёта регистра). Запятые НЕ разделители — в названиях они обычны.
func normalizeAliases(s string) string {
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		v := strings.TrimSpace(line)
		if v == "" {
			continue
		}
		k := strings.ToLower(v)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, v)
	}
	return strings.Join(out, "\n")
}

func isSuperuser(c *core.RequestEvent) bool {
	return c.Auth != nil && c.Auth.Collection().Name == core.CollectionNameSuperusers
}

func isModOrSuper(c *core.RequestEvent) bool {
	return isSuperuser(c) || (c.Auth != nil && c.Auth.GetBool("isModerator"))
}

func canManageGame(c *core.RequestEvent, game *core.Record) bool {
	if isModOrSuper(c) {
		return true
	}
	up := game.GetString("uploader")
	return up != "" && up == c.Auth.Id
}

// actorKind classifies the caller for the revision journal. Superuser tokens
// are only ever held by our own automation (night watcher etc.), hence "agent".
func actorKind(c *core.RequestEvent) string {
	switch {
	case isSuperuser(c):
		return "agent"
	case c.Auth.GetBool("isModerator"):
		return "moderator"
	default:
		return "user"
	}
}

func revisionArchivePrefix(gameID, revisionID string) string {
	return "revisions/" + gameID + "/" + revisionID
}

// archiveGameFiles copies the named record files into the revision's archive
// prefix (server-side copy inside the PB storage bucket). Returns the archive
// keys. Must run BEFORE the record save that displaces the files.
func archiveGameFiles(app core.App, game *core.Record, revisionID string, filenames []string) ([]string, error) {
	if len(filenames) == 0 {
		return nil, nil
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return nil, fmt.Errorf("filesystem: %w", err)
	}
	defer fsys.Close()

	keys := make([]string, 0, len(filenames))
	for _, name := range filenames {
		if name == "" {
			continue
		}
		src := game.BaseFilesPath() + "/" + name
		dst := revisionArchivePrefix(game.Id, revisionID) + "/" + name
		if err := fsys.Copy(src, dst); err != nil {
			return nil, fmt.Errorf("archive %s: %w", name, err)
		}
		keys = append(keys, dst)
	}
	return keys, nil
}

// newRevision builds (but does not save) a game_revisions record with a
// pre-generated id, so file archiving can use the id before the DB write.
func newRevision(app core.App, game *core.Record, c *core.RequestEvent, action string, changed map[string]any, note string) (*core.Record, error) {
	coll, err := app.FindCollectionByNameOrId(revisionsColl)
	if err != nil {
		return nil, fmt.Errorf("find %s: %w", revisionsColl, err)
	}
	rev := core.NewRecord(coll)
	rev.Id = core.GenerateDefaultRandomId()
	rev.Set("game", game.Id)
	if !isSuperuser(c) {
		rev.Set("editor", c.Auth.Id)
	}
	rev.Set("actor_kind", actorKind(c))
	rev.Set("action", action)
	rev.Set("changed", changed)
	rev.Set("note", note)
	return rev, nil
}

// editRateExceeded counts the caller's revisions over the last 24h.
func editRateExceeded(app core.App, editorID string) bool {
	since := time.Now().UTC().Add(-24 * time.Hour).Format("2006-01-02 15:04:05.000Z")
	recent, err := app.FindRecordsByFilter(
		revisionsColl, "editor = {:editor} && created >= {:since}", "", 0, 0,
		dbx.Params{"editor": editorID, "since": since},
	)
	return err == nil && len(recent) >= editRateMax
}

// purgeGamePage drops the edge-cached HTML shell of a single game page
// (best-effort, async — an edit must not fail on a CF hiccup).
func purgeGamePage(app core.App, gameID string) {
	go func() {
		if err := purgeCFURLs([]string{siteURL + "/game/" + gameID}); err != nil {
			app.Logger().Warn("game page purge failed", "game", gameID, "error", err.Error())
		}
	}()
}

func registerGameEdits(app *pocketbase.PocketBase) {
	// The catalog's "new" sort is `-bumped_at,-created`, so every game needs a
	// bumped_at from birth (existing records are backfilled by
	// PB/backfill_bumped_at.py) — otherwise unbumped games would sink below
	// every bumped one.
	app.OnRecordCreate("games").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetDateTime("bumped_at").IsZero() {
			e.Record.Set("bumped_at", types.NowDateTime())
		}
		// Mint a pretty-URL slug from the title when none was set explicitly. Runs
		// for every creation path (add form, nightly pipeline, admin). Collisions
		// get a numeric suffix so the unique index never rejects the insert; a
		// non-Latin title yields no slug and the game stays addressable by id.
		if strings.TrimSpace(e.Record.GetString("slug")) == "" {
			if base := slugifyGame(e.Record.GetString("title")); base != "" {
				e.Record.Set("slug", uniqueGameSlug(app, base, e.Record.Id))
			}
		}
		return e.Next()
	})

	// The same rule on the way back out: a title change refreshes the slug on
	// EVERY write path, not just /api/custom/games/{id}/edit. Titles also get
	// fixed from the admin UI, by the nightly pipeline and by PB/ scripts — those
	// left the old slug in place, so the catalog kept linking a game named X to
	// /game/<old-name>. It still resolved (alias redirect), but it read like a bug.
	// The old slug is retired as an alias here too, so shared links keep working.
	app.OnRecordUpdate("games").BindFunc(func(e *core.RecordEvent) error {
		old := e.Record.Original()
		if old == nil || e.Record.GetString("title") == old.GetString("title") {
			return e.Next()
		}
		// A slug set explicitly in this same write wins over the derived one: that
		// is a revert restoring {title, slug} together, or a deliberate override.
		if e.Record.GetString("slug") != old.GetString("slug") {
			return e.Next()
		}
		// e.App, not app — alias writes must join the caller's transaction.
		applyGameSlugRename(e.App, e.Record, map[string]any{})
		return e.Next()
	})

	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		g := e.Router.Group("/api/custom")

		// ── PATCH-style edit (multipart: `payload` JSON + optional image /
		// cyoa_pages file parts) ─────────────────────────────────────────────
		type editPayload struct {
			Title         *string   `json:"title"`
			Description   *string   `json:"description"`
			ReleaseDate   *string   `json:"release_date"`
			OriginalLink  *string   `json:"original_link"`
			IframeURL     *string   `json:"iframe_url"`      // mod-only
			ImgOrLink     *string   `json:"img_or_link"`     // mod-only
			Aliases       *string   `json:"aliases"`         // mod-only: альт-названия, по одному в строке
			ImageBase64   *string   `json:"image_base64"`    // blur-up preview, client-computed like CreateGame
			CyoaPagesKeep *[]string `json:"cyoa_pages_keep"` // existing filenames to keep (ordered); nil = keep all
		}
		g.POST("/games/{id}/edit", func(c *core.RequestEvent) error {
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			if !canManageGame(c, game) {
				return apis.NewForbiddenError("Only the game's uploader or a moderator can edit it", nil)
			}
			if !isModOrSuper(c) && editRateExceeded(app, c.Auth.Id) {
				return apis.NewApiError(http.StatusTooManyRequests,
					"Too many edits today. Please try again tomorrow.", nil)
			}

			// Первый аргумент ParseMultipartForm — это НЕ лимит загрузки, а сколько
			// держать в ПАМЯТИ; что не влезло, уходит во временные файлы на диске.
			// Стояло 256 МБ, то есть одна форма могла занять четверть гигабайта RAM
			// на коробке с 961 МБ. Дальше filesystem.NewFileFromMultipart читает
			// части лениво, так что дисковый разлив ничего не ломает: меняется
			// только место, где лежат байты.
			c.Request.Body = http.MaxBytesReader(c.Response, c.Request.Body, maxEditFormBytes)
			if err := c.Request.ParseMultipartForm(editFormMemory); err != nil {
				return c.BadRequestError("Invalid multipart form", err)
			}
			payload := new(editPayload)
			if raw := c.Request.FormValue("payload"); raw != "" {
				if err := json.Unmarshal([]byte(raw), payload); err != nil {
					return c.BadRequestError("Invalid payload JSON", err)
				}
			}

			changed := map[string]any{} // field -> OLD value (the revision body)

			// Scalar fields.
			type scalarEdit struct {
				val     *string
				field   string
				maxLen  int
				modOnly bool
			}
			scalars := []scalarEdit{
				{payload.Title, "title", maxTitleLen, false},
				{payload.Description, "description", maxDescLen, false},
				{payload.ReleaseDate, "release_date", 64, false},
				{payload.OriginalLink, "original_link", maxLinkLen, false},
				{payload.IframeURL, "iframe_url", maxLinkLen, true},
				{payload.ImgOrLink, "img_or_link", 8, true},
				{payload.Aliases, "aliases", maxAliasesLen, true},
			}
			for _, s := range scalars {
				if s.val == nil {
					continue
				}
				if s.modOnly && !isModOrSuper(c) {
					return apis.NewForbiddenError("Field "+s.field+" is moderator-only", nil)
				}
				v := strings.TrimSpace(*s.val)
				if s.field == "aliases" {
					v = normalizeAliases(v)
				}
				if len(v) > s.maxLen {
					return c.BadRequestError("Field "+s.field+" is too long", nil)
				}
				if s.field == "title" && v == "" {
					return c.BadRequestError("Title cannot be empty", nil)
				}
				if s.field == "img_or_link" && v != "img" && v != "link" {
					return c.BadRequestError("img_or_link must be 'img' or 'link'", nil)
				}
				if v != game.GetString(s.field) {
					changed[s.field] = game.GetString(s.field)
					game.Set(s.field, v)
				}
			}

			// A title change refreshes the pretty slug; the old slug is preserved
			// as a redirect alias so links shared before the rename keep resolving.
			if _, titleChanged := changed["title"]; titleChanged {
				applyGameSlugRename(app, game, changed)
			}

			// Cover image replacement (+ its client-computed blur placeholder).
			var newImage *filesystem.File
			if fhs := c.Request.MultipartForm.File["image"]; len(fhs) > 0 {
				f, err := filesystem.NewFileFromMultipart(fhs[0])
				if err != nil {
					return c.BadRequestError("Invalid image upload", err)
				}
				newImage = f
				changed["image"] = game.GetString("image")
			}
			if payload.ImageBase64 != nil {
				v := *payload.ImageBase64
				if len(v) > maxBase64Len {
					// Не валим правку из-за косметики: клиент (blurPlaceholder.ts)
					// уже жмёт под лимит, а старый закешированный бандл мог прислать
					// длиннее. Пустая строка = карточка без blur-up, зато без
					// рассинхрона со свежей обложкой и без падения всей правки.
					v = ""
				}
				if v != game.GetString("image_base64") {
					changed["image_base64"] = game.GetString("image_base64")
					game.Set("image_base64", v)
				}
			}

			// Static pages: `cyoa_pages_keep` = ordered subset of existing
			// filenames to retain; any uploaded `cyoa_pages` parts are appended.
			oldPages := game.GetStringSlice("cyoa_pages")
			var newPageFiles []*filesystem.File
			for _, fh := range c.Request.MultipartForm.File["cyoa_pages"] {
				f, err := filesystem.NewFileFromMultipart(fh)
				if err != nil {
					return c.BadRequestError("Invalid page upload", err)
				}
				newPageFiles = append(newPageFiles, f)
			}
			var removedPages []string
			pagesTouched := payload.CyoaPagesKeep != nil || len(newPageFiles) > 0
			if pagesTouched {
				keep := oldPages
				if payload.CyoaPagesKeep != nil {
					oldSet := map[string]bool{}
					for _, n := range oldPages {
						oldSet[n] = true
					}
					keep = nil
					for _, n := range *payload.CyoaPagesKeep {
						if !oldSet[n] {
							return c.BadRequestError("cyoa_pages_keep contains unknown file: "+n, nil)
						}
						keep = append(keep, n)
					}
					keepSet := map[string]bool{}
					for _, n := range keep {
						keepSet[n] = true
					}
					for _, n := range oldPages {
						if !keepSet[n] {
							removedPages = append(removedPages, n)
						}
					}
				}
				if len(keep) == 0 && len(newPageFiles) == 0 && game.GetString("img_or_link") == "img" {
					return c.BadRequestError("An image game must keep at least one page", nil)
				}
				vals := make([]any, 0, len(keep)+len(newPageFiles))
				for _, n := range keep {
					vals = append(vals, n)
				}
				for _, f := range newPageFiles {
					vals = append(vals, f)
				}
				if len(removedPages) > 0 || len(newPageFiles) > 0 {
					changed["cyoa_pages"] = oldPages
					game.Set("cyoa_pages", vals)
				}
			}

			if len(changed) == 0 {
				return c.JSON(http.StatusOK, map[string]any{"success": true, "changed": []string{}})
			}

			rev, err := newRevision(app, game, c, "edit", changed, strings.TrimSpace(c.Request.FormValue("note")))
			if err != nil {
				return c.InternalServerError("Failed to prepare revision", err)
			}

			// Archive displaced files BEFORE the save deletes them from storage.
			var toArchive []string
			if newImage != nil && game.GetString("image") != "" {
				toArchive = append(toArchive, game.GetString("image"))
			}
			toArchive = append(toArchive, removedPages...)
			archived, err := archiveGameFiles(app, game, rev.Id, toArchive)
			if err != nil {
				return c.InternalServerError("Failed to archive replaced files", err)
			}
			rev.Set("files_archived", archived)

			if newImage != nil {
				game.Set("image", newImage)
			}

			err = app.RunInTransaction(func(txApp core.App) error {
				if err := txApp.Save(rev); err != nil {
					return fmt.Errorf("save revision: %w", err)
				}
				if err := txApp.Save(game); err != nil {
					return fmt.Errorf("save game: %w", err)
				}
				return nil
			})
			if err != nil {
				return c.InternalServerError("Failed to save edit", err)
			}

			// Title/description/image feed the catalog cards and the game page shell.
			catalogPurge.trigger(app)
			purgeGamePage(app, game.Id)

			fields := make([]string, 0, len(changed))
			for f := range changed {
				fields = append(fields, f)
			}
			return c.JSON(http.StatusOK, map[string]any{
				"success": true, "changed": fields, "revision": rev.Id,
			})
		}).Bind(apis.RequireAuth())

		// ── Bump ─────────────────────────────────────────────────────────────
		type bumpPayload struct {
			Note string `json:"note"`
		}
		g.POST("/games/{id}/bump", func(c *core.RequestEvent) error {
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			if !canManageGame(c, game) {
				return apis.NewForbiddenError("Only the game's uploader or a moderator can bump it", nil)
			}
			payload := new(bumpPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			note := strings.TrimSpace(payload.Note)
			if note == "" {
				return c.BadRequestError("A bump requires a note describing what changed", nil)
			}
			if len(note) > maxNoteLen {
				return c.BadRequestError("Note is too long", nil)
			}

			// Cooldown for owners; moderators can always bump. The rejection
			// carries next_bump_at so the UI can show WHEN instead of a bare no.
			prev := game.GetDateTime("bumped_at")
			if !isModOrSuper(c) && !prev.IsZero() {
				next := prev.Time().Add(bumpCooldown)
				if time.Now().UTC().Before(next) {
					return c.JSON(http.StatusTooManyRequests, map[string]any{
						"error":        "Bump is on cooldown",
						"next_bump_at": next.UTC().Format(time.RFC3339),
					})
				}
			}

			now := types.NowDateTime()
			rev, err := newRevision(app, game, c, "bump",
				map[string]any{"bumped_at": game.GetString("bumped_at")}, note)
			if err != nil {
				return c.InternalServerError("Failed to prepare revision", err)
			}

			displayName := c.Auth.GetString("name")
			if displayName == "" {
				displayName = c.Auth.GetString("username")
			}
			entry := fmt.Sprintf("**%s** (%s): %s",
				now.Time().Format("2006-01-02"), displayName, note)

			err = app.RunInTransaction(func(txApp core.App) error {
				game.Set("bumped_at", now)
				if err := txApp.Save(game); err != nil {
					return fmt.Errorf("save game: %w", err)
				}
				if err := txApp.Save(rev); err != nil {
					return fmt.Errorf("save revision: %w", err)
				}

				// One pinned changelog comment per game; new entries on top.
				logs, _ := txApp.FindRecordsByFilter(
					"comments", "game = {:game} && kind = 'changelog'", "", 1, 0,
					dbx.Params{"game": game.Id},
				)
				if len(logs) > 0 {
					logRec := logs[0]
					logRec.Set("content", entry+"\n\n"+logRec.GetString("content"))
					logRec.Set("pinned", true)
					return txApp.Save(logRec)
				}
				commentsColl, err := txApp.FindCollectionByNameOrId("comments")
				if err != nil {
					return err
				}
				logRec := core.NewRecord(commentsColl)
				logRec.Set("content", entry)
				logRec.Set("author", c.Auth.Id)
				logRec.Set("game", game.Id)
				logRec.Set("kind", "changelog")
				logRec.Set("pinned", true)
				if err := txApp.Save(logRec); err != nil {
					return fmt.Errorf("save changelog comment: %w", err)
				}
				// Same bookkeeping as /api/custom/comments (top-level comment).
				game.Set("comments+", logRec.Id)
				total, cerr := txApp.FindRecordsByFilter(
					"comments", "game = {:game}", "", 0, 0, dbx.Params{"game": game.Id},
				)
				if cerr == nil {
					game.Set("comments_count", len(total))
				}
				return txApp.Save(game)
			})
			if err != nil {
				return c.InternalServerError("Failed to bump", err)
			}

			catalogPurge.trigger(app) // bump reorders the home page
			purgeGamePage(app, game.Id)

			return c.JSON(http.StatusOK, map[string]any{
				"success":      true,
				"bumped_at":    now.Time().UTC().Format(time.RFC3339),
				"next_bump_at": now.Time().Add(bumpCooldown).UTC().Format(time.RFC3339),
			})
		}).Bind(apis.RequireAuth())

		// ── Soft-hide ("delete" that never deletes) ──────────────────────────
		// Uploaders get a 1-hour window after creation (accidental uploads);
		// moderators can hide any time. Reverting is a normal revision revert.
		g.POST("/games/{id}/hide", func(c *core.RequestEvent) error {
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			if !canManageGame(c, game) {
				return apis.NewForbiddenError("Only the game's uploader or a moderator can hide it", nil)
			}
			if !isModOrSuper(c) {
				age := time.Since(game.GetDateTime("created").Time())
				if age > time.Hour {
					return apis.NewForbiddenError(
						"The self-delete window (1 hour) has passed — ask a moderator via @moderator", nil)
				}
			}
			if game.GetBool("hidden") {
				return c.JSON(http.StatusOK, map[string]any{"success": true, "hidden": true})
			}

			rev, err := newRevision(app, game, c, "hide",
				map[string]any{"hidden": false}, "")
			if err != nil {
				return c.InternalServerError("Failed to prepare revision", err)
			}
			game.Set("hidden", true)
			err = app.RunInTransaction(func(txApp core.App) error {
				if err := txApp.Save(rev); err != nil {
					return err
				}
				return txApp.Save(game)
			})
			if err != nil {
				return c.InternalServerError("Failed to hide game", err)
			}
			catalogPurge.trigger(app)
			purgeGamePage(app, game.Id)
			return c.JSON(http.StatusOK, map[string]any{"success": true, "hidden": true})
		}).Bind(apis.RequireAuth())

		// ── Revert a revision (moderators + automation) ──────────────────────
		// Restores the old field values recorded in the revision, re-uploading
		// archived files where needed. The revert itself is a new revision (with
		// its own file archive), so even a wrong revert is reversible.
		type revertPayload struct {
			RevisionID string `json:"revision_id"`
			Note       string `json:"note"`
		}
		g.POST("/games/{id}/revert", func(c *core.RequestEvent) error {
			if !isModOrSuper(c) {
				return apis.NewForbiddenError("Only moderators can revert revisions", nil)
			}
			payload := new(revertPayload)
			if err := c.BindBody(payload); err != nil || payload.RevisionID == "" {
				return c.BadRequestError("Missing revision_id", err)
			}
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			srcRev, err := app.FindRecordById(revisionsColl, payload.RevisionID)
			if err != nil {
				return apis.NewNotFoundError("Revision not found", err)
			}
			if srcRev.GetString("game") != game.Id {
				return c.BadRequestError("Revision belongs to another game", nil)
			}

			var changed map[string]any
			if err := json.Unmarshal([]byte(srcRev.GetString("changed")), &changed); err != nil {
				return c.InternalServerError("Corrupt revision changed-set", err)
			}
			var srcArchived []string
			if raw := srcRev.GetString("files_archived"); raw != "" {
				_ = json.Unmarshal([]byte(raw), &srcArchived)
			}
			// filename -> archive key of the file displaced by the source revision
			archiveByName := map[string]string{}
			for _, key := range srcArchived {
				if i := strings.LastIndex(key, "/"); i >= 0 {
					archiveByName[key[i+1:]] = key
				}
			}

			revertChanged := map[string]any{} // current values, for the new revision
			var archiveNow []string           // current files displaced by the revert

			fsys, err := app.NewFilesystem()
			if err != nil {
				return c.InternalServerError("filesystem", err)
			}
			defer fsys.Close()

			for field, oldVal := range changed {
				switch field {
				case "image":
					oldName, _ := oldVal.(string)
					cur := game.GetString("image")
					if cur == oldName {
						continue
					}
					revertChanged["image"] = cur
					if cur != "" {
						archiveNow = append(archiveNow, cur)
					}
					if oldName == "" {
						game.Set("image", nil)
					} else if key, ok := archiveByName[oldName]; ok {
						f, ferr := fsys.GetReuploadableFile(key, true)
						if ferr != nil {
							return c.InternalServerError("Archived image missing: "+oldName, ferr)
						}
						game.Set("image", f)
					} else {
						// Old file was never displaced (still on the record's path).
						game.Set("image", oldName)
					}
				case "cyoa_pages":
					oldList := toStringSlice(oldVal)
					cur := game.GetStringSlice("cyoa_pages")
					curSet := map[string]bool{}
					for _, n := range cur {
						curSet[n] = true
					}
					oldSet := map[string]bool{}
					for _, n := range oldList {
						oldSet[n] = true
					}
					for _, n := range cur {
						if !oldSet[n] {
							archiveNow = append(archiveNow, n)
						}
					}
					revertChanged["cyoa_pages"] = cur
					vals := make([]any, 0, len(oldList))
					for _, n := range oldList {
						if curSet[n] {
							vals = append(vals, n)
							continue
						}
						key, ok := archiveByName[n]
						if !ok {
							return c.InternalServerError("No archive copy for page "+n, nil)
						}
						f, ferr := fsys.GetReuploadableFile(key, true)
						if ferr != nil {
							return c.InternalServerError("Archived page missing: "+n, ferr)
						}
						vals = append(vals, f)
					}
					game.Set("cyoa_pages", vals)
				default:
					cur := game.Get(field)
					revertChanged[field] = cur
					game.Set(field, oldVal)
				}
			}

			if len(revertChanged) == 0 {
				return c.JSON(http.StatusOK, map[string]any{"success": true, "changed": []string{}})
			}

			note := strings.TrimSpace(payload.Note)
			if note == "" {
				note = "revert of " + srcRev.Id
			}
			rev, err := newRevision(app, game, c, "revert", revertChanged, note)
			if err != nil {
				return c.InternalServerError("Failed to prepare revision", err)
			}
			archived, err := archiveGameFiles(app, game, rev.Id, archiveNow)
			if err != nil {
				return c.InternalServerError("Failed to archive current files", err)
			}
			rev.Set("files_archived", archived)

			err = app.RunInTransaction(func(txApp core.App) error {
				if err := txApp.Save(rev); err != nil {
					return err
				}
				return txApp.Save(game)
			})
			if err != nil {
				return c.InternalServerError("Failed to revert", err)
			}

			catalogPurge.trigger(app)
			purgeGamePage(app, game.Id)

			fields := make([]string, 0, len(revertChanged))
			for f := range revertChanged {
				fields = append(fields, f)
			}
			return c.JSON(http.StatusOK, map[string]any{
				"success": true, "changed": fields, "revision": rev.Id,
			})
		}).Bind(apis.RequireAuth())

		return e.Next()
	})
}

func toStringSlice(v any) []string {
	switch vv := v.(type) {
	case []string:
		return vv
	case []any:
		out := make([]string, 0, len(vv))
		for _, x := range vv {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case string:
		if vv == "" {
			return nil
		}
		return []string{vv}
	}
	return nil
}
