// Workspace: every game the helper handles lives in <workspace>/items/<id>/ — game/ holds the files,
// item.json the metadata. The website refers to games only by item id, never by a local path.
package main

import (
	"archive/zip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var itemIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,79}$`)

type Item struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	SourceURL string       `json:"source_url,omitempty"`
	Created   time.Time    `json:"created"`
	Report    *CheckReport `json:"report,omitempty"`
	dir       string
}

func (it *Item) GameDir() string { return filepath.Join(it.dir, "game") }
func (it *Item) Dir() string     { return it.dir }

func (it *Item) Save() error {
	b, _ := json.MarshalIndent(it, "", "  ")
	tmp := filepath.Join(it.dir, "item.json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(it.dir, "item.json"))
}

type Workspace struct{ Root string }

func (w *Workspace) itemsDir() string { return filepath.Join(w.Root, "items") }

func randomSuffix(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}

func (w *Workspace) NewItem(name, sourceURL string) (*Item, error) {
	base := slugify(name)
	if len(base) > 50 {
		base = strings.Trim(base[:50], "-")
	}
	if base == "" {
		base = "game"
	}
	for i := 0; i < 20; i++ {
		id := base + "-" + randomSuffix(4)
		dir := filepath.Join(w.itemsDir(), id)
		if _, err := os.Stat(dir); err == nil {
			continue
		}
		if err := os.MkdirAll(filepath.Join(dir, "game"), 0o755); err != nil {
			return nil, err
		}
		it := &Item{ID: id, Name: name, SourceURL: sourceURL, Created: time.Now().UTC(), dir: dir}
		return it, it.Save()
	}
	return nil, errors.New("could not create a workspace folder")
}

func (w *Workspace) Get(id string) (*Item, error) {
	if !itemIDRe.MatchString(id) {
		return nil, fmt.Errorf("bad item id %q", id)
	}
	dir := filepath.Join(w.itemsDir(), id)
	b, err := os.ReadFile(filepath.Join(dir, "item.json"))
	if err != nil {
		return nil, fmt.Errorf("game %s is not in this computer's workspace (deleted?)", id)
	}
	var it Item
	if err := json.Unmarshal(b, &it); err != nil {
		return nil, err
	}
	it.ID, it.dir = id, dir
	return &it, nil
}

func (w *Workspace) List() []*Item {
	ents, _ := os.ReadDir(w.itemsDir())
	var out []*Item
	for _, e := range ents {
		if e.IsDir() {
			if it, err := w.Get(e.Name()); err == nil {
				out = append(out, it)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out
}

func (w *Workspace) Delete(id string) error {
	if !itemIDRe.MatchString(id) {
		return fmt.Errorf("bad item id %q", id)
	}
	return os.RemoveAll(filepath.Join(w.itemsDir(), id))
}

// singleTopDir: a zip or folder that wraps everything in one directory ("MyGame/index.html") is
// unwrapped so index.html ends up at the top.
func singleTopDir(dir string) string {
	for depth := 0; depth < 3; depth++ {
		if isFile(filepath.Join(dir, "index.html")) {
			return dir
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			return dir
		}
		var dirs []os.DirEntry
		files := 0
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".") || e.Name() == "__MACOSX" {
				continue
			}
			if e.IsDir() {
				dirs = append(dirs, e)
			} else {
				files++
			}
		}
		if files > 0 || len(dirs) != 1 {
			return dir
		}
		dir = filepath.Join(dir, dirs[0].Name())
	}
	return dir
}

func copyTree(src, dst string) (int, error) {
	n := 0
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if d.Type()&os.ModeSymlink != 0 {
			return nil // never follow links out of the game folder
		}
		if d.IsDir() {
			if d.Name() == "__MACOSX" || d.Name() == ".git" {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		if err := copyFile(p, filepath.Join(dst, rel)); err != nil {
			return err
		}
		n++
		return nil
	})
	return n, err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

const maxUnzipBytes = 3 << 30

func unzipTo(zipPath, dst string) (int, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0, fmt.Errorf("not a valid zip: %w", err)
	}
	defer zr.Close()
	var total int64
	n := 0
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || f.Mode()&os.ModeSymlink != 0 {
			continue
		}
		rel := sanitizeRelPath(f.Name) // drops "..", absolute roots and illegal names
		if rel == "" || strings.HasPrefix(rel, "__MACOSX/") {
			continue
		}
		total += int64(f.UncompressedSize64)
		if total > maxUnzipBytes {
			return n, errors.New("the zip unpacks to more than 3 GB")
		}
		rc, err := f.Open()
		if err != nil {
			return n, err
		}
		target := filepath.Join(dst, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(target), 0o755)
		out, err := os.Create(target)
		if err != nil {
			rc.Close()
			return n, err
		}
		_, err = io.Copy(out, io.LimitReader(rc, int64(f.UncompressedSize64)+1))
		rc.Close()
		out.Close()
		if err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// ImportPath copies a folder or unpacks a .zip into a new workspace item.
func (w *Workspace) ImportPath(src, name, sourceURL string, logf func(string, ...any)) (*Item, error) {
	st, err := os.Stat(src)
	if err != nil {
		return nil, fmt.Errorf("can't open %s", src)
	}
	if name == "" {
		name = strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
	}
	it, err := w.NewItem(name, sourceURL)
	if err != nil {
		return nil, err
	}
	fail := func(e error) (*Item, error) { _ = w.Delete(it.ID); return nil, e }
	game := it.GameDir()
	switch {
	case st.IsDir():
		top := singleTopDir(src)
		logf("copying %s", top)
		n, err := copyTree(top, game)
		if err != nil {
			return fail(err)
		}
		logf("copied %d file(s)", n)
	case strings.EqualFold(filepath.Ext(src), ".zip"):
		tmp := filepath.Join(it.Dir(), "unzip")
		logf("unpacking %s", src)
		n, err := unzipTo(src, tmp)
		if err != nil {
			return fail(err)
		}
		top := singleTopDir(tmp)
		_ = os.RemoveAll(game)
		if err := os.Rename(top, game); err != nil {
			if _, err := copyTree(top, game); err != nil {
				return fail(err)
			}
		}
		_ = os.RemoveAll(tmp)
		logf("unpacked %d file(s)", n)
	default:
		return fail(errors.New("pick a folder or a .zip file"))
	}
	return it, nil
}
