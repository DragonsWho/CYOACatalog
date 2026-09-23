// Player-uploaded images inside builds (ICC `/IMG#` suffix). Native ICC embeds them as base64
// data-URLs, which alone blow the 30k-char showcase-comment limit, so builds store a LINK and bytes
// live in the `build_images` collection (PB/create_build_images_collection.py).
// Key = sha256 of content: the same avatar is re-sent on every "Update my build"; dedup turns that
// into one GET.
// Only this handler writes (createRule=nil) and it enforces size cap, type whitelist and daily
// quota. Without the quota this is free image hosting on our bandwidth.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

const (
	buildImagesCol = "build_images"

	buildImageMaxBytes = 2 << 20

	// Quota counts NEW records only; re-sending a known file is caught by dedup first.
	buildImageDailyLimit = 50
)

var buildImageMIME = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// Hash comes from the browser and goes straight into a filter: hex only.
var buildImageHashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Path, not absolute URL: behind Cloudflare we don't see the real scheme/host; the frontend knows
// its origin.
func buildImageURL(rec *core.Record) string {
	return "/api/files/" + buildImagesCol + "/" + rec.Id + "/" + rec.GetString("file")
}

func buildImageByHash(app core.App, hash string) *core.Record {
	rec, err := app.FindFirstRecordByFilter(buildImagesCol, "hash = {:h}", map[string]any{"h": hash})
	if err != nil {
		return nil
	}
	return rec
}

// Sliding 24h window over records; avoids a schema counter field that would need manual resets.
func buildImageQuotaLeft(app core.App, userID string) int {
	since := time.Now().UTC().Add(-24 * time.Hour).Format("2006-01-02 15:04:05Z")
	recs, err := app.FindRecordsByFilter(
		buildImagesCol,
		"user = {:u} && created >= {:since}",
		"", buildImageDailyLimit+1, 0,
		map[string]any{"u": userID, "since": since},
	)
	if err != nil {
		// DB error → allow. Letting one image slip beats breaking build saves for everyone during SQLite
		// hiccups.
		return buildImageDailyLimit
	}
	left := buildImageDailyLimit - len(recs)
	if left < 0 {
		return 0
	}
	return left
}

func buildImageRead(c *core.RequestEvent) ([]byte, string, error) {
	// Cap the WHOLE body BEFORE parsing: ParseMultipartForm only bounds memory, the rest spills to
	// temp files on the droplet disk. MaxBytesReader cuts at the socket.
	c.Request.Body = http.MaxBytesReader(c.Response, c.Request.Body, buildImageMaxBytes+(1<<20))
	if err := c.Request.ParseMultipartForm(buildImageMaxBytes + (1 << 20)); err != nil {
		return nil, "", fmt.Errorf("Malformed form")
	}
	hdrs := c.Request.MultipartForm.File["image"]
	if len(hdrs) == 0 {
		return nil, "", fmt.Errorf("No image attached")
	}
	h := hdrs[0]
	if h.Size > buildImageMaxBytes {
		return nil, "", fmt.Errorf("Image is too big (max %d MB)", buildImageMaxBytes>>20)
	}
	// Part Content-Type is a client hint; the real content check is PB's mimeTypes on the file field
	// at save.
	if !buildImageMIME[h.Header.Get("Content-Type")] {
		return nil, "", fmt.Errorf("Only JPEG, PNG, GIF or WebP images")
	}
	fh, err := h.Open()
	if err != nil {
		return nil, "", fmt.Errorf("Can't read the image")
	}
	defer fh.Close()
	data, err := io.ReadAll(io.LimitReader(fh, buildImageMaxBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("Can't read the image")
	}
	if len(data) > buildImageMaxBytes {
		return nil, "", fmt.Errorf("Image is too big (max %d MB)", buildImageMaxBytes>>20)
	}
	return data, h.Filename, nil
}

// Filename carries dimensions (`640x480.webp`) so the build card reserves space before the image
// loads (same trick as chat).
func buildImageName(name string) string {
	name = strings.TrimSpace(name)
	if i := strings.LastIndexAny(name, "/\\"); i >= 0 {
		name = name[i+1:]
	}
	if name == "" || strings.HasPrefix(name, ".") {
		return "build-image.webp"
	}
	if len(name) > 100 {
		name = name[len(name)-100:]
	}
	return name
}

func registerBuildImages(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		g := e.Router.Group("/api/custom/build-image")
		// Auth required for both: anonymous probe = "do you host this image" oracle; anonymous upload =
		// open file hosting.
		g.Bind(apis.RequireAuth())

		// Probe-by-hash is the main path: avoids re-uploading the same avatar on every save.
		g.GET("", func(c *core.RequestEvent) error {
			hash := strings.ToLower(strings.TrimSpace(c.Request.URL.Query().Get("hash")))
			if !buildImageHashRe.MatchString(hash) {
				return c.BadRequestError("Bad hash", nil)
			}
			rec := buildImageByHash(app, hash)
			if rec == nil {
				return c.NotFoundError("Not uploaded yet", nil)
			}
			return c.JSON(http.StatusOK, map[string]any{"url": buildImageURL(rec), "hash": hash})
		})

		g.POST("", func(c *core.RequestEvent) error {
			if c.Auth == nil {
				return c.UnauthorizedError("Log in to save a build with images.", nil)
			}
			data, name, err := buildImageRead(c)
			if err != nil {
				return c.BadRequestError(err.Error(), nil)
			}
			sum := sha256.Sum256(data)
			hash := hex.EncodeToString(sum[:])

			// Dedup before quota: re-sending a known file must not spend the limit.
			if rec := buildImageByHash(app, hash); rec != nil {
				return c.JSON(http.StatusOK, map[string]any{"url": buildImageURL(rec), "hash": hash})
			}
			if buildImageQuotaLeft(app, c.Auth.Id) <= 0 {
				return c.Error(http.StatusTooManyRequests,
					fmt.Sprintf("Daily image limit reached (%d/day) — try again tomorrow.", buildImageDailyLimit), nil)
			}

			col, err := app.FindCollectionByNameOrId(buildImagesCol)
			if err != nil {
				return c.InternalServerError("Image storage is not set up", err)
			}
			f, err := filesystem.NewFileFromBytes(data, buildImageName(name))
			if err != nil {
				return c.BadRequestError("Can't read the image", err)
			}
			rec := core.NewRecord(col)
			rec.Set("hash", hash)
			rec.Set("user", c.Auth.Id)
			rec.Set("bytes", len(data))
			rec.Set("file", f)
			if err := app.Save(rec); err != nil {
				// Two tabs racing on the same file: the unique hash index rejects the second — that's the
				// desired answer.
				if dup := buildImageByHash(app, hash); dup != nil {
					return c.JSON(http.StatusOK, map[string]any{"url": buildImageURL(dup), "hash": hash})
				}
				return c.BadRequestError("Could not save the image", err)
			}
			return c.JSON(http.StatusOK, map[string]any{"url": buildImageURL(rec), "hash": hash})
		})

		return e.Next()
	})
}
