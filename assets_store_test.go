package main

import (
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Key scenario: a tab opened before a deploy requests a chunk of the previous build. It's gone from
// embed; the store must serve it or the page dies.
func TestOpenAssetFallsBackToStore(t *testing.T) {
	dist := fstest.MapFS{
		"assets/index-NEW.js": &fstest.MapFile{Data: []byte("new")},
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index-OLD.js"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { assetsStoreFS = nil })
	assetsStoreFS = os.DirFS(dir)

	for _, tc := range []struct {
		name, path, want string
	}{
		{"current build from embed", "index-NEW.js", "new"},
		{"retired build from store", "index-OLD.js", "old"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, err := openAsset(dist, tc.path)
			if err != nil {
				t.Fatalf("openAsset(%q): %v", tc.path, err)
			}
			defer f.Close()
			got, _ := io.ReadAll(f)
			if string(got) != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}

	if _, err := openAsset(dist, "nope.js"); err == nil {
		t.Fatal("unknown asset must still 404, not resolve")
	}
	if _, err := openAsset(dist, "../../etc/passwd"); err == nil {
		t.Fatal("traversal out of the store must fail")
	}
}

func TestOpenAssetWithoutStore(t *testing.T) {
	assetsStoreFS = nil
	dist := fstest.MapFS{"assets/a.js": &fstest.MapFile{Data: []byte("a")}}
	if _, err := openAsset(dist, "gone.js"); err == nil {
		t.Fatal("want error when there is no store")
	}
	f, err := openAsset(dist, "a.js")
	if err != nil {
		t.Fatalf("embedded asset must still resolve: %v", err)
	}
	f.Close()
}

// Build marker = entry bundle hash from index.html; it is the client's update signal.
func TestBuildAppBuild(t *testing.T) {
	var distDirFS fs.FS = fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte(
			`<html><head><link rel="stylesheet" crossorigin href="/assets/index-Cs5.css">` +
				`<script type="module" crossorigin src="/assets/index-SPwUMYlo.js"></script>` +
				`</head></html>`)},
	}
	if got := buildAppBuild(distDirFS); got != "index-SPwUMYlo.js" {
		t.Fatalf("got %q", got)
	}
	if got := buildAppBuild(fstest.MapFS{}); got != "" {
		t.Fatalf("want empty marker, got %q", got)
	}
}
