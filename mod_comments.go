package main

// The collection is installed MANUALLY with PB/add_comment_moderation_notes.py. Nothing here
// creates or changes a collection, including at startup.
import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const commentNotesCollection = "comment_moderation_notes"
const modCommentPageSize = 40

type modCommentRow struct {
	ID            string `db:"id" json:"id"`
	Content       string `db:"content" json:"content"`
	Created       string `db:"created" json:"created"`
	Updated       string `db:"updated" json:"updated"`
	Parent        string `db:"parent" json:"parent"`
	Game          string `db:"game" json:"game"`
	GameTitle     string `db:"game_title" json:"game_title"`
	GameSlug      string `db:"game_slug" json:"game_slug"`
	Author        string `db:"author" json:"author"`
	AuthorName    string `db:"author_name" json:"author_name"`
	Deleted       bool   `db:"deleted" json:"deleted"`
	Pinned        bool   `db:"pinned" json:"pinned"`
	Replies       int    `db:"replies" json:"replies"`
	ParentContent string `db:"parent_content" json:"parent_content"`
	ParentAuthor  string `db:"parent_author" json:"parent_author"`
}

const modCommentSelect = `SELECT c.id, c.content, c.created, c.updated, c.parent, c.game, c.author,
 c.deleted, c.pinned, COALESCE(g.title, 'Deleted game') AS game_title,
 COALESCE(NULLIF(g.slug,''),c.game) AS game_slug,
 COALESCE(NULLIF(u.name,''),NULLIF(u.username,''),'Deleted user') AS author_name,
 (SELECT COUNT(*) FROM comments r WHERE r.parent=c.id) AS replies,
 COALESCE(substr(p.content,1,240),'') AS parent_content,
 COALESCE(NULLIF(pu.name,''),NULLIF(pu.username,''),'') AS parent_author
 FROM comments c LEFT JOIN games g ON g.id=c.game LEFT JOIN users u ON u.id=c.author
 LEFT JOIN comments p ON p.id=c.parent LEFT JOIN users pu ON pu.id=p.author `

type modCommentCursor struct {
	Created string `json:"created"`
	ID      string `json:"id"`
}

func encodeModCommentCursor(created, id string) string {
	b, _ := json.Marshal(modCommentCursor{created, id})
	return base64.RawURLEncoding.EncodeToString(b)
}
func decodeModCommentCursor(raw string) (modCommentCursor, error) {
	var cur modCommentCursor
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return cur, err
	}
	err = json.Unmarshal(b, &cur)
	return cur, err
}
func modCommentLike(s string) string {
	return "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(s) + "%"
}

func registerModCommentRoutes(app core.App, e *core.ServeEvent) {
	g := e.Router.Group("/api/custom/mod/comments")
	g.Bind(apis.RequireAuth())
	secure := func(fn func(*core.RequestEvent) error) func(*core.RequestEvent) error {
		return requirePerm(permComments, func(c *core.RequestEvent) error {
			c.Response.Header().Set("Cache-Control", "private, no-store")
			return fn(c)
		})
	}
	g.GET("", secure(func(c *core.RequestEvent) error {
		q := c.Request.URL.Query()
		where := "WHERE 1=1"
		params := dbx.Params{"limit": modCommentPageSize + 1}
		switch q.Get("type") {
		case "", "all":
		case "comments":
			where += " AND instr(c.content,'cyoaBuild')=0"
		case "builds":
			where += " AND instr(c.content,'cyoaBuild')>0"
		default:
			return c.BadRequestError("Unknown comment type", nil)
		}
		if search := strings.TrimSpace(q.Get("q")); search != "" {
			if utf8.RuneCountInString(search) > 200 {
				return c.BadRequestError("Search is too long", nil)
			}
			where += ` AND (c.content LIKE {:q} ESCAPE '\' OR g.title LIKE {:q} ESCAPE '\' OR u.name LIKE {:q} ESCAPE '\' OR u.username LIKE {:q} ESCAPE '\')`
			params["q"] = modCommentLike(search)
		}
		for _, field := range []string{"game", "author"} {
			if value := q.Get(field); value != "" {
				where += " AND c." + field + "={:" + field + "}"
				params[field] = value
			}
		}
		if q.Get("replies") == "yes" {
			where += " AND EXISTS (SELECT 1 FROM comments r WHERE r.parent=c.id)"
		}
		if q.Get("replies") == "no" {
			where += " AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.parent=c.id)"
		}
		if q.Get("cursor") != "" {
			cur, err := decodeModCommentCursor(q.Get("cursor"))
			if err != nil || cur.Created == "" || cur.ID == "" {
				return c.BadRequestError("Invalid cursor", nil)
			}
			where += " AND (c.created < {:created} OR (c.created={:created} AND c.id < {:id}))"
			params["created"], params["id"] = cur.Created, cur.ID
		}
		rows := []modCommentRow{}
		if err := app.DB().NewQuery(modCommentSelect + where + " ORDER BY c.created DESC,c.id DESC LIMIT {:limit}").Bind(params).All(&rows); err != nil {
			return c.InternalServerError("Could not load comments", err)
		}
		next := ""
		if len(rows) > modCommentPageSize {
			rows = rows[:modCommentPageSize]
			last := rows[len(rows)-1]
			next = encodeModCommentCursor(last.Created, last.ID)
		}
		_, notesErr := app.FindCollectionByNameOrId(commentNotesCollection)
		return c.JSON(http.StatusOK, map[string]any{"items": rows, "next": next, "notes_available": notesErr == nil})
	}))

	g.GET("/{id}/thread", secure(func(c *core.RequestEvent) error {
		target, err := app.FindRecordById("comments", c.Request.PathValue("id"))
		if err != nil {
			return c.NotFoundError("Comment not found", err)
		}
		root := target
		seen := map[string]bool{root.Id: true}
		// Walk only this game's ancestors; corrupt/cyclic legacy parents must not loop.
		for root.GetString("parent") != "" {
			parent, err := app.FindRecordById("comments", root.GetString("parent"))
			if err != nil || parent.GetString("game") != target.GetString("game") || seen[parent.Id] {
				break
			}
			seen[parent.Id] = true
			root = parent
		}
		params := dbx.Params{"root": root.Id, "game": root.GetString("game"), "limit": 101}
		where := " WHERE c.id IN (SELECT id FROM branch)"
		if raw := c.Request.URL.Query().Get("cursor"); raw != "" {
			cur, err := decodeModCommentCursor(raw)
			if err != nil || cur.Created == "" || cur.ID == "" {
				return c.BadRequestError("Invalid cursor", nil)
			}
			where += " AND (c.created > {:created} OR (c.created={:created} AND c.id > {:id}))"
			params["created"], params["id"] = cur.Created, cur.ID
		}
		// UNION (not UNION ALL) also terminates cycles.
		sql := `WITH RECURSIVE branch(id) AS (SELECT id FROM comments WHERE id={:root}
   UNION SELECT child.id FROM comments child JOIN branch b ON child.parent=b.id WHERE child.game={:game}) ` + modCommentSelect + where + " ORDER BY c.created,c.id LIMIT {:limit}"
		rows := []modCommentRow{}
		if err := app.DB().NewQuery(sql).Bind(params).All(&rows); err != nil {
			return c.InternalServerError("Could not load thread", err)
		}
		next := ""
		if len(rows) > 100 {
			rows = rows[:100]
			last := rows[len(rows)-1]
			next = encodeModCommentCursor(last.Created, last.ID)
		}
		return c.JSON(http.StatusOK, map[string]any{"items": rows, "next": next, "root": root.Id})
	}))

	g.GET("/notes", secure(func(c *core.RequestEvent) error {
		if _, err := app.FindCollectionByNameOrId(commentNotesCollection); err != nil {
			return c.JSON(http.StatusServiceUnavailable, map[string]string{"message": "Internal notes need the manual schema script."})
		}
		filter := "id != ''"
		params := dbx.Params{}
		if ids := c.Request.URL.Query().Get("anchors"); ids != "" {
			parts := strings.Split(ids, ",")
			if len(parts) > 100 {
				return c.BadRequestError("Too many anchors", nil)
			}
			clauses := []string{}
			for i, id := range parts {
				key := "a" + strconv.Itoa(i)
				clauses = append(clauses, "anchor = {:"+key+"}")
				params[key] = id
			}
			filter = "(" + strings.Join(clauses, " || ") + ")"
		}
		if raw := c.Request.URL.Query().Get("cursor"); raw != "" {
			cur, err := decodeModCommentCursor(raw)
			if err != nil || cur.Created == "" || cur.ID == "" {
				return c.BadRequestError("Invalid cursor", nil)
			}
			filter += " && (created < {:created} || (created = {:created} && id < {:id}))"
			params["created"], params["id"] = cur.Created, cur.ID
		}
		records, err := app.FindRecordsByFilter(commentNotesCollection, filter, "-created,-id", 101, 0, params)
		if err != nil {
			return c.InternalServerError("Could not load notes", err)
		}
		next := ""
		if len(records) > 100 {
			records = records[:100]
			last := records[len(records)-1]
			next = encodeModCommentCursor(last.GetString("created"), last.Id)
		}
		items := []map[string]any{}
		for _, r := range records {
			name := "Deleted moderator"
			if u, err := app.FindRecordById("users", r.GetString("author")); err == nil {
				name = u.GetString("name")
				if name == "" {
					name = u.GetString("username")
				}
			}
			items = append(items, map[string]any{"id": r.Id, "anchor": r.GetString("anchor"), "anchor_created": r.GetString("anchor_created"), "game": r.GetString("game"), "game_title": r.GetString("game_title"), "author": r.GetString("author"), "author_name": name, "content": r.GetString("content"), "kind": r.GetString("kind"), "scope": r.GetString("scope"), "created": r.GetString("created")})
		}
		return c.JSON(http.StatusOK, map[string]any{"items": items, "next": next})
	}))

	g.POST("/notes", secure(func(c *core.RequestEvent) error {
		var p struct {
			Anchor  string `json:"anchor"`
			Content string `json:"content"`
			Kind    string `json:"kind"`
			Scope   string `json:"scope"`
		}
		if err := c.BindBody(&p); err != nil {
			return c.BadRequestError("Invalid note", err)
		}
		p.Content = strings.TrimSpace(p.Content)
		if p.Content == "" || utf8.RuneCountInString(p.Content) > 4000 || utf8.RuneCountInString(p.Scope) > 1000 || (p.Kind != "note" && p.Kind != "checkpoint") {
			return c.BadRequestError("A note needs 1–4000 characters and a valid kind", nil)
		}
		anchor, err := app.FindRecordById("comments", p.Anchor)
		if err != nil {
			return c.NotFoundError("Anchor comment no longer exists; refresh the feed", err)
		}
		col, err := app.FindCollectionByNameOrId(commentNotesCollection)
		if err != nil {
			return c.JSON(http.StatusServiceUnavailable, map[string]string{"message": "Internal notes need the manual schema script."})
		}
		r := core.NewRecord(col)
		r.Set("anchor", anchor.Id)
		r.Set("anchor_created", anchor.GetString("created"))
		r.Set("game", anchor.GetString("game"))
		r.Set("author", c.Auth.Id)
		r.Set("content", p.Content)
		r.Set("kind", p.Kind)
		r.Set("scope", p.Scope)
		if game, err := app.FindRecordById("games", anchor.GetString("game")); err == nil {
			r.Set("game_title", game.GetString("title"))
		}
		if err := app.Save(r); err != nil {
			return c.InternalServerError("Could not save note", err)
		}
		return c.JSON(http.StatusOK, map[string]string{"id": r.Id})
	}))
}
