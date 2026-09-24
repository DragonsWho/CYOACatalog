// Game folder check: is everything the game references actually in the folder, does it depend on
// other sites, will it work from a subfolder of cyoa.cafe hosting. Port of the pipeline's
// utils/asset_audit.py plus the hosting gates of s06.
package main

import (
	"html"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Same list as hosting.go allowedExtensions: anything else is refused by the server.
var hostingAllowedExt = setOf(".html", ".htm", ".css", ".js", ".json", ".xml", ".svg", ".txt",
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot",
	".mp3", ".ogg", ".wav", ".mp4", ".webm", ".wasm", ".map", ".avif", ".m4a", ".aac", ".opus", ".flac")

const hostingMaxFiles = 10000

// Filenames engines use for things they generate, never files the game ships (ICC's screenshot
// export is saved as canvas.png).
var engineGenerated = setOf("canvas.png")

var (
	hashSegRe     = regexp.MustCompile(`(?i)\.[0-9a-f]{8,32}$`)
	titleTagRe    = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	httpInsideRe  = regexp.MustCompile(`(?i)\bhttps?:/`)
	hotlinkRe     = regexp.MustCompile(`(?i)(?:https?:)?//[\w.-]+\.[a-z]{2,}/[^\s"'<>()\\]+\.(?:` + leafAltExt() + `)\b`)
	slugCleanRe   = regexp.MustCompile(`[^a-z0-9]+`)
	twineMarkerRe = regexp.MustCompile(`(?i)<tw-storydata|harlowe|sugarcube|snowman`)
)

func leafAltExt() string {
	var xs []string
	for e := range leafExt {
		xs = append(xs, regexp.QuoteMeta(e[1:]))
	}
	sort.Slice(xs, func(i, j int) bool { return len(xs[i]) > len(xs[j]) })
	return strings.Join(xs, "|")
}

type CheckReport struct {
	Item            string   `json:"item"`
	Title           string   `json:"title,omitempty"`
	SourceURL       string   `json:"source_url,omitempty"`
	PreviewURL      string   `json:"preview_url,omitempty"`
	Files           int      `json:"files"`
	Bytes           int64    `json:"bytes"`
	Engine          string   `json:"engine,omitempty"`
	HasIndex        bool     `json:"has_index"`
	Refs            int      `json:"refs"`
	Missing         []string `json:"missing,omitempty"`
	MissingCount    int      `json:"missing_count"`
	Hotlinks        []string `json:"hotlinks,omitempty"`
	HotlinkCount    int      `json:"hotlink_count"`
	RootAbsolute    []string `json:"root_absolute,omitempty"`
	Escaping        []string `json:"escaping,omitempty"`
	FailedDownloads []string `json:"failed_downloads,omitempty"`
	Warnings        []string `json:"warnings,omitempty"`
	Verdict         string   `json:"verdict"`
	SuggestedSlug   string   `json:"suggested_slug,omitempty"`
	AuthorGuess     string   `json:"author_guess,omitempty"`
}

func dehash(stem string) string { return hashSegRe.ReplaceAllString(stem, "") }

func stemOf(p string) string {
	b := path.Base(p)
	if e := path.Ext(b); e != "" {
		return strings.TrimSuffix(b, e)
	}
	return b
}

func noExt(p string) string {
	if e := path.Ext(p); e != "" {
		return strings.TrimSuffix(p, e)
	}
	return p
}

// fileIndex: lowercased stem (and de-hashed stem) → lowercased relative paths.
func fileIndex(root string) (map[string][]string, int, int64) {
	idx := map[string][]string{}
	n, size := 0, int64(0)
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		n++
		if st, err := d.Info(); err == nil {
			size += st.Size()
		}
		r, _ := filepath.Rel(root, p)
		rel := strings.ToLower(filepath.ToSlash(r))
		s := stemOf(rel)
		idx[s] = append(idx[s], rel)
		if b := dehash(s); b != s {
			idx[b] = append(idx[b], rel)
		}
		return nil
	})
	return idx, n, size
}

func normalizeRef(ref string) string {
	if isSkippable(ref) || strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") || strings.HasPrefix(ref, "//") {
		return ""
	}
	if strings.ContainsAny(ref, "{}$*?<>") || httpInsideRe.MatchString(ref) {
		return ""
	}
	p := ref
	if u, err := url.Parse(ref); err == nil {
		p = u.Path
	}
	if dp, err := url.PathUnescape(p); err == nil {
		p = dp
	}
	var parts []string
	for _, s := range strings.Split(strings.TrimSpace(p), "/") {
		if s != "" && s != "." && s != ".." {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, "/")
}

// satisfied: matched by tail, extension ignored (an engine may glue a runtime folder in front, and
// image converters change .jpg to .webp).
func satisfied(ref string, idx map[string][]string) bool {
	ref = strings.ToLower(strings.TrimLeft(ref, "/"))
	tail := noExt(ref)
	for _, cand := range idx[stemOf(ref)] {
		c := noExt(cand)
		for _, v := range []string{c, dehash(c)} {
			if v == tail || strings.HasSuffix(v, "/"+tail) {
				return true
			}
		}
	}
	return false
}

func detectEngine(root string, projectJSON bool) string {
	var hasICCjs, hasCyoap, hasTwine, hasVue, htmlCount, imgCount, other int
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		switch {
		case ext == ".html" || ext == ".htm":
			htmlCount++
			if b, err := os.ReadFile(p); err == nil && twineMarkerRe.Match(b) {
				hasTwine++
			}
		case imageExt[ext]:
			imgCount++
		case ext == ".js":
			other++
			if fileSize(p) < 12_000_000 {
				b, _ := os.ReadFile(p)
				s := string(b)
				if strings.Contains(s, "platform.json") && strings.Contains(s, "nodes/list.json") {
					hasCyoap++
				}
				n := 0
				for _, ind := range iccIndicatorsJS {
					if strings.Contains(s, ind) {
						n++
					}
				}
				if n >= 2 {
					hasICCjs++
				}
				if strings.Contains(s, "__vue__") || strings.Contains(s, "createApp") || strings.Contains(s, "Vue.") {
					hasVue++
				}
			}
		default:
			other++
		}
		return nil
	})
	switch {
	case hasCyoap > 0:
		return "cyoap"
	case projectJSON || hasICCjs > 0:
		return "icc"
	case hasTwine > 0:
		return "twine"
	case other == 0 && imgCount > 0:
		return "static-images"
	case hasVue > 0:
		return "vue-app"
	case htmlCount > 0:
		return "custom"
	}
	return "unknown"
}

func findProjectJSON(root string) string {
	var best string
	var bestSize int64
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(p), ".json") {
			return nil
		}
		if s := fileSize(p); s > bestSize && looksLikeICCProject(p) {
			best, bestSize = p, s
		}
		return nil
	})
	return best
}

// iccDataEmbedded: ICC builds may carry the project inside app.js instead of project.json.
func iccDataEmbedded(root string) bool {
	found := false
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if found || err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(p), ".js") || fileSize(p) > 30_000_000 {
			return nil
		}
		b, _ := os.ReadFile(p)
		// An editor's empty default project has no rows with objects; a real embedded game has many.
		if strings.Count(string(b), `"objects":[`)+strings.Count(string(b), "objects:[") >= 5 {
			found = true
		}
		return nil
	})
	return found
}

func slugify(s string) string {
	s = slugCleanRe.ReplaceAllString(strings.ToLower(s), "-")
	s = strings.Trim(s, "-")
	if len(s) > 60 {
		s = strings.Trim(s[:60], "-")
	}
	return s
}

// guessFromURL: author and game name from well-known free-hosting URL shapes.
func guessFromURL(raw string) (author, game string) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", ""
	}
	host := strings.ToLower(u.Hostname())
	segs := []string{}
	for _, s := range strings.Split(u.Path, "/") {
		if s != "" && !strings.Contains(s, ".") {
			segs = append(segs, s)
		}
	}
	for _, suf := range []string{".neocities.org", ".github.io", ".itch.io", ".nekoweb.org", ".netlify.app", ".vercel.app", ".pages.dev"} {
		if strings.HasSuffix(host, suf) {
			sub := strings.TrimSuffix(host, suf)
			if i := strings.LastIndex(sub, "."); i >= 0 {
				sub = sub[i+1:]
			}
			author = sub
			if len(segs) > 0 {
				game = segs[len(segs)-1]
			} else if suf == ".netlify.app" || suf == ".vercel.app" || suf == ".pages.dev" {
				game = sub
			}
			return author, game
		}
	}
	if len(segs) > 0 {
		game = segs[len(segs)-1]
	} else {
		game = strings.Split(host, ".")[0]
	}
	return "", game
}

func pageTitle(indexPath string) string {
	b, err := os.ReadFile(indexPath)
	if err != nil {
		return ""
	}
	if len(b) > 200_000 {
		b = b[:200_000]
	}
	m := titleTagRe.FindSubmatch(b)
	if m == nil {
		return ""
	}
	t := strings.Join(strings.Fields(html.UnescapeString(string(m[1]))), " ")
	if len(t) > 200 {
		t = t[:200]
	}
	return t
}

// checkGame audits the item's game folder. crawl may be nil (imported folders).
func checkGame(it *Item, crawl *CrawlStats) *CheckReport {
	root := it.GameDir()
	r := &CheckReport{Item: it.ID, SourceURL: it.SourceURL}
	idx, n, size := fileIndex(root)
	r.Files, r.Bytes = n, size
	indexPath := filepath.Join(root, "index.html")
	r.HasIndex = isFile(indexPath)

	seen := map[string]bool{}
	var missing, hotlinks, rootAbs []string
	hotSeen, rootSeen := map[string]bool{}, map[string]bool{}
	var badExt []string
	badSeen := map[string]bool{}
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		ext := strings.ToLower(filepath.Ext(p))
		if !hostingAllowedExt[ext] && !badSeen[ext] {
			badSeen[ext] = true
			badExt = append(badExt, rel)
		}
		if !textExt[ext] || ext == ".txt" || ext == ".csv" {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		text := string(b)
		for _, ref := range leafRefsStrict(text) {
			np := normalizeRef(ref)
			if np == "" || seen[strings.ToLower(np)] || engineGenerated[strings.ToLower(path.Base(np))] {
				continue
			}
			seen[strings.ToLower(np)] = true
			if !satisfied(np, idx) {
				missing = append(missing, np)
			}
		}
		for _, h := range hotlinkRe.FindAllString(text, -1) {
			if !hotSeen[h] && !isPlatformInject(h) {
				hotSeen[h] = true
				hotlinks = append(hotlinks, h)
			}
		}
		if ext == ".html" || ext == ".htm" {
			for _, m := range rootAbsRefRe.FindAllStringSubmatch(text, -1) {
				ref := m[2]
				bare, _ := splitQuery(ref)
				if rootSeen[ref] || isPlatformInject(ref) || isFile(filepath.Join(root, filepath.FromSlash(strings.TrimLeft(bare, "/")))) {
					continue
				}
				rootSeen[ref] = true
				rootAbs = append(rootAbs, rel+": "+ref)
			}
		}
		return nil
	})
	sort.Strings(missing)
	r.Refs = len(seen)
	r.MissingCount = len(missing)
	r.Missing = capList(missing, 60)
	r.HotlinkCount = len(hotlinks)
	r.Hotlinks = capList(hotlinks, 30)
	r.RootAbsolute = capList(rootAbs, 30)
	if crawl != nil {
		r.FailedDownloads = crawl.Failed
		r.Escaping = crawl.Escaping
	} else if _, u := normalizeEscapingRefs(root); len(u) > 0 {
		r.Escaping = capList(u, 30)
	}

	pj := findProjectJSON(root)
	r.Engine = detectEngine(root, pj != "")
	r.Title = pageTitle(indexPath)
	if r.Title == "" {
		r.Title = it.Name
	}
	author, game := guessFromURL(it.SourceURL)
	r.AuthorGuess = author
	r.SuggestedSlug = slugify(game)
	if len(r.SuggestedSlug) < 3 {
		r.SuggestedSlug = slugify(r.Title)
	}
	if len(r.SuggestedSlug) < 3 {
		r.SuggestedSlug = ""
	}

	bad := false
	var warns []string
	if !r.HasIndex {
		bad = true
		warns = append(warns, "No index.html at the top of the folder — the game has no start page.")
	}
	if r.Engine == "icc" && pj == "" && !iccDataEmbedded(root) {
		bad = true
		warns = append(warns, "Interactive CYOA without its game data (project.json not found) — it will hang on Loading.")
	}
	if n == 0 {
		bad = true
		warns = append(warns, "The folder is empty.")
	}
	if n > hostingMaxFiles {
		bad = true
		warns = append(warns, "More than 10000 files — hosting will refuse it; ask the admin.")
	}
	if r.Refs > 0 && r.MissingCount*5 > r.Refs {
		bad = true
		warns = append(warns, "More than 20% of referenced files are missing.")
	} else if r.MissingCount > 0 {
		warns = append(warns, "Some referenced files are missing — open the preview and look for broken images.")
	}
	if r.HotlinkCount > 0 {
		warns = append(warns, "The game loads images from other sites; they may vanish later.")
	}
	if len(r.RootAbsolute) > 0 {
		warns = append(warns, "Links starting with \"/\" point at files that aren't in the folder; they break on hosting.")
	}
	if len(r.Escaping) > 0 {
		warns = append(warns, "Links with \"../\" point outside the game folder; they break on hosting.")
	}
	if len(r.FailedDownloads) > 0 {
		warns = append(warns, "Some files failed to download (see failed downloads).")
	}
	if len(badExt) > 0 {
		warns = append(warns, "Files hosting doesn't accept will be left out, e.g. "+strings.Join(capList(badExt, 3), ", "))
	}
	if r.Engine == "twine" {
		warns = append(warns, "Looks like a Twine story, not a CYOA.")
	}
	r.Warnings = warns
	switch {
	case bad:
		r.Verdict = "bad"
	case len(warns) > 0:
		r.Verdict = "warn"
	default:
		r.Verdict = "ok"
	}
	return r
}
