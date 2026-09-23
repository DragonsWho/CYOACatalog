// Game card edits, bumps and soft-hide — the user-facing write path for `games`. games.updateRule
// is moderator-only, so these endpoints are the ONLY way an uploader changes their card. Every
// mutation: 1) appends a revision to `game_revisions` (old values of changed fields only); 2)
// archives displaced storage files under revisions/<gameId>/<revisionId>/<filename> — PB deletes
// replaced files and R2 has no versioning, so this copy is what makes file edits reversible.
// Nothing hard-deletes: "delete" = hidden=true, a revert is another revision. Design:
// PB/schema_changes_edits_bumps.md
package main

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
	editRateMax   = 30
	maxTitleLen   = 300
	maxAliasesLen = 2000
	maxNoteLen    = 1000
	maxDescLen    = 200_000
	maxLinkLen    = 1000
	// = PB text-field limit of games.image_base64 (raised 5000→20000 by PB/bump_image_base64_max.py).
	// It used to be 64 KB, wider than the schema, so noisy covers passed this guard and failed at save
	// with a raw PB validation error.
	maxBase64Len  = 20000
	revisionsColl = "game_revisions"
	// A dozen authors means tags or translators leaked into the field.
	maxAuthorsPerGame = 12

	// Memory part of the form only; rest spills to temp files. Covers are a few MB, static pages are
	// read lazily.
	editFormMemory = 8 << 20
	// Real cap on accepted body bytes (same number as the old ParseMultipartForm arg, so nothing that
	// worked breaks).
	maxEditFormBytes = 256 << 20
)

// Content-swap fields (iframe_url, files) stay out of the uploader set on purpose: replacing the
// playable game must not be silent self-serve (hosted versions go through the hosting upload, which
// never deletes old prefixes).
var ownerEditable = map[string]bool{
	"title": true, "description": true, "release_date": true,
	"original_link": true,
}

// `aliases` is mod-only: it feeds search (title ~ q || aliases ~ q), so owners must not pull other
// games' queries onto their card. `authors` is mod-only: attribution of someone's work can't be
// self-rewritten.
var modOnlyEditable = map[string]bool{
	"iframe_url": true, "img_or_link": true, "aliases": true, "authors": true,
}

// Aliases are newline-separated: split on
// , trim, drop empties and case-insensitive dups. Commas are NOT separators.
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
	return isSuperuser(c) || hasPerm(c, permCards)
}

func canManageGame(c *core.RequestEvent, game *core.Record) bool {
	if isModOrSuper(c) {
		return true
	}
	up := game.GetString("uploader")
	return up != "" && up == c.Auth.Id
}

// Superuser tokens are only held by our automation (night watcher etc.) → "agent".
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

// Must run BEFORE the record save that displaces the files.
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

// Pre-generated id so file archiving can use it before the DB write.
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

func editRateExceeded(app core.App, editorID string) bool {
	since := time.Now().UTC().Add(-24 * time.Hour).Format("2006-01-02 15:04:05.000Z")
	recent, err := app.FindRecordsByFilter(
		revisionsColl, "editor = {:editor} && created >= {:since}", "", 0, 0,
		dbx.Params{"editor": editorID, "since": since},
	)
	return err == nil && len(recent) >= editRateMax
}

func purgeGamePage(app core.App, gameID string) {
	go func() {
		if err := purgeCFURLs([]string{siteURL + "/game/" + gameID}); err != nil {
			app.Logger().Warn("game page purge failed", "game", gameID, "error", err.Error())
		}
	}()
}

func registerGameEdits(app *pocketbase.PocketBase) {
	// Catalog "new" sort is `-bumped_at,-created`; every game needs bumped_at from birth (old records
	// backfilled by PB/backfill_bumped_at.py) or unbumped games sink below all bumped ones.
	app.OnRecordCreate("games").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetDateTime("bumped_at").IsZero() {
			e.Record.Set("bumped_at", types.NowDateTime())
		}
		// Slug from title on every creation path; collisions get a numeric suffix (unique index never
		// rejects the insert); non-Latin title → no slug, game addressable by id.
		if strings.TrimSpace(e.Record.GetString("slug")) == "" {
			if base := slugifyGame(e.Record.GetString("title")); base != "" {
				e.Record.Set("slug", uniqueGameSlug(app, base, e.Record.Id))
			}
		}
		return e.Next()
	})

	// Title change refreshes the slug on EVERY write path (admin UI, nightly pipeline, PB scripts),
	// not only /edit — otherwise the catalog linked game X to /game/<old-name>. The old slug is kept
	// as an alias so shared links still resolve.
	app.OnRecordUpdate("games").BindFunc(func(e *core.RecordEvent) error {
		old := e.Record.Original()
		if old == nil || e.Record.GetString("title") == old.GetString("title") {
			return e.Next()
		}
		// A slug set explicitly in the same write wins: a revert restoring {title, slug} together, or a
		// deliberate override.
		if e.Record.GetString("slug") != old.GetString("slug") {
			return e.Next()
		}
		// e.App, not app — alias writes must join the caller's transaction.
		applyGameSlugRename(e.App, e.Record, map[string]any{})
		return e.Next()
	})

	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		g := e.Router.Group("/api/custom")

		type editPayload struct {
			Title         *string   `json:"title"`
			Description   *string   `json:"description"`
			ReleaseDate   *string   `json:"release_date"`
			OriginalLink  *string   `json:"original_link"`
			IframeURL     *string   `json:"iframe_url"`
			ImgOrLink     *string   `json:"img_or_link"`
			Aliases       *string   `json:"aliases"`
			Authors       *[]string `json:"authors"`
			ImageBase64   *string   `json:"image_base64"`
			CyoaPagesKeep *[]string `json:"cyoa_pages_keep"`
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

			// ParseMultipartForm's arg is the in-MEMORY budget, not an upload limit. It was 256 MB on a 961
			// MB box. NewFileFromMultipart reads parts lazily, so spilling to disk breaks nothing.
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

			changed := map[string]any{}

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

			// Order matters (chip order on the card) but compare as sets: a reshuffle without a membership
			// change must not create a revision. Old value stored as []string (`changed` is JSON; /revert
			// restores via toStringSlice).
			if payload.Authors != nil {
				if !isModOrSuper(c) {
					return apis.NewForbiddenError("Field authors is moderator-only", nil)
				}
				clean := make([]string, 0, len(*payload.Authors))
				seen := map[string]bool{}
				for _, id := range *payload.Authors {
					id = strings.TrimSpace(id)
					if id == "" || seen[id] {
						continue
					}
					if _, err := app.FindRecordById("authors", id); err != nil {
						return c.BadRequestError("Unknown author id: "+id, err)
					}
					seen[id] = true
					clean = append(clean, id)
				}
				if len(clean) > maxAuthorsPerGame {
					return c.BadRequestError("Too many authors", nil)
				}
				old := game.GetStringSlice("authors")
				if !stringSlicesEqualUnordered(old, clean) {
					changed["authors"] = old
					game.Set("authors", clean)
				}
			}

			if _, titleChanged := changed["title"]; titleChanged {
				applyGameSlugRename(app, game, changed)
			}

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
					// Don't fail the edit over cosmetics: the client (blurPlaceholder.ts) already compresses under
					// the limit, but an old cached bundle may send more. Empty = no blur-up, but in sync with the
					// new cover.
					v = ""
				}
				if v != game.GetString("image_base64") {
					changed["image_base64"] = game.GetString("image_base64")
					game.Set("image_base64", v)
				}
			}

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

			// The rejection carries next_bump_at so the UI can say WHEN.
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

			catalogPurge.trigger(app)
			purgeGamePage(app, game.Id)

			return c.JSON(http.StatusOK, map[string]any{
				"success":      true,
				"bumped_at":    now.Time().UTC().Format(time.RFC3339),
				"next_bump_at": now.Time().Add(bumpCooldown).UTC().Format(time.RFC3339),
			})
		}).Bind(apis.RequireAuth())

		// Uploaders may hide within 1 hour of creation (accidental uploads); moderators any time.
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

		// The revert is itself a new revision with its own archive, so a wrong revert is reversible too.
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
			archiveByName := map[string]string{}
			for _, key := range srcArchived {
				if i := strings.LastIndex(key, "/"); i >= 0 {
					archiveByName[key[i+1:]] = key
				}
			}

			revertChanged := map[string]any{}
			var archiveNow []string

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
				case "authors":
					// JSON gives []any; the relation field needs []string.
					cur := game.GetStringSlice("authors")
					revertChanged["authors"] = cur
					game.Set("authors", toStringSlice(oldVal))
				default:
					// A revision may record a field missing from the games schema (e.g. hosted_version from a
					// hosting reupload): nothing to revert, skip to avoid an empty revision.
					if game.Collection().Fields.GetByName(field) == nil {
						continue
					}
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

func stringSlicesEqualUnordered(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	cnt := make(map[string]int, len(a))
	for _, s := range a {
		cnt[s]++
	}
	for _, s := range b {
		cnt[s]--
		if cnt[s] < 0 {
			return false
		}
	}
	return true
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
