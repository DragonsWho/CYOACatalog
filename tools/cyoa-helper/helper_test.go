package main

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A small ICC-style site: the page loads app.js, app.js fetches project.json at runtime, the
// project lists images; a CSS pulls a font; the page carries a neocities toolbar and a
// root-absolute icon.
func fakeSite(t *testing.T) *httptest.Server {
	files := map[string]string{
		"/games/mygame/":                `<html><head><title>My Game</title><link rel="stylesheet" href="css/style.css"><link rel="icon" href="/games/mygame/icon.png"></head><body><div id="app"></div><script src="js/app.js"></script><script src="https://neocities.org/js/site.js"></script></body></html>`,
		"/games/mygame/css/style.css":   `@font-face{font-family:x;src:url("../fonts/a.woff2")} body{background:url(../img/bg.png)}`,
		"/games/mygame/js/app.js":       `var isEditModeOnAll=false; var pointTypes=[]; fetch("project.json").then(r=>r.json())`,
		"/games/mygame/project.json":    `{"rows":[{"image":"images/row1.png","objects":[{"image":"images/obj1.webp"}]}],"pointTypes":[],"backPackRows":[]}`,
		"/games/mygame/images/row1.png": "PNG",
		"/games/mygame/images/obj1.webp": "WEBP",
		"/games/mygame/fonts/a.woff2":   "FONT",
		"/games/mygame/img/bg.png":      "PNG",
		"/games/mygame/icon.png":        "PNG",
		"/games/other/":                 `<html>other game</html>`,
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/"):
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		case strings.HasSuffix(r.URL.Path, ".json"):
			w.Header().Set("Content-Type", "application/json")
		case strings.HasSuffix(r.URL.Path, ".js"):
			w.Header().Set("Content-Type", "text/javascript")
		case strings.HasSuffix(r.URL.Path, ".css"):
			w.Header().Set("Content-Type", "text/css")
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		_, _ = w.Write([]byte(body))
	}))
}

func TestCrawlCheckPack(t *testing.T) {
	testAllowLoopback = true
	defer func() { testAllowLoopback = false }()
	srv := fakeSite(t)
	defer srv.Close()

	ws := &Workspace{Root: t.TempDir()}
	it, err := ws.NewItem("mygame", srv.URL+"/games/mygame/")
	if err != nil {
		t.Fatal(err)
	}
	cr, err := NewCrawler(context.Background(), srv.URL+"/games/mygame/", it.GameDir(), t.Logf, nil)
	if err != nil {
		t.Fatal(err)
	}
	st, err := cr.Run()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"index.html", "css/style.css", "js/app.js", "project.json", "images/row1.png",
		"images/obj1.webp", "fonts/a.woff2", "img/bg.png", "icon.png"} {
		if !isFile(filepath.Join(it.GameDir(), filepath.FromSlash(f))) {
			t.Errorf("missing %s", f)
		}
	}
	if isFile(filepath.Join(it.GameDir(), "other", "index.html")) {
		t.Errorf("crawled a sibling game")
	}
	idx, _ := os.ReadFile(filepath.Join(it.GameDir(), "index.html"))
	if strings.Contains(string(idx), "neocities.org/js/site.js") {
		t.Errorf("platform inject not stripped")
	}
	if strings.Contains(string(idx), `"/games/mygame/icon.png"`) {
		t.Errorf("root-absolute icon not rewritten: %s", idx)
	}
	if st.ProjectJSON == "" {
		t.Errorf("project.json not detected")
	}

	rep := checkGame(it, st)
	if rep.Verdict != "ok" || rep.Engine != "icc" || rep.MissingCount != 0 || !rep.HasIndex {
		t.Errorf("report: %+v", rep)
	}
	if rep.Title != "My Game" {
		t.Errorf("title %q", rep.Title)
	}

	plan, err := planPack(it.GameDir())
	if err != nil || len(plan.Parts) != 1 {
		t.Fatalf("plan: %v %+v", err, plan)
	}
	if plan.Parts[0][0].rel != "index.html" {
		t.Errorf("index.html not first")
	}
	data, err := buildZip(plan.Parts[0])
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(zr.File) != plan.Files {
		t.Errorf("zip: %v, %d files", err, len(zr.File))
	}
}

func TestCheckFlagsICCWithoutData(t *testing.T) {
	ws := &Workspace{Root: t.TempDir()}
	it, _ := ws.NewItem("broken", "")
	g := it.GameDir()
	_ = os.WriteFile(filepath.Join(g, "index.html"), []byte(`<script src="app.js"></script>`), 0o644)
	_ = os.WriteFile(filepath.Join(g, "app.js"), []byte(`isEditModeOnAll pointTypes backPackRows fetch("project.json")`), 0o644)
	rep := checkGame(it, nil)
	if rep.Verdict != "bad" {
		t.Errorf("want bad, got %+v", rep)
	}
}

func TestRefusesPrivateAddresses(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1/", "http://localhost/x", "http://10.0.0.5/", "http://[::1]/", "file:///etc/passwd"} {
		if _, err := checkPublicURL(u); err == nil {
			t.Errorf("%s accepted", u)
		}
	}
	if _, err := checkPublicURL("https://example.neocities.org/game/"); err != nil {
		t.Error(err)
	}
}

func TestSanitizeAndUnzipSlip(t *testing.T) {
	if got := sanitizeRelPath("../../etc/con.txt"); got != "etc/_con.txt" {
		t.Errorf("sanitize: %q", got)
	}
	dir := t.TempDir()
	zp := filepath.Join(dir, "evil.zip")
	f, _ := os.Create(zp)
	zw := zip.NewWriter(f)
	w, _ := zw.Create("../../escape.txt")
	_, _ = w.Write([]byte("x"))
	w, _ = zw.Create("Game/index.html")
	_, _ = w.Write([]byte("<html></html>"))
	_ = zw.Close()
	_ = f.Close()
	ws := &Workspace{Root: filepath.Join(dir, "ws")}
	it, err := ws.ImportPath(zp, "", "", t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	if isFile(filepath.Join(dir, "escape.txt")) || isFile(filepath.Join(ws.Root, "escape.txt")) {
		t.Fatal("zip slip")
	}
	if !isFile(filepath.Join(it.GameDir(), "index.html")) {
		// single top folder is only unwrapped when it's the only thing at the root
		if !isFile(filepath.Join(it.GameDir(), "Game", "index.html")) {
			t.Errorf("index.html not imported")
		}
	}
}

func TestRewriteLongestFirst(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "a.js"), []byte(`x("https://cdn.x.com/lib/a.png"); y("lib/a.png")`), 0o644)
	n := rewriteURLsInTree(dir, map[string]string{
		"https://cdn.x.com/lib/a.png": "./external/cdn.x.com/lib/a.png",
		"lib/a.png":                   "./lib/a.png",
	})
	b, _ := os.ReadFile(filepath.Join(dir, "a.js"))
	if n != 1 || string(b) != `x("./external/cdn.x.com/lib/a.png"); y("./lib/a.png")` {
		t.Errorf("got %s", b)
	}
}
