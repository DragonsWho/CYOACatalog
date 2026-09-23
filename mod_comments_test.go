package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// In-memory SQL fixture only — no PocketBase bootstrap, data dir, live collection, migrations or
// startup hooks.
type modCommentsTestApp struct {
	core.App
	db              *dbx.DB
	records         map[string]*core.Record
	permission      *core.Record
	notesCollection *core.Collection
	saved           *core.Record
}

func (a *modCommentsTestApp) DB() dbx.Builder { return a.db }
func (a *modCommentsTestApp) FindCollectionByNameOrId(s string) (*core.Collection, error) {
	if s == commentNotesCollection && a.notesCollection != nil {
		return a.notesCollection, nil
	}
	return nil, errors.New("not installed")
}
func (a *modCommentsTestApp) FindRecordById(collection any, id string, filters ...func(*dbx.SelectQuery) error) (*core.Record, error) {
	if r := a.records[id]; r != nil {
		return r, nil
	}
	return nil, errors.New("missing")
}
func (a *modCommentsTestApp) FindFirstRecordByFilter(collection any, filter string, params ...dbx.Params) (*core.Record, error) {
	if a.permission != nil {
		return a.permission, nil
	}
	return nil, errors.New("no explicit permissions")
}
func (a *modCommentsTestApp) Save(model core.Model) error {
	r, ok := model.(*core.Record)
	if !ok {
		return errors.New("schema writes forbidden in tests")
	}
	a.saved = r
	return nil
}
func modCommentsFixture(t *testing.T) (*modCommentsTestApp, *core.Record) {
	t.Helper()
	db, err := dbx.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.DB().SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	for _, sql := range []string{
		`CREATE TABLE comments (id TEXT PRIMARY KEY,content TEXT,created TEXT,updated TEXT,parent TEXT,game TEXT,author TEXT,deleted INTEGER DEFAULT 0,pinned INTEGER DEFAULT 0)`,
		`CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT,username TEXT)`,
		`CREATE TABLE games (id TEXT PRIMARY KEY,title TEXT,slug TEXT)`,
		`INSERT INTO games VALUES ('game1','Test game','test-game'),('game2','Other game','other-game')`,
		`INSERT INTO users VALUES ('user1','Reviewer','reviewer')`,
	} {
		if _, err := db.NewQuery(sql).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	a := &modCommentsTestApp{db: db, records: map[string]*core.Record{}}
	users := core.NewAuthCollection("users")
	users.Fields.Add(&core.BoolField{Name: "isModerator"})
	auth := core.NewRecord(users)
	auth.Id = "user1"
	auth.Set("isModerator", true)
	old := modPermApp
	modPermApp = a
	t.Cleanup(func() { modPermApp = old })
	return a, auth
}
func addModComment(t *testing.T, a *modCommentsTestApp, id, parent, game, content, created string) {
	t.Helper()
	_, err := a.db.NewQuery(`INSERT INTO comments(id,parent,game,content,created,updated,author) VALUES({:id},{:p},{:g},{:c},{:date},{:date},'user1')`).Bind(dbx.Params{"id": id, "p": parent, "g": game, "c": content, "date": created}).Execute()
	if err != nil {
		t.Fatal(err)
	}
	col := core.NewBaseCollection("comments")
	col.Fields.Add(&core.TextField{Name: "parent"}, &core.TextField{Name: "game"})
	r := core.NewRecord(col)
	r.Id = id
	r.Set("parent", parent)
	r.Set("game", game)
	a.records[id] = r
}
func callModComments(t *testing.T, a *modCommentsTestApp, auth *core.Record, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := router.NewRouter(func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		e := &core.RequestEvent{App: a, Auth: auth}
		e.Request = req
		e.Response = w
		return e, nil
	})
	registerModCommentRoutes(a, &core.ServeEvent{App: a, Router: r})
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, "/api/custom/mod/comments"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	return out
}
func modPage(t *testing.T, r *httptest.ResponseRecorder) ([]modCommentRow, string) {
	t.Helper()
	if r.Code != 200 {
		t.Fatalf("status %d: %s", r.Code, r.Body.String())
	}
	var p struct {
		Items []modCommentRow `json:"items"`
		Next  string          `json:"next"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	return p.Items, p.Next
}
func TestModCommentsPrivateEndpoints(t *testing.T) {
	a, auth := modCommentsFixture(t)
	for _, endpoint := range []struct{ method, path, body string }{{"GET", "", ""}, {"GET", "/notes", ""}, {"GET", "/x/thread", ""}, {"POST", "/notes", `{"anchor":"x","content":"private","kind":"note"}`}} {
		for _, identity := range []string{"anonymous", "member", "restricted"} {
			var user *core.Record
			if identity != "anonymous" {
				user = auth
				user.Set("isModerator", identity == "restricted")
			}
			a.permission = nil
			if identity == "restricted" {
				col := core.NewBaseCollection("permissions")
				col.Fields.Add(&core.JSONField{Name: "perms"})
				a.permission = core.NewRecord(col)
				a.permission.Set("perms", []string{"tickets"})
			}
			res := callModComments(t, a, user, endpoint.method, endpoint.path, endpoint.body)
			if res.Code != 401 && res.Code != 403 {
				t.Fatalf("%s %s %s allowed: %d", identity, endpoint.method, endpoint.path, res.Code)
			}
		}
	}
}
func TestModCommentsCursorFiltersAndProjection(t *testing.T) {
	a, auth := modCommentsFixture(t)
	for i := 0; i < 45; i++ {
		addModComment(t, a, fmt.Sprintf("c%03d", i), "", "game1", "ordinary comment", "2026-09-18 10:00:00.000Z")
	}
	addModComment(t, a, "build", "", "game2", `{"cyoaBuild":1}`, "2026-09-18 11:00:00.000Z")
	addModComment(t, a, "reply", "c044", "game1", "100% literal_match", "2026-09-18 12:00:00.000Z")
	res := callModComments(t, a, auth, "GET", "?type=comments", "")
	rows, next := modPage(t, res)
	if len(rows) != 40 || rows[0].ID != "reply" || rows[1].Replies != 1 || next == "" {
		t.Fatalf("bad page: %+v %q", rows, next)
	}
	if res.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal("private response cacheable")
	}
	if strings.Contains(res.Body.String(), "email") || strings.Contains(res.Body.String(), "expand") {
		t.Fatal("unexpected user data")
	}
	addModComment(t, a, "new", "", "game1", "new", "2026-09-18 13:00:00.000Z")
	more, end := modPage(t, callModComments(t, a, auth, "GET", "?type=comments&cursor="+url.QueryEscape(next), ""))
	if len(more) != 6 || end != "" || more[0].ID == rows[len(rows)-1].ID {
		t.Fatalf("unstable pagination: %+v", more)
	}
	for _, tc := range []struct {
		query string
		count int
	}{{"type=builds", 1}, {"replies=yes", 1}, {"q=" + url.QueryEscape("100% literal_"), 1}, {"q=" + url.QueryEscape("' OR 1=1 --"), 0}, {"game=game2", 1}} {
		got, _ := modPage(t, callModComments(t, a, auth, "GET", "?"+tc.query, ""))
		if len(got) != tc.count {
			t.Fatalf("filter %s returned %d", tc.query, len(got))
		}
	}
	if res := callModComments(t, a, auth, "GET", "?cursor=broken", ""); res.Code != 400 {
		t.Fatal("bad cursor accepted")
	}
}
func TestModCommentsThreadFullBranchAndCycle(t *testing.T) {
	a, auth := modCommentsFixture(t)
	addModComment(t, a, "root", "", "game1", "root", "2026-09-18 09:00:00.000Z")
	for i := 0; i < 105; i++ {
		addModComment(t, a, fmt.Sprintf("r%03d", i), "root", "game1", "reply", "2026-09-18 10:00:00.000Z")
	}
	addModComment(t, a, "unrelated", "", "game1", "other root", "2026-09-18 08:00:00.000Z")
	addModComment(t, a, "badgame", "root", "game2", "bad legacy relation", "2026-09-18 10:00:00.000Z")
	rows, next := modPage(t, callModComments(t, a, auth, "GET", "/r050/thread", ""))
	if len(rows) != 100 || rows[0].ID != "root" || next == "" {
		t.Fatal("missing thread context")
	}
	more, end := modPage(t, callModComments(t, a, auth, "GET", "/r050/thread?cursor="+url.QueryEscape(next), ""))
	if len(more) != 6 || end != "" {
		t.Fatal("thread truncated")
	}
	addModComment(t, a, "cycle1", "cycle2", "game1", "cycle", "2026-09-18 10:00:00.000Z")
	addModComment(t, a, "cycle2", "cycle1", "game1", "cycle", "2026-09-18 10:00:00.000Z")
	rows, _ = modPage(t, callModComments(t, a, auth, "GET", "/cycle1/thread", ""))
	if len(rows) != 2 {
		t.Fatal("cycle lost records")
	}
}
func TestModCommentsMissingNotesSchema(t *testing.T) {
	a, auth := modCommentsFixture(t)
	res := callModComments(t, a, auth, "GET", "", "")
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"notes_available":false`) {
		t.Fatal("feed must work without notes schema")
	}
	res = callModComments(t, a, auth, "GET", "/notes", "")
	if res.Code != 503 {
		t.Fatalf("missing schema status: %d", res.Code)
	}
}

func TestModCommentsNoteAttributionAndValidation(t *testing.T) {
	a, auth := modCommentsFixture(t)
	addModComment(t, a, "anchor", "", "game1", "body", "2026-09-18 10:00:00.000Z")
	a.records["anchor"].Set("created", "2026-09-18 10:00:00.000Z")
	col := core.NewBaseCollection(commentNotesCollection)
	for _, name := range []string{"anchor", "anchor_created", "game", "game_title", "author", "content", "kind", "scope"} {
		col.Fields.Add(&core.TextField{Name: name})
	}
	a.notesCollection = col
	res := callModComments(t, a, auth, "POST", "/notes", `{"anchor":"anchor","kind":"checkpoint","content":"  Checked!  ","scope":"comments only","author":"forged","game":"forged","anchor_created":"forged"}`)
	if res.Code != 200 {
		t.Fatalf("save: %d %s", res.Code, res.Body.String())
	}
	if a.saved.GetString("author") != auth.Id || a.saved.GetString("game") != "game1" || a.saved.GetString("content") != "Checked!" || a.saved.GetString("anchor_created") != "2026-09-18 10:00:00.000Z" {
		t.Fatalf("untrusted attribution: %+v", a.saved)
	}
	for _, body := range []string{`{"anchor":"anchor","kind":"note","content":" "}`, `{"anchor":"anchor","kind":"public","content":"note"}`, `{"anchor":"anchor","kind":"note","content":"` + strings.Repeat("я", 4001) + `"}`} {
		a.saved = nil
		res := callModComments(t, a, auth, "POST", "/notes", body)
		if res.Code != 400 || a.saved != nil {
			t.Fatal("invalid note saved")
		}
	}
	a.saved = nil
	res = callModComments(t, a, auth, "POST", "/notes", `{"anchor":"missing","kind":"note","content":"note"}`)
	if res.Code != 404 || a.saved != nil {
		t.Fatal("missing anchor accepted")
	}
}
