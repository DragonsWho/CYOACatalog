// Post-download fixes that make a rip work from a subfolder of cyoa.cafe hosting (port of the
// pipeline's utils/rewriter.py): absolute/foreign URLs → local paths, "../" refs that escape the
// game folder, root-absolute "/x.png" refs, root-absolute ES-module imports, and scripts that the
// source hosting platform injected into every page.
package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const rewriteChunk = 400 // keys per regexp; one giant alternation can exceed RE2 limits

var (
	// ES import/export specifiers resolve relative to the importing module, not the page.
	jsImportCtxRe = regexp.MustCompile(`(?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\s+(?:\*|\{[^}]*\})\s*from\s*)['"]$`)

	platformInjectPatterns = []string{
		`/\.nekoweb-api/`,
		`static\.itch\.io/htmlgame\.js`,
		`neocities\.org/js/site\.js`,
		`static\.cloudflareinsights\.com/beacon`,
		`statistics-for-interactive-cyoa\.pages\.dev`,
	}
	platformInjectRefRe = regexp.MustCompile(`(?i)` + strings.Join(platformInjectPatterns, "|"))
	platformInjectTagRe = regexp.MustCompile(`(?i)<script\b[^>]*\bsrc\s*=\s*['"]?[^'">]*(?:` +
		strings.Join(platformInjectPatterns, "|") + `)[^'">]*['"]?[^>]*>\s*</script>`)
	orphanTrackerCallRe = regexp.MustCompile(`(?is)<script\b[^>]*>\s*initializeLogging\s*\([^)]*\)\s*;?\s*</script>`)
	scriptHasSrcRe      = regexp.MustCompile(`(?i)<script\b[^>]*\bsrc\s*=`)

	escapingRefRe = regexp.MustCompile(`(?:\.\./)+[\w\-./@%]+\.\w+`)
	// Root-absolute file ref after a quote or "(" — RE2 has no lookbehind, so the opener is captured.
	rootAbsRefRe = regexp.MustCompile(`(["'(])(/[\w\-./@%]+\.\w+(?:[?#][^"')\s]*)?)`)
	jsModuleSpec = regexp.MustCompile(`(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(/[\w\-./@%]+\.\w+)['"]`)
)

func isPlatformInject(ref string) bool { return platformInjectRefRe.MatchString(ref) }

func walkFiles(root string, exts map[string]bool, fn func(p string)) {
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if exts == nil || exts[strings.ToLower(filepath.Ext(p))] {
			fn(p)
		}
		return nil
	})
}

// relFromTo: path from a root-relative directory to a root-relative file, always "./"- or "../"-led.
func relFromTo(fromDir, to string) string {
	fromDir = filepath.ToSlash(fromDir)
	if fromDir == "." || fromDir == "" {
		return "./" + to
	}
	r, err := filepath.Rel(filepath.FromSlash(fromDir), filepath.FromSlash(to))
	if err != nil {
		return "./" + to
	}
	r = filepath.ToSlash(r)
	if !strings.HasPrefix(r, ".") {
		r = "./" + r
	}
	return r
}

type span struct {
	start, end int
	key        string
}

// rewriteURLsInTree replaces every original reference in text files with a local path. Values of
// urlMap are "./rel/path" relative to root. Longest key wins at each position.
func rewriteURLsInTree(root string, urlMap map[string]string) int {
	if len(urlMap) == 0 {
		return 0
	}
	clean := make(map[string]string, len(urlMap))
	keys := make([]string, 0, len(urlMap))
	for k, v := range urlMap {
		if k == "" {
			continue
		}
		for strings.HasPrefix(v, "./") {
			v = v[2:]
		}
		clean[k] = strings.TrimLeft(v, "/")
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) || len(keys[i]) == len(keys[j]) && keys[i] < keys[j] })
	var res []*regexp.Regexp
	for i := 0; i < len(keys); i += rewriteChunk {
		end := min(i+rewriteChunk, len(keys))
		parts := make([]string, 0, end-i)
		for _, k := range keys[i:end] {
			parts = append(parts, regexp.QuoteMeta(k))
		}
		res = append(res, regexp.MustCompile(strings.Join(parts, "|")))
	}
	modified := 0
	walkFiles(root, textExt, func(p string) {
		data, err := os.ReadFile(p)
		if err != nil {
			return
		}
		text := string(data)
		var spans []span
		for _, re := range res {
			for _, m := range re.FindAllStringIndex(text, -1) {
				spans = append(spans, span{m[0], m[1], text[m[0]:m[1]]})
			}
		}
		if len(spans) == 0 {
			return
		}
		sort.Slice(spans, func(i, j int) bool {
			if spans[i].start != spans[j].start {
				return spans[i].start < spans[j].start
			}
			return spans[i].end > spans[j].end
		})
		relFile, _ := filepath.Rel(root, p)
		fileDir := filepath.ToSlash(filepath.Dir(relFile))
		ext := strings.ToLower(filepath.Ext(p))
		// CSS url() and HTML href/src resolve against the document's own folder; JS/JSON refs run in
		// the page context (publicPath, fetch) and stay root-relative.
		perFile := ext == ".css" || ext == ".html" || ext == ".htm"
		var b strings.Builder
		last := 0
		for _, s := range spans {
			if s.start < last {
				continue
			}
			target := clean[s.key]
			isImport := false
			if ext == ".js" || ext == ".mjs" {
				isImport = jsImportCtxRe.MatchString(text[max(0, s.start-24):s.start])
			}
			b.WriteString(text[last:s.start])
			if perFile || isImport {
				b.WriteString(relFromTo(fileDir, target))
			} else {
				b.WriteString("./" + target)
			}
			last = s.end
		}
		b.WriteString(text[last:])
		if out := b.String(); out != text {
			if os.WriteFile(p, []byte(out), 0o644) == nil {
				modified++
			}
		}
	})
	return modified
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func splitQuery(ref string) (bare, qf string) {
	if i := strings.IndexAny(ref, "?#"); i >= 0 {
		return ref[:i], ref[i:]
	}
	return ref, ""
}

// normalizeEscapingRefs fixes HTML refs that climb out of the game folder ("../js/app.js" left by a
// half-converted rip) or start at the domain root ("/icon.png") when the file does exist inside the
// rip. Returns files modified and refs that could not be resolved.
func normalizeEscapingRefs(root string) (int, []string) {
	absRoot, _ := filepath.Abs(root)
	modified := 0
	var unresolved []string
	seen := map[string]bool{}
	walkFiles(root, setOf(".html", ".htm"), func(p string) {
		data, err := os.ReadFile(p)
		if err != nil {
			return
		}
		text := string(data)
		fileDir := filepath.Dir(p)
		toRel := func(cand string) string {
			r, err := filepath.Rel(fileDir, cand)
			if err != nil {
				return ""
			}
			r = filepath.ToSlash(r)
			if !strings.HasPrefix(r, ".") {
				r = "./" + r
			}
			return r
		}
		stage := rootAbsRefRe.ReplaceAllStringFunc(text, func(m string) string {
			opener, ref := m[:1], m[1:]
			bare, qf := splitQuery(ref)
			cand := filepath.Join(root, filepath.FromSlash(strings.TrimLeft(bare, "/")))
			if !isFile(cand) {
				return m
			}
			if r := toRel(cand); r != "" {
				return opener + r + qf
			}
			return m
		})
		out := escapingRefRe.ReplaceAllStringFunc(stage, func(ref string) string {
			bare, qf := splitQuery(ref)
			resolved, _ := filepath.Abs(filepath.Join(fileDir, filepath.FromSlash(bare)))
			if r, err := filepath.Rel(absRoot, resolved); err == nil && !strings.HasPrefix(r, "..") {
				return ref
			}
			tail := bare
			for strings.HasPrefix(tail, "../") {
				tail = tail[3:]
				cand := filepath.Join(root, filepath.FromSlash(tail))
				if isFile(cand) {
					if r := toRel(cand); r != "" {
						return r + qf
					}
				}
			}
			if !seen[ref] {
				seen[ref] = true
				unresolved = append(unresolved, ref)
			}
			return ref
		})
		if out != text && os.WriteFile(p, []byte(out), 0o644) == nil {
			modified++
		}
	})
	return modified, unresolved
}

// resolveJSModuleSpecifiers: `import x from "/src/a.js"` only works at a domain root; our hosting
// serves games from a subfolder, so the whole module graph 404s. Rewritten only when the file exists.
func resolveJSModuleSpecifiers(root string) (int, []string) {
	modified := 0
	var unresolved []string
	seen := map[string]bool{}
	walkFiles(root, setOf(".js", ".mjs"), func(p string) {
		data, err := os.ReadFile(p)
		if err != nil {
			return
		}
		text := string(data)
		fileDir := filepath.Dir(p)
		var b strings.Builder
		last := 0
		for _, m := range jsModuleSpec.FindAllStringSubmatchIndex(text, -1) {
			spec := text[m[4]:m[5]]
			cand := filepath.Join(root, filepath.FromSlash(strings.TrimLeft(spec, "/")))
			if !isFile(cand) {
				if !seen[spec] {
					seen[spec] = true
					unresolved = append(unresolved, spec)
				}
				continue
			}
			r, err := filepath.Rel(fileDir, cand)
			if err != nil {
				continue
			}
			r = filepath.ToSlash(r)
			if !strings.HasPrefix(r, ".") {
				r = "./" + r
			}
			b.WriteString(text[last:m[4]])
			b.WriteString(r)
			last = m[5]
		}
		if last == 0 {
			return
		}
		b.WriteString(text[last:])
		if os.WriteFile(p, []byte(b.String()), 0o644) == nil {
			modified++
		}
	})
	return modified, unresolved
}

// stripPlatformInjects removes host-platform scripts (itch anti-hotlink, nekoweb/neocities toolbars,
// Cloudflare beacon, the SSSICYOA tracker and its orphaned init call).
func stripPlatformInjects(root string) int {
	modified := 0
	walkFiles(root, setOf(".html", ".htm"), func(p string) {
		data, err := os.ReadFile(p)
		if err != nil {
			return
		}
		text := string(data)
		out := platformInjectTagRe.ReplaceAllString(text, "")
		if out == text {
			return
		}
		out = orphanTrackerCallRe.ReplaceAllStringFunc(out, func(tag string) string {
			if scriptHasSrcRe.MatchString(tag) {
				return tag
			}
			return ""
		})
		if os.WriteFile(p, []byte(out), 0o644) == nil {
			modified++
		}
	})
	return modified
}

// fixForHosting runs the folder-level repairs used after a download and after an import.
func fixForHosting(root string, logf func(string, ...any)) (unresolved []string) {
	if n, u := normalizeEscapingRefs(root); n > 0 || len(u) > 0 {
		if n > 0 {
			logf("fixed folder-escaping / root-absolute links in %d page(s)", n)
		}
		unresolved = append(unresolved, u...)
	}
	if n, _ := resolveJSModuleSpecifiers(root); n > 0 {
		logf("fixed root-absolute JS imports in %d file(s)", n)
	}
	if n := stripPlatformInjects(root); n > 0 {
		logf("removed hosting-platform scripts from %d page(s)", n)
	}
	return unresolved
}
