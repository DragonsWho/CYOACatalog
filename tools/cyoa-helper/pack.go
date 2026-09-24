// Packing for hosting upload: zip parts of at most ~40 MB each (Cloudflare cuts request bodies at
// 100 MB), index.html in part 0, only file types hosting accepts.
package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const partTarget = 40 << 20

// Files that are already compressed are stored, not deflated (saves CPU, same size).
var storedExt = union(imageExt, mediaExt, setOf(".woff", ".woff2", ".wasm"))

type packFile struct {
	rel  string
	abs  string
	size int64
}

type packPlan struct {
	Parts   [][]packFile
	Skipped []string
	Files   int
	Bytes   int64
}

func planPack(root string) (*packPlan, error) {
	var files []packFile
	pl := &packPlan{}
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if strings.Contains(rel, "..") || !hostingAllowedExt[strings.ToLower(filepath.Ext(rel))] {
			pl.Skipped = append(pl.Skipped, rel)
			return nil
		}
		st, err := d.Info()
		if err != nil {
			return err
		}
		files = append(files, packFile{rel, p, st.Size()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool {
		if (files[i].rel == "index.html") != (files[j].rel == "index.html") {
			return files[i].rel == "index.html"
		}
		return files[i].rel < files[j].rel
	})
	var cur []packFile
	var curSize int64
	for _, f := range files {
		if len(cur) > 0 && curSize+f.size > partTarget {
			pl.Parts = append(pl.Parts, cur)
			cur, curSize = nil, 0
		}
		cur = append(cur, f)
		curSize += f.size
		pl.Files++
		pl.Bytes += f.size
	}
	if len(cur) > 0 {
		pl.Parts = append(pl.Parts, cur)
	}
	return pl, nil
}

func buildZip(files []packFile) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(w, 6)
	})
	for _, f := range files {
		method := zip.Deflate
		if storedExt[strings.ToLower(filepath.Ext(f.rel))] {
			method = zip.Store
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: f.rel, Method: method})
		if err != nil {
			return nil, err
		}
		in, err := os.Open(f.abs)
		if err != nil {
			return nil, err
		}
		_, err = io.Copy(w, in)
		in.Close()
		if err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
