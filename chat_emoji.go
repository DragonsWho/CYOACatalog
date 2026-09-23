// Custom chat emoji pack: `chat_emoji` collection + moderator handlers. The pack is data, not part
// of the binary: files are a PB file field served from /api/files/chat_emoji/…, covered by the
// Cloudflare rule "PB media — cache hard 31d".
// ⚠ Field `file` MUST stay protected=false: protected adds a per-user token to every URL and the
// CDN is bypassed.
// Pack is held in memory, rebuilt by record hooks on any change; served as a ready JSON blob with
// ETag (no DB hit per request).
// Image conversion is intentionally NOT server-side: a third of the pack is animated webp
// (impossible via canvas), and img2webp on the droplet expands all frames to PNG in a
// memory-starved box. Animations are built by _dev/emoji_pack/build.py; the browser compresses
// statics; the server accepts ready webp.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

const chatEmojiCol = "chat_emoji"

// Max that still fits one picker held fully in memory. Beyond it → categories + lazy loading, not a
// silent bump.
const chatEmojiMaxCount = 1000

// Same limit as the collection schema (PB/create_chat_emoji_collection.py).
const chatEmojiMaxBytes = 512000

// Shortcode format is duplicated — keep in sync: shoutReactNameRe (shoutbox_reactions.go),
// SHORTCODE (src/components/Shoutbox/richText.tsx), SHORTCODE_MIN/MAX (build.py). Min 2 chars so
// ":3" and ":D" never become images.
var chatEmojiNameRe = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)

type chatEmoji struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	File string `json:"file"`
	Pack string `json:"pack"`
	// Hidden = hidden from the picker only; stays in the list so old messages still render it.
	Hidden   bool   `json:"hidden"`
	Quick    bool   `json:"quick"`
	Animated bool   `json:"animated"`
	Opaque   bool   `json:"opaque"`
	Bytes    int    `json:"bytes"`
	Source   string `json:"source"`
	W        int    `json:"w"`
	H        int    `json:"h"`
}

type chatEmojiCache struct {
	mu    sync.RWMutex
	body  []byte
	etag  string
	names map[string]bool
}

var chatEmojiPack = &chatEmojiCache{names: map[string]bool{}}

func (c *chatEmojiCache) validNames() map[string]bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.names
}

func (c *chatEmojiCache) snapshot() ([]byte, string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.body, c.etag
}

// On error the previous pack stays.
func (c *chatEmojiCache) refresh(app core.App) {
	recs, err := app.FindRecordsByFilter(chatEmojiCol, "", "sort,name", chatEmojiMaxCount, 0)
	if err != nil {
		// Missing collection (fresh DB, other stand) is not an error: just no pack.
		app.Logger().Warn("chat_emoji refresh failed", "error", err.Error())
		return
	}
	items := make([]chatEmoji, 0, len(recs))
	names := make(map[string]bool, len(recs))
	quick := make([]string, 0, 8)
	for _, r := range recs {
		name := r.GetString("name")
		if !chatEmojiNameRe.MatchString(name) || r.GetString("file") == "" {
			// Records hand-edited in the PB admin bypass our checks: skip names the chat markup can't parse.
			app.Logger().Warn("chat_emoji: skipping bad record", "id", r.Id, "name", name)
			continue
		}
		e := chatEmoji{
			ID:       r.Id,
			Name:     name,
			File:     r.GetString("file"),
			Pack:     r.GetString("pack"),
			Hidden:   r.GetBool("hidden"),
			Quick:    r.GetBool("quick"),
			Animated: r.GetBool("animated"),
			Opaque:   r.GetBool("opaque"),
			Bytes:    r.GetInt("bytes"),
			Source:   r.GetString("source"),
			W:        r.GetInt("w"),
			H:        r.GetInt("h"),
		}
		names[name] = true
		if e.Quick && !e.Hidden {
			quick = append(quick, name)
		}
		items = append(items, e)
	}
	body, err := json.Marshal(map[string]any{
		"quick": quick,
		"emoji": items,
	})
	if err != nil {
		app.Logger().Error("chat_emoji marshal failed", "error", err.Error())
		return
	}
	sum := sha256.Sum256(body)
	c.mu.Lock()
	c.body, c.etag = body, `"`+hex.EncodeToString(sum[:8])+`"`
	c.names = names
	c.mu.Unlock()
}

// Only need two bits (animated, alpha) from the VP8X header flags; don't decode the image. w/h come
// from the client (informational only; CSS sizes emoji).
func chatEmojiProbe(b []byte) (bool, bool) {
	if len(b) < 21 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return false, true
	}
	switch string(b[12:16]) {
	case "VP8X":
		flags := b[20]
		return flags&0x02 != 0, flags&0x10 != 0
	case "VP8L":
		// Simple lossless: alpha bit is in a packed header; assume alpha (the error in this direction is
		// harmless).
		return false, true
	default:
		return false, false
	}
}

// Return only fields actually sent: PATCH must not zero fields nobody asked about.
func chatEmojiFieldsFromRequest(c *core.RequestEvent) (map[string]any, error) {
	out := map[string]any{}
	form := c.Request.MultipartForm
	get := func(key string) (string, bool) {
		if form != nil {
			if v, ok := form.Value[key]; ok && len(v) > 0 {
				return v[0], true
			}
			return "", false
		}
		return "", false
	}
	if v, ok := get("name"); ok {
		name := strings.ToLower(strings.TrimSpace(v))
		if !chatEmojiNameRe.MatchString(name) {
			return nil, fmt.Errorf("Name must be 2-32 characters of a-z, 0-9 and _")
		}
		out["name"] = name
	}
	if v, ok := get("pack"); ok {
		out["pack"] = strings.TrimSpace(v)
	}
	if v, ok := get("source"); ok {
		out["source"] = strings.TrimSpace(v)
	}
	for _, key := range []string{"quick", "hidden"} {
		if v, ok := get(key); ok {
			out[key] = v == "true" || v == "1"
		}
	}
	for _, key := range []string{"w", "h", "sort"} {
		if v, ok := get(key); ok {
			n, err := strconv.Atoi(strings.TrimSpace(v))
			if err != nil {
				return nil, fmt.Errorf("Field %s must be a number", key)
			}
			out[key] = n
		}
	}
	return out, nil
}

// Size/animated/opacity are derived from the file, never trusted from the client: cleanup decisions
// rely on them.
func chatEmojiFile(c *core.RequestEvent, fields map[string]any) (*filesystem.File, error) {
	form := c.Request.MultipartForm
	if form == nil {
		return nil, nil
	}
	hdrs := form.File["file"]
	if len(hdrs) == 0 {
		return nil, nil
	}
	h := hdrs[0]
	if h.Size > chatEmojiMaxBytes {
		return nil, fmt.Errorf("Emoji is too big (max %d KB)", chatEmojiMaxBytes/1024)
	}
	fh, err := h.Open()
	if err != nil {
		return nil, fmt.Errorf("Can't read the file")
	}
	defer fh.Close()
	head := make([]byte, 32)
	n, _ := fh.Read(head)
	head = head[:n]
	if n < 12 || string(head[0:4]) != "RIFF" || string(head[8:12]) != "WEBP" {
		// Check content, not Content-Type (client-written). Pack must be webp or browsers disagree on
		// what renders.
		return nil, fmt.Errorf("Only WebP files (convert it with _dev/emoji_pack/build.py)")
	}
	animated, hasAlpha := chatEmojiProbe(head)
	fields["bytes"] = int(h.Size)
	fields["animated"] = animated
	fields["opaque"] = !hasAlpha
	f, err := filesystem.NewFileFromMultipart(h)
	if err != nil {
		return nil, fmt.Errorf("Can't read the file")
	}
	return f, nil
}

// Step 10 so an insert between two neighbours doesn't renumber the table.
func chatEmojiNextSort(app core.App) int {
	recs, err := app.FindRecordsByFilter(chatEmojiCol, "", "-sort", 1, 0)
	if err != nil || len(recs) == 0 {
		return 0
	}
	return recs[0].GetInt("sort") + 10
}

// Swap the pair's sort values instead of renumbering: every record save fires the pack-rebuild
// hook. Full renumber only when neighbours share a sort (order fell back to name).
func chatEmojiMove(app core.App, id, dir string) error {
	recs, err := app.FindRecordsByFilter(chatEmojiCol, "", "sort,name", chatEmojiMaxCount, 0)
	if err != nil {
		return fmt.Errorf("Could not read the pack")
	}
	i := -1
	for n, r := range recs {
		if r.Id == id {
			i = n
			break
		}
	}
	if i < 0 {
		return fmt.Errorf("No such emoji")
	}

	if dir == "top" {
		if i == 0 {
			return nil
		}
		recs[i].Set("sort", recs[0].GetInt("sort")-10)
		if err := app.Save(recs[i]); err != nil {
			return fmt.Errorf("Could not save the order")
		}
		return nil
	}

	j := i - 1
	if dir == "down" {
		j = i + 1
	} else if dir != "up" {
		return fmt.Errorf("Unknown direction")
	}
	if j < 0 || j >= len(recs) {
		return nil
	}

	return app.RunInTransaction(func(tx core.App) error {
		si, sj := recs[i].GetInt("sort"), recs[j].GetInt("sort")
		if si == sj {
			for n, r := range recs {
				if r.GetInt("sort") == n*10 {
					continue
				}
				r.Set("sort", n*10)
				if err := tx.Save(r); err != nil {
					return err
				}
			}
			si, sj = i*10, j*10
		}
		recs[i].Set("sort", sj)
		recs[j].Set("sort", si)
		if err := tx.Save(recs[i]); err != nil {
			return err
		}
		return tx.Save(recs[j])
	})
}

func chatEmojiSaveError(err error) string {
	if strings.Contains(strings.ToLower(err.Error()), "unique") {
		return "An emoji with this name already exists"
	}
	return "Could not save the emoji"
}

func registerChatEmoji(app *pocketbase.PocketBase) {
	refresh := func(e *core.RecordEvent) error {
		chatEmojiPack.refresh(e.App)
		return nil
	}
	app.OnRecordAfterCreateSuccess(chatEmojiCol).BindFunc(refresh)
	app.OnRecordAfterUpdateSuccess(chatEmojiCol).BindFunc(refresh)
	app.OnRecordAfterDeleteSuccess(chatEmojiCol).BindFunc(refresh)

	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		chatEmojiPack.refresh(app)

		g := e.Router.Group("/api/custom/chat")

		// Public (anons see emoji in chat). No edge caching (edits must show at once); ETag revalidation
		// costs ~200 bytes.
		g.GET("/emoji", func(c *core.RequestEvent) error {
			body, etag := chatEmojiPack.snapshot()
			if body == nil {
				body = []byte(`{"quick":[],"emoji":[]}`)
			}
			c.Response.Header().Set("Cache-Control", "no-cache")
			c.Response.Header().Set("ETag", etag)
			if etag != "" && strings.Contains(c.Request.Header.Get("If-None-Match"), etag) {
				c.Response.WriteHeader(http.StatusNotModified)
				return nil
			}
			c.Response.Header().Set("Content-Type", "application/json")
			c.Response.WriteHeader(http.StatusOK)
			_, err := c.Response.Write(body)
			return err
		})

		mod := func(fn func(*core.RequestEvent) error) func(*core.RequestEvent) error {
			return func(c *core.RequestEvent) error {
				if !hasPerm(c, permChat) {
					return c.ForbiddenError("Moderators only.", nil)
				}
				// Parse the form only if present: DELETE has no body and unconditional parsing answered
				// "Malformed form".
				if strings.HasPrefix(c.Request.Header.Get("Content-Type"), "multipart/form-data") {
					if err := c.Request.ParseMultipartForm(chatEmojiMaxBytes + (1 << 20)); err != nil {
						return c.BadRequestError("Malformed form", err)
					}
				}
				return fn(c)
			}
		}

		g.POST("/emoji", mod(func(c *core.RequestEvent) error {
			fields, err := chatEmojiFieldsFromRequest(c)
			if err != nil {
				return c.BadRequestError(err.Error(), nil)
			}
			if _, ok := fields["name"]; !ok {
				return c.BadRequestError("Name is required", nil)
			}
			file, err := chatEmojiFile(c, fields)
			if err != nil {
				return c.BadRequestError(err.Error(), nil)
			}
			if file == nil {
				return c.BadRequestError("File is required", nil)
			}
			col, err := app.FindCollectionByNameOrId(chatEmojiCol)
			if err != nil {
				return c.InternalServerError("Emoji collection is missing", err)
			}
			rec := core.NewRecord(col)
			for k, v := range fields {
				rec.Set(k, v)
			}
			if _, ok := fields["sort"]; !ok {
				rec.Set("sort", chatEmojiNextSort(app))
			}
			rec.Set("file", file)
			if err := app.Save(rec); err != nil {
				return c.BadRequestError(chatEmojiSaveError(err), err)
			}
			logModAction(app, c, modAction{
				Action:     "emoji.create",
				Target:     rec.Id + " :" + rec.GetString("name") + ":",
				After:      modSnapshot(rec, "name", "sort", "file"),
				Reversible: true,
				Note:       "undo = delete the emoji record",
			})
			return c.JSON(http.StatusOK, map[string]any{"id": rec.Id})
		})).Bind(apis.RequireAuth())

		g.PATCH("/emoji/{id}", mod(func(c *core.RequestEvent) error {
			rec, err := app.FindRecordById(chatEmojiCol, c.Request.PathValue("id"))
			if err != nil {
				return c.NotFoundError("Emoji not found", err)
			}
			fields, err := chatEmojiFieldsFromRequest(c)
			if err != nil {
				return c.BadRequestError(err.Error(), nil)
			}
			file, err := chatEmojiFile(c, fields)
			if err != nil {
				return c.BadRequestError(err.Error(), nil)
			}
			emojiBefore := modSnapshot(rec, "name", "sort", "file")
			for k, v := range fields {
				rec.Set(k, v)
			}
			if file != nil {
				// PB stores the replacement under a new filename → new URL → no CDN purge needed.
				rec.Set("file", file)
			}
			if err := app.Save(rec); err != nil {
				return c.BadRequestError(chatEmojiSaveError(err), err)
			}
			logModAction(app, c, modAction{
				Action:     "emoji.update",
				Target:     rec.Id + " :" + rec.GetString("name") + ":",
				Before:     emojiBefore,
				After:      modSnapshot(rec, "name", "sort", "file"),
				Reversible: true,
			})
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		})).Bind(apis.RequireAuth())

		g.DELETE("/emoji/{id}", mod(func(c *core.RequestEvent) error {
			rec, err := app.FindRecordById(chatEmojiCol, c.Request.PathValue("id"))
			if err != nil {
				return c.NotFoundError("Emoji not found", err)
			}
			// Hard delete incl. file (author's decision): old messages with this shortcode fall back to
			// plain text.
			emojiGone := modSnapshot(rec, "name", "sort", "file")
			if err := app.Delete(rec); err != nil {
				return c.InternalServerError("Could not delete the emoji", err)
			}
			logModAction(app, c, modAction{
				Action:     "emoji.delete",
				Target:     rec.Id + " :" + rec.GetString("name") + ":",
				Before:     emojiGone,
				Reversible: false,
				Note:       "the image file is deleted with the record; re-adding needs the source picture",
			})
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		})).Bind(apis.RequireAuth())

		// One step at a time, not a full id list: a swap saves 2 records, a full list saves all ~125,
		// each firing the rebuild hook.
		g.POST("/emoji/move", mod(func(c *core.RequestEvent) error {
			var p struct {
				ID  string `json:"id"`
				Dir string `json:"dir"`
			}
			if err := c.BindBody(&p); err != nil || p.ID == "" {
				return c.BadRequestError("Missing id", err)
			}
			if err := chatEmojiMove(app, p.ID, p.Dir); err != nil {
				return c.BadRequestError(err.Error(), err)
			}
			chatEmojiPack.refresh(app)
			// Reorders go to the moderation journal like add/delete.
			logModAction(app, c, modAction{
				Action:     "emoji.move",
				Target:     p.ID,
				After:      map[string]any{"dir": p.Dir},
				Reversible: true,
				Note:       "reorder within the pack; lift by moving it back",
			})
			return c.JSON(http.StatusOK, map[string]any{"ok": true})
		})).Bind(apis.RequireAuth())

		return e.Next()
	})
}
