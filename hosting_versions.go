// Hosted-game versions: reupload a new version and roll back to an old one — one implementation for
// four entry points (owner and moderator). R2 layout: games/{hostingSlug}/{gameSlug}/v{N}/… Old
// prefixes are NEVER deleted (except mod/purge), so a rollback is just changing
// hosted_games.version + cache purge, no re-upload.
// Moderator path differs from owner path in two ways: the hosting slug comes from the game's OWNER
// (otherwise files would land in the moderator's prefix and the public URL would break); the
// owner's daily quota isn't checked (quota=false) — a user's exhausted limit must not block catalog
// repair. Bytes are still charged to the owner.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// hostingError carries the HTTP status: shared functions are called from several handlers, each
// must return the same status as before.
type hostingError struct {
	status int
	msg    string
}

func (e *hostingError) Error() string { return e.msg }

func hostingErr(status int, format string, a ...any) *hostingError {
	return &hostingError{status: status, msg: fmt.Sprintf(format, a...)}
}

func hostingFail(e *core.RequestEvent, err error) error {
	var he *hostingError
	if errors.As(err, &he) {
		return e.JSON(he.status, map[string]string{"error": he.msg})
	}
	return e.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

type versionResult struct {
	Version   int
	SizeBytes int64
	FileCount int
	Previous  int
}

// hostingReadArchive reads multipart `archive` with caps. quotaUser != nil → pre-check the daily
// quota on declared size before reading the body (exact check later on unpacked size).
func hostingReadArchive(e *core.RequestEvent, maxZip int64, quotaUser *core.Record) ([]byte, error) {
	file, header, err := e.Request.FormFile("archive")
	if err != nil {
		return nil, hostingErr(http.StatusBadRequest, "missing 'archive' file")
	}
	defer file.Close()

	if header.Size > maxZip {
		return nil, hostingErr(http.StatusRequestEntityTooLarge, "zip too large, max %d MB", maxZip>>20)
	}
	if quotaUser != nil {
		if err := checkDailyUploadLimit(quotaUser, header.Size); err != nil {
			return nil, hostingErr(http.StatusTooManyRequests, "%s", err.Error())
		}
	}
	zipData, err := io.ReadAll(io.LimitReader(file, maxZip+1))
	if err != nil || int64(len(zipData)) > maxZip {
		return nil, hostingErr(http.StatusRequestEntityTooLarge, "zip too large")
	}
	return zipData, nil
}

func hostingVersionsMeta(rec *core.Record) []map[string]interface{} {
	var meta []map[string]interface{}
	if raw := rec.GetString("versions_meta"); raw != "" && raw != "null" {
		json.Unmarshal([]byte(raw), &meta)
	}
	if meta == nil {
		meta = []map[string]interface{}{}
	}
	return meta
}

// hostingApplyNewVersion uploads the archive as the next version. owner = record owner (size cap +
// daily usage), hostingSlug = owner's public prefix, quota = whether to check the daily limit.
func hostingApplyNewVersion(
	app *pocketbase.PocketBase, s3Client *s3.Client, bucket string,
	rec, owner *core.Record, hostingSlug string, zipData []byte,
	title, description, versionNote string, quota bool,
) (*versionResult, error) {
	maxZip := getUserMaxZipSize(owner)
	slug := rec.GetString("slug")
	oldVersion := rec.GetInt("version")
	if oldVersion <= 0 {
		oldVersion = 1
	}
	newVersion := oldVersion + 1

	newPrefix := r2VersionPrefix(hostingSlug, slug, newVersion)
	result, err := processZipToR2(zipData, s3Client, bucket, newPrefix, maxZip)
	if err != nil {
		cleanupR2(s3Client, bucket, newPrefix)
		return nil, hostingErr(http.StatusBadRequest, "%s", err.Error())
	}

	if quota {
		if err := checkDailyUploadLimit(owner, result.totalSize); err != nil {
			cleanupR2(s3Client, bucket, newPrefix)
			return nil, hostingErr(http.StatusTooManyRequests, "%s", err.Error())
		}
	}

	rec.Set("version", newVersion)
	rec.Set("size_bytes", result.totalSize)
	rec.Set("file_count", result.fileCount)
	if title != "" {
		rec.Set("title", title)
	}
	if description != "" {
		rec.Set("description", description)
	}
	meta := append(hostingVersionsMeta(rec), map[string]interface{}{
		"v": newVersion, "uploaded_at": time.Now().UTC().Format(time.RFC3339),
		"size_bytes": result.totalSize, "file_count": result.fileCount, "note": versionNote,
	})
	rec.Set("versions_meta", meta)
	if err := app.Save(rec); err != nil {
		cleanupR2(s3Client, bucket, newPrefix)
		return nil, hostingErr(http.StatusInternalServerError, "%s", err.Error())
	}

	trackDailyUpload(app, owner, result.totalSize)
	lookupCache.drop(hostingSlug + "/" + slug)
	purgeGameURLs(s3Client, bucket, hostingSlug, slug, oldVersion, result.fileKeys)

	return &versionResult{
		Version: newVersion, SizeBytes: result.totalSize,
		FileCount: result.fileCount, Previous: oldVersion,
	}, nil
}

// hostingSwitchVersion switches to an already-uploaded version. Files untouched — v{target} has
// been in R2 since its upload.
func hostingSwitchVersion(
	app *pocketbase.PocketBase, s3Client *s3.Client, bucket string,
	rec *core.Record, hostingSlug string, target int,
) error {
	if target <= 0 {
		return hostingErr(http.StatusBadRequest, "invalid version number")
	}
	found := false
	for _, m := range hostingVersionsMeta(rec) {
		if v, ok := m["v"].(float64); ok && int(v) == target {
			found = true
			if sz, ok := m["size_bytes"].(float64); ok {
				rec.Set("size_bytes", int64(sz))
			}
			if fc, ok := m["file_count"].(float64); ok {
				rec.Set("file_count", int(fc))
			}
			break
		}
	}
	if !found {
		return hostingErr(http.StatusNotFound, "version %d not found", target)
	}

	oldVersion := rec.GetInt("version")
	slug := rec.GetString("slug")
	rec.Set("version", target)
	if err := app.Save(rec); err != nil {
		return hostingErr(http.StatusInternalServerError, "%s", err.Error())
	}
	lookupCache.drop(hostingSlug + "/" + slug)
	purgeGameURLs(s3Client, bucket, hostingSlug, slug, oldVersion, nil)
	return nil
}

// parseHostedGameURL parses https://<hostingSlug>.cyoa.cafe/<gameSlug>/ — exactly makeGameURL's
// output. Foreign domains → ok=false.
func parseHostedGameURL(raw string) (hostingSlug, gameSlug string, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", "", false
	}
	host := strings.ToLower(u.Hostname())
	suffix := "." + baseDomain
	if !strings.HasSuffix(host, suffix) {
		return "", "", false
	}
	hostingSlug = strings.TrimSuffix(host, suffix)
	// Exactly one subdomain level: www.cyoa.cafe and cyoa.cafe itself are not hosting.
	if hostingSlug == "" || hostingSlug == "www" || strings.Contains(hostingSlug, ".") {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", "", false
	}
	return hostingSlug, parts[0], true
}

// resolveHostedGame finds the hosted_games record for a catalog card. No relation between the
// collections — games.iframe_url is the only bridge.
func resolveHostedGame(app *pocketbase.PocketBase, game *core.Record) (hosted, owner *core.Record, hostingSlug string, err error) {
	iframe := game.GetString("iframe_url")
	if iframe == "" {
		return nil, nil, "", hostingErr(http.StatusBadRequest,
			"card has no iframe_url — nothing to reupload")
	}
	linkSlug, gameSlug, ok := parseHostedGameURL(iframe)
	if !ok {
		return nil, nil, "", hostingErr(http.StatusBadRequest,
			"card points to external hosting (%s) — mirror it to cyoa.cafe first", iframe)
	}

	if u, uerr := app.FindFirstRecordByFilter("users", "hosting_slug = {:s}",
		dbx.Params{"s": linkSlug}); uerr == nil && u != nil {
		owner = u
		if recs, rerr := app.FindRecordsByFilter("hosted_games", "owner = {:o} && slug = {:s}", "", 1, 0,
			dbx.Params{"o": u.Id, "s": gameSlug}); rerr == nil && len(recs) > 0 {
			hosted = recs[0]
		}
	}
	if hosted == nil {
		// The owner may have changed hosting_slug after publishing: search by game slug and accept only
		// an unambiguous hit.
		recs, rerr := app.FindRecordsByFilter("hosted_games", "slug = {:s}", "", 2, 0,
			dbx.Params{"s": gameSlug})
		if rerr != nil || len(recs) == 0 {
			return nil, nil, "", hostingErr(http.StatusNotFound,
				"game '%s' not found on our hosting", gameSlug)
		}
		if len(recs) > 1 {
			return nil, nil, "", hostingErr(http.StatusConflict,
				"slug '%s' is used by several games — fix the card's iframe_url", gameSlug)
		}
		hosted = recs[0]
		owner = nil
	}
	if owner == nil || owner.Id != hosted.GetString("owner") {
		o, oerr := app.FindRecordById("users", hosted.GetString("owner"))
		if oerr != nil || o == nil {
			return nil, nil, "", hostingErr(http.StatusNotFound, "game owner not found")
		}
		owner = o
	}
	// Public prefix comes from the owner, not the link: if the slug changed, files must land where the
	// game is actually served from.
	actual, serr := ensureHostingSlug(app, owner)
	if serr != nil || actual == "" {
		return nil, nil, "", hostingErr(http.StatusInternalServerError, "owner has no hosting_slug")
	}
	return hosted, owner, actual, nil
}

// logHostingVersionRevision: a line in the card's edit log so file swaps show next to title/author
// edits. Best-effort: files are already uploaded, don't fail the response over the log. action=edit
// because game_revisions.action is a fixed select (edit/bump/revert/hide/restore). changed holds
// hosted_version: no such field in games, /revert skips it, but the log shows from→to.
func logHostingVersionRevision(app *pocketbase.PocketBase, game *core.Record, c *core.RequestEvent,
	oldVersion, newVersion int, note string) {
	text := fmt.Sprintf("hosting v%d → v%d", oldVersion, newVersion)
	if note != "" {
		text += ": " + note
	}
	rev, err := newRevision(app, game, c, "edit", map[string]any{"hosted_version": oldVersion}, text)
	if err == nil {
		err = app.Save(rev)
	}
	if err != nil {
		app.Logger().Warn("hosting version revision not written",
			"game", game.Id, "error", err.Error())
	}
}

// Called from registerHostingRoutes: the s3 client and bucket are local there.
func registerHostingModVersionRoutes(app *pocketbase.PocketBase, se *core.ServeEvent, s3Client *s3.Client, bucket string) {
	resolve := func(e *core.RequestEvent) (game, hosted, owner *core.Record, hostingSlug string, err error) {
		info, _ := e.RequestInfo()
		if !isMod(info) {
			return nil, nil, nil, "", hostingErr(http.StatusForbidden, "moderators only")
		}
		game, gerr := app.FindRecordById("games", e.Request.PathValue("gameId"))
		if gerr != nil || game == nil {
			return nil, nil, nil, "", hostingErr(http.StatusNotFound, "game not found")
		}
		hosted, owner, hostingSlug, err = resolveHostedGame(app, game)
		if err != nil {
			return nil, nil, nil, "", err
		}
		return game, hosted, owner, hostingSlug, nil
	}

	se.Router.GET("/api/hosting/mod/versions/{gameId}", func(e *core.RequestEvent) error {
		_, hosted, owner, hostingSlug, err := resolve(e)
		if err != nil {
			return hostingFail(e, err)
		}
		current := hosted.GetInt("version")
		if current <= 0 {
			current = 1
		}
		return e.JSON(http.StatusOK, map[string]interface{}{
			"hosted_id":     hosted.Id,
			"slug":          hosted.GetString("slug"),
			"title":         hosted.GetString("title"),
			"status":        hosted.GetString("status"),
			"owner":         owner.GetString("username"),
			"owner_slug":    hostingSlug,
			"current":       current,
			"versions":      hostingVersionsMeta(hosted),
			"url":           makeGameURL(hostingSlug, hosted.GetString("slug")),
			"max_upload_mb": getUserMaxZipSize(owner) >> 20,
		})
	}).Bind(apis.RequireAuth())

	se.Router.POST("/api/hosting/mod/reupload/{gameId}", func(e *core.RequestEvent) error {
		game, hosted, owner, hostingSlug, err := resolve(e)
		if err != nil {
			return hostingFail(e, err)
		}
		zipData, err := hostingReadArchive(e, getUserMaxZipSize(owner), nil)
		if err != nil {
			return hostingFail(e, err)
		}
		note := strings.TrimSpace(e.Request.FormValue("version_note"))
		res, err := hostingApplyNewVersion(app, s3Client, bucket, hosted, owner, hostingSlug,
			zipData, "", "", note, false)
		if err != nil {
			return hostingFail(e, err)
		}
		logHostingVersionRevision(app, game, e, res.Previous, res.Version, note)
		logModAction(app, e, modAction{
			Action:     "hosting.reupload",
			Target:     hosted.Id + " " + hostingSlug + "/" + hosted.GetString("slug"),
			Game:       gameIDOf(game),
			Before:     map[string]any{"version": res.Previous},
			After:      map[string]any{"version": res.Version, "files": res.FileCount, "size": res.SizeBytes},
			Reversible: true,
			Note:       "rollback via POST /api/hosting/mod/version/{gameId}; note: " + note,
		})
		fmt.Printf("[hosting] mod/reupload: '%s/%s' v%d → v%d by '%s' (%d files, %s)\n",
			hostingSlug, hosted.GetString("slug"), res.Previous, res.Version,
			e.Auth.GetString("username"), res.FileCount, formatBytes(res.SizeBytes))
		return e.JSON(http.StatusOK, map[string]interface{}{
			"id": hosted.Id, "version": res.Version, "previous_version": res.Previous,
			"size": res.SizeBytes, "files": res.FileCount,
			"url": makeGameURL(hostingSlug, hosted.GetString("slug")),
		})
	}).Bind(apis.RequireAuth(), apis.BodyLimit(maxZipSize))

	se.Router.POST("/api/hosting/mod/version/{gameId}", func(e *core.RequestEvent) error {
		game, hosted, _, hostingSlug, err := resolve(e)
		if err != nil {
			return hostingFail(e, err)
		}
		var body struct {
			Version int `json:"version"`
		}
		if derr := json.NewDecoder(e.Request.Body).Decode(&body); derr != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid version number"})
		}
		oldVersion := hosted.GetInt("version")
		if err := hostingSwitchVersion(app, s3Client, bucket, hosted, hostingSlug, body.Version); err != nil {
			return hostingFail(e, err)
		}
		logHostingVersionRevision(app, game, e, oldVersion, body.Version, "rollback")
		logModAction(app, e, modAction{
			Action:     "hosting.version",
			Target:     hosted.Id + " " + hostingSlug + "/" + hosted.GetString("slug"),
			Game:       gameIDOf(game),
			Before:     map[string]any{"version": oldVersion},
			After:      map[string]any{"version": body.Version},
			Reversible: true,
		})
		return e.JSON(http.StatusOK, map[string]interface{}{
			"version": body.Version, "previous_version": oldVersion,
			"message": fmt.Sprintf("Switched to v%d", body.Version),
		})
	}).Bind(apis.RequireAuth())
}
