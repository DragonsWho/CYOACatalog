// Chunked hosting upload, shared by the superuser endpoint (/api/hosting/admin/upload-part) and
// moderator uploads from the helper app (modkit.go). A game arrives in PARTS (each a valid zip of a
// file subset) to get under the edge proxy's ~100MB request limit. All parts write into ONE version
// prefix; the hosted_games record is created/updated only on the final part (final=true) after
// auditing the whole assembly (index.html present, size/count within limits). Protocol (clients:
// tools/big_upload_chunked/chunked_upload.py, tools/cyoa-helper): part 0 — server computes the
// version and returns it (client puts index.html in part 0); parts 1..N-1 — client sends that
// version back (form "version"); final=true — server audits the prefix and finalizes. Parts are
// idempotent (same keys overwritten). Limits: part ≤ maxZipSize, game ≤ maxChunkedGameSize.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Set by registerHostingRoutes; nil when R2 is not configured (hosting disabled).
var (
	hostingR2     *s3.Client
	hostingBucket string
)

type uploadPartOpts struct {
	// Force lets part 0 start a new version of an existing slot (superuser only).
	Force bool
	// NewOnly: the slot must not exist on ANY part and the version is pinned to 1. Moderator uploads
	// use it, so a client-supplied version can never write into a live game's prefix.
	NewOnly bool
	// Actor for the process log line.
	Actor string
	// versions_meta note for an update of an existing slot.
	UpdateNote string
	// Server-decided slot and title; when set, the form's slug/title are ignored.
	Slug, Title string
}

type uploadPartResult struct {
	Final    bool
	RecordID string
	Slug     string
	URL      string
	Version  int
	Size     int64
	Files    int
}

// uploadPartForUser writes the JSON response itself. The result is non-nil only when the final part
// was accepted and the hosted_games record saved.
func uploadPartForUser(app core.App, e *core.RequestEvent, s3Client *s3.Client, bucket string,
	targetUser *core.Record, opt uploadPartOpts) (*uploadPartResult, error) {

	hostingSlug := targetUser.GetString("hosting_slug")
	userID := targetUser.Id

	slug := strings.ToLower(strings.TrimSpace(e.Request.FormValue("slug")))
	if opt.Slug != "" {
		slug = opt.Slug
	}
	if !isValidSlug(slug) || (opt.NewOnly && slug == "_home") {
		return nil, e.JSON(http.StatusBadRequest, map[string]string{
			"error": "slug: 3-60 chars, a-z 0-9 hyphens, no leading/trailing hyphens",
		})
	}

	partIndex, _ := strconv.Atoi(e.Request.FormValue("part_index"))
	final := strings.ToLower(strings.TrimSpace(e.Request.FormValue("final"))) == "true"

	dup, _ := app.FindFirstRecordByFilter("hosted_games",
		"owner = {:owner} && slug = {:slug}",
		dbx.Params{"owner": userID, "slug": slug})

	if opt.NewOnly && dup != nil {
		return nil, e.JSON(http.StatusConflict, map[string]any{
			"error": fmt.Sprintf("%s already has a game at %s — pick another slug",
				hostingSlug, makeGameURL(hostingSlug, slug)),
			"url": makeGameURL(hostingSlug, slug),
		})
	}

	oldVersion := 0
	if dup != nil {
		oldVersion = dup.GetInt("version")
		if oldVersion <= 0 {
			oldVersion = 1
		}
	}
	var newVersion int
	switch {
	case opt.NewOnly:
		newVersion = 1
	case partIndex == 0:
		if dup != nil && !opt.Force {
			return nil, e.JSON(http.StatusOK, map[string]interface{}{
				"id": dup.Id, "slug": slug, "url": makeGameURL(hostingSlug, slug),
				"version": dup.GetInt("version"), "skipped": true,
				"message": "game with this slug already exists",
			})
		}
		if dup != nil {
			newVersion = oldVersion + 1
		} else {
			newVersion = 1
		}
	default:
		newVersion, _ = strconv.Atoi(e.Request.FormValue("version"))
		if newVersion <= 0 {
			return nil, e.JSON(http.StatusBadRequest, map[string]string{
				"error": "version (returned by part 0) required for part_index > 0",
			})
		}
	}
	prefix := r2VersionPrefix(hostingSlug, slug, newVersion)

	file, header, err := e.Request.FormFile("archive")
	if err != nil {
		return nil, e.JSON(http.StatusBadRequest, map[string]string{"error": "missing 'archive' file"})
	}
	defer file.Close()
	if header.Size > maxZipSize {
		return nil, e.JSON(http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("part too large, max %d MB", maxZipSize>>20),
		})
	}
	zipData, err := io.ReadAll(io.LimitReader(file, maxZipSize+1))
	if err != nil || int64(len(zipData)) > maxZipSize {
		return nil, e.JSON(http.StatusRequestEntityTooLarge, map[string]string{"error": "part too large"})
	}
	if _, err := processZipPartToR2(zipData, s3Client, bucket, prefix, maxChunkedGameSize); err != nil {
		// Do NOT clear the prefix: the client may resend this part (idempotent).
		return nil, e.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
	}

	if !final {
		return nil, e.JSON(http.StatusOK, map[string]interface{}{
			"slug": slug, "version": newVersion, "part_index": partIndex, "done": false,
		})
	}

	fileCount, totalBytes, hasIndex, relPaths := r2PrefixStats(s3Client, bucket, prefix)
	if !hasIndex {
		cleanupR2(s3Client, bucket, prefix)
		return nil, e.JSON(http.StatusBadRequest, map[string]string{"error": "archive must contain index.html"})
	}
	if fileCount > maxFiles {
		cleanupR2(s3Client, bucket, prefix)
		return nil, e.JSON(http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("too many files (max %d)", maxFiles)})
	}
	if totalBytes > maxChunkedGameSize {
		cleanupR2(s3Client, bucket, prefix)
		return nil, e.JSON(http.StatusRequestEntityTooLarge, map[string]string{
			"error": fmt.Sprintf("game too large, max %d MB", maxChunkedGameSize>>20),
		})
	}

	now := time.Now().UTC().Format(time.RFC3339)
	desc := strings.TrimSpace(e.Request.FormValue("description"))
	title := strings.TrimSpace(e.Request.FormValue("title"))
	if opt.Title != "" {
		title = opt.Title
	}

	var rec *core.Record
	if dup != nil {
		rec = dup
		rec.Set("version", newVersion)
		rec.Set("size_bytes", totalBytes)
		rec.Set("file_count", fileCount)
		if desc != "" {
			rec.Set("description", desc)
		}
		var meta []map[string]interface{}
		if raw := rec.GetString("versions_meta"); raw != "" && raw != "null" {
			json.Unmarshal([]byte(raw), &meta)
		}
		meta = append(meta, map[string]interface{}{
			"v": newVersion, "uploaded_at": now,
			"size_bytes": totalBytes, "file_count": fileCount,
			"note": opt.UpdateNote,
		})
		rec.Set("versions_meta", meta)
	} else {
		if title == "" {
			cleanupR2(s3Client, bucket, prefix)
			return nil, e.JSON(http.StatusBadRequest, map[string]string{"error": "title required for new game"})
		}
		col, err := app.FindCollectionByNameOrId("hosted_games")
		if err != nil {
			cleanupR2(s3Client, bucket, prefix)
			return nil, e.JSON(http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		rec = core.NewRecord(col)
		rec.Set("owner", userID)
		rec.Set("slug", slug)
		rec.Set("title", title)
		rec.Set("description", desc)
		rec.Set("version", newVersion)
		rec.Set("size_bytes", totalBytes)
		rec.Set("file_count", fileCount)
		rec.Set("status", "active")
		rec.Set("entry_point", "index.html")
		rec.Set("versions_meta", []map[string]interface{}{
			{"v": newVersion, "uploaded_at": now, "size_bytes": totalBytes, "file_count": fileCount, "note": desc},
		})
	}

	if err := app.Save(rec); err != nil {
		cleanupR2(s3Client, bucket, prefix)
		return nil, e.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}

	lookupCache.drop(hostingSlug + "/" + slug)
	if oldVersion > 0 {
		purgeGameURLs(s3Client, bucket, hostingSlug, slug, oldVersion, relPaths)
	} else {
		go purgeCloudflareCache([]string{fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain)})
	}

	fmt.Printf("[hosting] upload-part: '%s/%s' v%d finalized by %s for user '%s' (%d files, %s, force=%v)\n",
		hostingSlug, slug, newVersion, opt.Actor, targetUser.GetString("username"), fileCount, formatBytes(totalBytes), opt.Force)

	res := &uploadPartResult{
		Final: true, RecordID: rec.Id, Slug: slug, URL: makeGameURL(hostingSlug, slug),
		Version: newVersion, Size: totalBytes, Files: fileCount,
	}
	return res, e.JSON(http.StatusOK, map[string]interface{}{
		"id": rec.Id, "slug": slug, "url": res.URL,
		"version": newVersion, "size": totalBytes, "files": fileCount, "done": true,
	})
}
