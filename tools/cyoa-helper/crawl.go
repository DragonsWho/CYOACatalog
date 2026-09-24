// Site crawler: downloads a CYOA and everything it references into a folder that works offline and
// on cyoa.cafe hosting. Port of the pipeline's s01 SiteCrawler without the browser and web-archive
// parts (hard cases go to the site admin). Phases:
//  1. BFS from the entry page through HTML/CSS/JS/JSON references;
//  2. ICC data probe: project.json under well-known names and names found in the JS bundle;
//  3. every image/font/audio listed in the ICC data;
//  4. cyoap engine (Korean Vite/Vue) runtime data: dist/platform.json + dist/nodes/*.json;
//  5. safety net: same-site leaf assets the extractors missed;
//  6. runtime-prefix recovery: engines that glue a folder onto names in the browser;
//  7. rewrite absolute/foreign URLs to local paths; strip host-platform injected scripts.
package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	crawlWorkers     = 8
	domainDelay      = 250 * time.Millisecond
	maxFileBytes     = 200 << 20
	maxTotalBytes    = 1500 << 20
	maxFilesPerCrawl = 20000
	trapSegRepeat    = 4
	trapMaxDepth     = 30
)

var (
	gameHostingDomains = []string{"neocities.org", "netlify.app", "github.io", "vercel.app", "pages.dev", "nekoweb.org", "itch.zone", "hcommons.org"}
	allowedExternal    = setOf("i.imgur.com", "imgur.com", "cdn.discordapp.com", "media.discordapp.net",
		"fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com",
		"raw.githubusercontent.com", "i.ibb.co", "i.postimg.cc", "files.catbox.moe")
	iccProbePaths = []string{"project.json", "data/project.json", "app.json", "data.json", "game.json", "cyoa.json",
		"js/project.json", "assets/project.json", "static/project.json", "json/project.json", "files/project.json", "src/project.json"}
	jsonNoise = setOf("package.json", "package-lock.json", "tsconfig.json", "composer.json", "manifest.json",
		"asset-manifest.json", "site.webmanifest", "webmanifest.json", "browserconfig.json", "vercel.json",
		"now.json", "jsconfig.json", "angular.json", "nx.json")
	jsonLiteralRe = regexp.MustCompile("[\"'`]([\\w./-]{1,80}\\.json)[\"'`]")
	dirLiteralRe  = regexp.MustCompile("[\"'`](\\w[\\w.-]*(?:/[\\w.-]+)*/)[\"'`]")
	metaCharsetRe = regexp.MustCompile(`(?i)<meta[^>]+charset`)
	ctExt         = map[string]string{
		"text/html": ".html", "text/css": ".css", "text/javascript": ".js", "application/javascript": ".js",
		"application/x-javascript": ".js", "application/json": ".json", "application/ld+json": ".json",
		"text/plain": ".txt", "text/xml": ".xml", "application/xml": ".xml",
		"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
		"image/avif": ".avif", "image/svg+xml": ".svg", "image/bmp": ".bmp", "image/x-icon": ".ico",
		"image/vnd.microsoft.icon": ".ico", "font/woff2": ".woff2", "font/woff": ".woff",
		"application/font-woff2": ".woff2", "application/font-woff": ".woff", "font/ttf": ".ttf",
		"font/otf": ".otf", "application/vnd.ms-fontobject": ".eot", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
		"audio/wav": ".wav", "audio/x-wav": ".wav", "video/mp4": ".mp4", "video/webm": ".webm",
	}
	iccIndicatorsJSON = []string{`"rows"`, `"objects"`, `"choices"`, `"isEditModeOnAll"`, `"projectRow"`, `"backPackRows"`, `"pointTypes"`}
	iccIndicatorsJS   = []string{"isEditModeOnAll", "pointTypes", "backPackRows", "projectRow", "backpack:", "pointTypes:"}
)

type fileState int

const (
	stPending fileState = iota + 1
	stOK
	stMissing
	stFailed
)

type CrawlStats struct {
	Files           int      `json:"files"`
	Bytes           int64    `json:"bytes"`
	External        int      `json:"external"`
	Failed          []string `json:"failed,omitempty"`
	SkippedExternal []string `json:"skipped_external,omitempty"`
	ProjectJSON     string   `json:"project_json,omitempty"`
	EntryFile       string   `json:"entry_file,omitempty"`
	Escaping        []string `json:"escaping,omitempty"`
}

type Crawler struct {
	ctx        context.Context
	startURL   string
	baseDomain string
	basePath   string // decoded, ends with "/"
	baseURL    string
	outDir     string

	client    *http.Client
	extClient *http.Client

	mu          sync.Mutex
	state       map[string]fileState // canonical URL → state
	local       map[string]string    // canonical URL → absolute local path
	urlMap      map[string]string    // raw or absolute reference → "./rel/path"
	rawVariants map[string]map[string]bool
	queue       []string
	failed      []string
	skipped     map[string]bool
	projectJSON string
	files       int
	bytes       int64
	external    int

	domMu      sync.Mutex
	domainNext map[string]time.Time

	logf     func(string, ...any)
	progress func(done, queued int, bytes int64, msg string)
}

func NewCrawler(ctx context.Context, startURL, outDir string, logf func(string, ...any),
	progress func(int, int, int64, string)) (*Crawler, error) {
	u, err := checkPublicURL(startURL)
	if err != nil {
		return nil, err
	}
	u.Fragment = ""
	c := &Crawler{
		ctx: ctx, outDir: outDir,
		client:    newDownloadClient(90 * time.Second),
		extClient: newDownloadClient(45 * time.Second),
		state:     map[string]fileState{}, local: map[string]string{}, urlMap: map[string]string{},
		rawVariants: map[string]map[string]bool{}, skipped: map[string]bool{},
		domainNext: map[string]time.Time{}, logf: logf, progress: progress,
	}
	c.startURL = u.String()
	c.baseDomain = strings.ToLower(u.Host)
	p := u.EscapedPath()
	if p == "" {
		p = "/"
	}
	ext := path.Ext(p)
	realExt := ext != "" && !allDigits(ext[1:])
	switch {
	case strings.HasSuffix(p, "/"):
	case !realExt:
		p += "/"
	default:
		p = path.Dir(p) + "/"
	}
	if dp, err := url.PathUnescape(p); err == nil {
		c.basePath = dp
	} else {
		c.basePath = p
	}
	c.baseURL = (&url.URL{Scheme: u.Scheme, Host: u.Host, Path: c.basePath}).String()
	return c, nil
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func canonicalURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.Fragment = ""
	return u.String()
}

func (c *Crawler) resolve(raw, base string) string {
	if isSkippable(raw) {
		return ""
	}
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	ref, err := url.Parse(raw)
	if err != nil {
		ref, err = url.Parse(strings.ReplaceAll(raw, "%", "%25"))
		if err != nil {
			return ""
		}
	}
	b, err := url.Parse(base)
	if err != nil {
		return ""
	}
	r := b.ResolveReference(ref)
	if r.Scheme != "http" && r.Scheme != "https" {
		return ""
	}
	r.Fragment = ""
	if !strings.Contains(r.Hostname(), ".") && !strings.Contains(r.Hostname(), ":") {
		return ""
	}
	return r.String()
}

func isPathTrap(u string) bool {
	pu, err := url.Parse(u)
	if err != nil {
		return false
	}
	var segs []string
	for _, s := range strings.Split(pu.Path, "/") {
		if s != "" {
			segs = append(segs, s)
		}
	}
	if len(segs) > trapMaxDepth {
		return true
	}
	run := 1
	for i := 1; i < len(segs); i++ {
		if segs[i] == segs[i-1] {
			run++
			if run >= trapSegRepeat {
				return true
			}
		} else {
			run = 1
		}
	}
	return false
}

func looksLikePage(u string) bool {
	pu, err := url.Parse(u)
	if err != nil {
		return false
	}
	p := pu.Path
	if p == "" || strings.HasSuffix(p, "/") {
		return true
	}
	ext := strings.ToLower(path.Ext(p))
	if ext == "" {
		return true
	}
	return ext == ".html" || ext == ".htm" || ext == ".php" || ext == ".xhtml" || ext == ".asp" || ext == ".aspx"
}

func (c *Crawler) domainOf(u string) string {
	pu, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return strings.ToLower(pu.Host)
}

func isHostingDomain(d string) bool {
	for _, h := range gameHostingDomains {
		if d == h || strings.HasSuffix(d, "."+h) {
			return true
		}
	}
	return false
}

// shouldDownload decides admission only (no counting).
func (c *Crawler) shouldDownload(u string, fromMarkup bool) bool {
	if isPlatformInject(u) {
		c.skipped[u] = true
		return false
	}
	d := c.domainOf(u)
	if d == c.baseDomain {
		// Multi-game hosts: never FOLLOW sibling pages outside the game's folder, but still fetch shared
		// assets from anywhere on the domain.
		if c.basePath != "/" {
			pu, _ := url.Parse(u)
			p := pu.Path
			if !strings.HasPrefix(p, c.basePath) && looksLikePage(u) {
				c.skipped[u] = true
				return false
			}
		}
		return true
	}
	if isHostingDomain(d) || allowedExternal[d] || isLeafAsset(u) {
		return true
	}
	// Extensionless foreign URL: admitted tentatively (only from HTML/CSS — JS bundles are full of
	// namespace URIs and doc links), dropped after download unless it is an asset.
	if fromMarkup && !downloadableExt[urlExt(u)] {
		return true
	}
	c.skipped[u] = true
	return false
}

func (c *Crawler) urlToLocal(u, extHint string) string {
	pu, err := url.Parse(u)
	if err != nil {
		return filepath.Join(c.outDir, "external", "bad-url")
	}
	domain := strings.ToLower(pu.Host)
	rawPath := pu.Path
	isDir := strings.HasSuffix(rawPath, "/") || rawPath == ""
	suffix := path.Ext(rawPath)
	realExt := suffix != "" && !allDigits(suffix[1:])
	if !isDir && domain == c.baseDomain && !realExt && strings.TrimRight(rawPath, "/")+"/" == c.basePath {
		isDir = true
	}
	safe := sanitizeRelPath(strings.Trim(rawPath, "/"))
	switch {
	case isDir || safe == "":
		idx := "index.html"
		if extHint != "" {
			idx = "index" + extHint
		}
		if safe == "" {
			safe = idx
		} else {
			safe += "/" + idx
		}
	case extHint != "":
		base := path.Base(safe)
		stem := base
		if be := path.Ext(base); be != "" && !allDigits(be[1:]) {
			stem = strings.TrimSuffix(base, be)
		}
		if stem == "" {
			stem = "index"
		}
		qh := ""
		if pu.RawQuery != "" {
			h := sha1.Sum([]byte(pu.RawQuery))
			qh = "_" + hex.EncodeToString(h[:])[:8]
		}
		leaf := stem + qh + extHint
		if dir := path.Dir(safe); dir != "." && dir != "" {
			safe = dir + "/" + leaf
		} else {
			safe = leaf
		}
	case !strings.Contains(path.Base(safe), "."):
		safe += "/index.html"
	}
	if domain == c.baseDomain {
		base := sanitizeRelPath(strings.Trim(c.basePath, "/"))
		if base != "" && (safe == base || strings.HasPrefix(safe, base+"/")) {
			safe = strings.TrimLeft(safe[len(base):], "/")
		}
		if safe == "" {
			safe = "index.html"
		}
		return filepath.Join(c.outDir, filepath.FromSlash(safe))
	}
	return filepath.Join(c.outDir, "external", sanitizeRelPath(domain), filepath.FromSlash(safe))
}

func (c *Crawler) rel(local string) string {
	r, err := filepath.Rel(c.outDir, local)
	if err != nil {
		return local
	}
	return "./" + filepath.ToSlash(r)
}

func (c *Crawler) rateLimit(domain string) {
	c.domMu.Lock()
	now := time.Now()
	next := c.domainNext[domain]
	wait := next.Sub(now)
	if next.Before(now) {
		next = now
	}
	c.domainNext[domain] = next.Add(domainDelay)
	c.domMu.Unlock()
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-c.ctx.Done():
		}
	}
}

// get performs a GET with retries on network errors and 5xx.
func (c *Crawler) get(u string, external bool) (*http.Response, error) {
	cl, tries := c.client, 3
	if external {
		cl, tries = c.extClient, 2
	}
	var lastErr error
	for i := 0; i < tries; i++ {
		if c.ctx.Err() != nil {
			return nil, c.ctx.Err()
		}
		req, err := http.NewRequestWithContext(c.ctx, "GET", u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", browserUA)
		req.Header.Set("Accept", "*/*")
		resp, err := cl.Do(req)
		if err == nil && resp.StatusCode < 500 {
			return resp, nil
		}
		if err == nil {
			resp.Body.Close()
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
		} else {
			lastErr = err
			if errors.Is(err, errPrivateAddr) {
				return nil, err
			}
		}
		time.Sleep(time.Duration(500*(i+1)) * time.Millisecond)
	}
	return nil, lastErr
}

func normCT(resp *http.Response) (string, string) {
	mt, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil {
		return strings.ToLower(strings.TrimSpace(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0])), ""
	}
	return strings.ToLower(mt), strings.ToLower(params["charset"])
}

func ctIsText(ct string) bool {
	return strings.HasPrefix(ct, "text/") || ct == "application/json" || ct == "application/ld+json" ||
		ct == "application/javascript" || ct == "application/x-javascript" || ct == "application/xml" ||
		ct == "image/svg+xml" || strings.HasSuffix(ct, "+json") || strings.HasSuffix(ct, "+xml")
}

func ctIsAsset(ct string) bool {
	return strings.HasPrefix(ct, "image/") || strings.HasPrefix(ct, "font/") || strings.HasPrefix(ct, "audio/") ||
		strings.HasPrefix(ct, "video/") || ct == "application/font-woff" || ct == "application/font-woff2" ||
		ct == "application/vnd.ms-fontobject" || ct == "application/octet-stream"
}

// downloadOne returns the local path, "" for a clean miss (404/skipped).
func (c *Crawler) downloadOne(u string) (string, error) {
	if isSkippable(u) {
		return "", nil
	}
	domain := c.domainOf(u)
	external := domain != c.baseDomain
	c.rateLimit(domain)
	resp, err := c.get(u, external)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 || resp.StatusCode == 410 {
		return "", nil
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	ct, charset := normCT(resp)
	var localPath string
	if downloadableExt[urlExt(u)] {
		localPath = c.urlToLocal(u, "")
	} else {
		foreign := external && !allowedExternal[domain] && !isHostingDomain(domain)
		if foreign && !ctIsAsset(ct) {
			c.mu.Lock()
			c.skipped[u] = true
			c.mu.Unlock()
			return "", nil
		}
		hint := ctExt[ct]
		if hint == "" {
			if ctIsText(ct) {
				hint = ".txt"
			} else {
				hint = ".bin"
			}
		}
		localPath = c.urlToLocal(u, hint)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFileBytes+1))
	if err != nil {
		return "", err
	}
	if len(body) > maxFileBytes {
		return "", fmt.Errorf("file larger than %d MB", maxFileBytes>>20)
	}
	ext := strings.ToLower(filepath.Ext(localPath))
	// A page declaring its encoding only in the HTTP header would turn to mojibake on our hosting,
	// which serves it without that header: pin the charset inside the document.
	if (ext == ".html" || ext == ".htm") && charset != "" && charset != "utf-8" && charset != "utf8" {
		head := body
		if len(head) > 4096 {
			head = head[:4096]
		}
		if !metaCharsetRe.Match(head) {
			body = insertMetaCharset(body, charset)
		}
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(localPath, body, 0o644); err != nil {
		return "", err
	}
	rel := c.rel(localPath)
	canon := canonicalURL(u)
	c.mu.Lock()
	c.bytes += int64(len(body))
	if external {
		c.external++
	}
	c.urlMap[u] = rel
	c.urlMap[canon] = rel
	c.syncRawLocked(canon)
	c.mu.Unlock()
	return localPath, nil
}

func insertMetaCharset(doc []byte, charset string) []byte {
	tag := []byte(`<meta charset="` + charset + `">`)
	lower := bytes.ToLower(doc)
	if i := bytes.Index(lower, []byte("<head")); i >= 0 {
		if j := bytes.IndexByte(doc[i:], '>'); j >= 0 {
			at := i + j + 1
			return append(doc[:at:at], append(tag, doc[at:]...)...)
		}
	}
	return append(tag, doc...)
}

func (c *Crawler) syncRawLocked(canon string) {
	rel := ""
	if r, ok := c.urlMap[canon]; ok {
		rel = r
	} else {
		for v := range c.rawVariants[canon] {
			if r, ok := c.urlMap[v]; ok {
				rel = r
				break
			}
		}
	}
	if rel == "" {
		return
	}
	for v := range c.rawVariants[canon] {
		if _, ok := c.urlMap[v]; !ok {
			c.urlMap[v] = rel
		}
	}
}

func (c *Crawler) enqueueLocked(u string) {
	canon := canonicalURL(u)
	if _, known := c.state[canon]; known {
		return
	}
	c.state[canon] = stPending
	c.queue = append(c.queue, u)
}

// processQueue drains the queue in BFS rounds with a bounded worker pool.
func (c *Crawler) processQueue() error {
	for {
		c.mu.Lock()
		batch := c.queue
		c.queue = nil
		c.mu.Unlock()
		if len(batch) == 0 {
			return nil
		}
		sem := make(chan struct{}, crawlWorkers)
		var wg sync.WaitGroup
		for _, u := range batch {
			if c.ctx.Err() != nil {
				wg.Wait()
				return c.ctx.Err()
			}
			c.mu.Lock()
			tooMany := c.files >= maxFilesPerCrawl || c.bytes >= maxTotalBytes
			c.mu.Unlock()
			if tooMany {
				wg.Wait()
				return fmt.Errorf("the game is too big (over %d files or %d MB) — ask the admin", maxFilesPerCrawl, maxTotalBytes>>20)
			}
			if isPathTrap(u) {
				c.mu.Lock()
				c.state[canonicalURL(u)] = stFailed
				c.failed = append(c.failed, u)
				c.mu.Unlock()
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(u string) {
				defer wg.Done()
				defer func() { <-sem }()
				c.processOne(u)
			}(u)
		}
		wg.Wait()
	}
}

func (c *Crawler) processOne(u string) {
	canon := canonicalURL(u)
	local, err := c.downloadOne(u)
	c.mu.Lock()
	switch {
	case err != nil && c.domainOf(u) != c.baseDomain && !isLeafAsset(u) && !looksLikeResource(u):
		c.state[canon] = stMissing // a foreign page/link, not a game file
	case err != nil:
		c.state[canon] = stFailed
		c.failed = append(c.failed, u)
		c.logf("  failed: %s — %v", u, err)
	case local == "":
		c.state[canon] = stMissing
	default:
		c.state[canon] = stOK
		c.local[canon] = local
		c.files++
		if strings.HasSuffix(strings.ToLower(local), ".json") && c.projectJSON == "" && looksLikeICCProject(local) {
			c.projectJSON = local
			c.logf("  found ICC game data: %s", c.rel(local))
		}
	}
	done, queued, b := c.files, len(c.queue), c.bytes
	c.mu.Unlock()
	if c.progress != nil {
		c.progress(done, queued, b, "")
	}
	if local != "" {
		c.discover(u, local)
	}
}

func (c *Crawler) discover(source, local string) {
	ext := strings.ToLower(filepath.Ext(local))
	if !textExt[ext] {
		return
	}
	data, err := os.ReadFile(local)
	if err != nil {
		return
	}
	var refs []string
	switch ext {
	case ".html", ".htm":
		refs = extractFromHTML(data)
	case ".css":
		refs = extractFromCSS(string(data))
	case ".js", ".mjs":
		refs = extractFromJS(string(data))
	case ".json":
		refs = extractFromJSON(data)
	default:
		return
	}
	markup := ext == ".html" || ext == ".htm" || ext == ".css"
	resolveBase := source
	if source == c.startURL {
		resolveBase = c.baseURL
	}
	bases := []string{resolveBase}
	// Paths inside engine data files (js/data.js, data/game.json) are relative to the PAGE, not the
	// file: try both.
	if (ext == ".js" || ext == ".mjs" || ext == ".json") && c.baseURL != resolveBase {
		bases = append(bases, c.baseURL)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, raw := range refs {
		seen := map[string]bool{}
		for _, b := range bases {
			resolved := c.resolve(raw, b)
			if resolved == "" {
				continue
			}
			canon := canonicalURL(resolved)
			if seen[canon] {
				continue
			}
			seen[canon] = true
			if c.rawVariants[canon] == nil {
				c.rawVariants[canon] = map[string]bool{}
			}
			c.rawVariants[canon][raw] = true
			c.rawVariants[canon][resolved] = true
			if _, known := c.state[canon]; known {
				c.syncRawLocked(canon)
				continue
			}
			if c.shouldDownload(resolved, markup) {
				c.enqueueLocked(resolved)
			}
		}
	}
}

func looksLikeICCProject(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	buf, _ := io.ReadAll(io.LimitReader(f, 2_000_000))
	text := string(buf)
	inds := iccIndicatorsJSON
	if strings.HasSuffix(strings.ToLower(p), ".js") {
		inds = iccIndicatorsJS
	}
	n := 0
	for _, ind := range inds {
		if strings.Contains(text, ind) {
			n++
		}
	}
	return n >= 2
}

func (c *Crawler) textFiles() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, p := range c.local {
		if textExt[strings.ToLower(filepath.Ext(p))] {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

func (c *Crawler) jsonNamesFromJS(exclude []string) []string {
	already := map[string]bool{}
	for _, e := range exclude {
		already[strings.ToLower(e)] = true
	}
	var js []string
	for _, p := range c.textFiles() {
		if strings.HasSuffix(strings.ToLower(p), ".js") {
			js = append(js, p)
		}
	}
	sort.Slice(js, func(i, j int) bool { return fileSize(js[i]) > fileSize(js[j]) })
	var found []string
	for i, p := range js {
		if i >= 20 {
			break
		}
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, m := range jsonLiteralRe.FindAllStringSubmatch(string(data), -1) {
			cand := strings.TrimLeft(m[1], "./")
			low := strings.ToLower(cand)
			if cand == "" || already[low] || jsonNoise[path.Base(low)] || strings.HasPrefix(cand, "http") {
				continue
			}
			already[low] = true
			found = append(found, cand)
			if len(found) >= 12 {
				return found
			}
		}
	}
	return found
}

func fileSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}

// probeICC: a real project.json file always beats data embedded in the JS bundle (ICC-editor forks
// carry an empty default project in app.js).
func (c *Crawler) probeICC() {
	c.mu.Lock()
	have := c.projectJSON != ""
	c.mu.Unlock()
	if have {
		return
	}
	probes := append([]string{}, iccProbePaths...)
	probes = append(probes, c.jsonNamesFromJS(probes)...)
	for _, rel := range probes {
		if c.ctx.Err() != nil {
			return
		}
		probeURL := c.resolve(rel, c.baseURL)
		if probeURL == "" {
			continue
		}
		canon := canonicalURL(probeURL)
		c.mu.Lock()
		st, known := c.state[canon]
		local := c.local[canon]
		c.mu.Unlock()
		if known {
			if st == stOK && looksLikeICCProject(local) {
				c.mu.Lock()
				c.projectJSON = local
				c.mu.Unlock()
				return
			}
			continue
		}
		c.rateLimit(c.baseDomain)
		resp, err := c.get(probeURL, false)
		if err != nil {
			c.mu.Lock()
			c.state[canon] = stMissing
			c.mu.Unlock()
			continue
		}
		ct, _ := normCT(resp)
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxFileBytes))
		resp.Body.Close()
		if resp.StatusCode != 200 || !(strings.Contains(ct, "json") || strings.Contains(ct, "javascript") || strings.Contains(ct, "text")) {
			c.mu.Lock()
			c.state[canon] = stMissing
			c.mu.Unlock()
			continue
		}
		localPath := c.urlToLocal(probeURL, "")
		_ = os.MkdirAll(filepath.Dir(localPath), 0o755)
		if err := os.WriteFile(localPath, body, 0o644); err != nil {
			continue
		}
		c.mu.Lock()
		c.state[canon] = stOK
		c.local[canon] = localPath
		c.files++
		c.bytes += int64(len(body))
		r := c.rel(localPath)
		c.urlMap[probeURL] = r
		c.urlMap[rel] = r
		isICC := looksLikeICCProject(localPath)
		if isICC {
			c.projectJSON = localPath
		}
		c.mu.Unlock()
		if isICC {
			c.logf("  found ICC game data: %s", rel)
			return
		}
	}
	// Last resort: any downloaded JSON that looks like ICC data (largest first).
	var jsons []string
	_ = filepath.WalkDir(c.outDir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(strings.ToLower(p), ".json") {
			jsons = append(jsons, p)
		}
		return nil
	})
	sort.Slice(jsons, func(i, j int) bool { return fileSize(jsons[i]) > fileSize(jsons[j]) })
	for _, p := range jsons {
		if looksLikeICCProject(p) {
			c.mu.Lock()
			c.projectJSON = p
			c.mu.Unlock()
			return
		}
	}
}

func (c *Crawler) queueFromDataFile(p string) int {
	data, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	n := 0
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, raw := range extractFromJSON(data) {
		resolved := c.resolve(raw, c.baseURL)
		if resolved == "" {
			continue
		}
		canon := canonicalURL(resolved)
		if c.rawVariants[canon] == nil {
			c.rawVariants[canon] = map[string]bool{}
		}
		c.rawVariants[canon][raw] = true
		if _, known := c.state[canon]; known {
			c.syncRawLocked(canon)
			continue
		}
		if c.shouldDownload(resolved, false) {
			c.enqueueLocked(resolved)
			n++
		}
	}
	return n
}

// cyoap (Korean Vite/Vue engine) loads its content at runtime from dist/platform.json and
// dist/nodes/*.json next to the page; the crawler only sees the bundle.
func (c *Crawler) patchCyoap() {
	if _, err := os.Stat(filepath.Join(c.outDir, "dist", "nodes", "list.json")); err == nil {
		return
	}
	isCyoap := false
	for _, p := range c.textFiles() {
		if !strings.HasSuffix(strings.ToLower(p), ".js") || fileSize(p) > 8_000_000 {
			continue
		}
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte("platform.json")) && bytes.Contains(b, []byte("nodes/list.json")) {
			isCyoap = true
			break
		}
	}
	if !isCyoap {
		return
	}
	c.logf("cyoap engine detected: fetching dist/platform.json and dist/nodes/*")
	dataBase := c.baseURL + "dist/"
	fetch := func(u string) []byte {
		resp, err := c.get(u, false)
		if err != nil {
			return nil
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxFileBytes))
		return b
	}
	list := fetch(dataBase + "nodes/list.json")
	if list == nil {
		c.logf("  cyoap: no nodes/list.json at %s", dataBase)
		return
	}
	var names []any
	if err := json.Unmarshal(list, &names); err != nil {
		c.logf("  cyoap: list.json is not a JSON array")
		return
	}
	dist := filepath.Join(c.outDir, "dist")
	_ = os.MkdirAll(filepath.Join(dist, "nodes"), 0o755)
	if pl := fetch(dataBase + "platform.json"); pl != nil {
		_ = os.WriteFile(filepath.Join(dist, "platform.json"), pl, 0o644)
		c.queueFromDataFile(filepath.Join(dist, "platform.json"))
	}
	_ = os.WriteFile(filepath.Join(dist, "nodes", "list.json"), list, 0o644)
	got := 0
	for _, n := range names {
		name, ok := n.(string)
		if !ok || strings.Contains(name, "/") || strings.Contains(name, "..") || c.ctx.Err() != nil {
			continue
		}
		c.rateLimit(c.baseDomain)
		if b := fetch(dataBase + "nodes/" + url.PathEscape(name)); b != nil {
			p := filepath.Join(dist, "nodes", sanitizeRelPath(name))
			if os.WriteFile(p, b, 0o644) == nil {
				got++
				c.queueFromDataFile(p)
			}
		}
	}
	c.logf("  cyoap: fetched %d/%d nodes", got, len(names))
}

func (c *Crawler) safetyNet() {
	type src struct{ canon, local string }
	var files []src
	c.mu.Lock()
	for canon, p := range c.local {
		if textExt[strings.ToLower(filepath.Ext(p))] {
			files = append(files, src{canon, p})
		}
	}
	c.mu.Unlock()
	n := 0
	for _, f := range files {
		data, err := os.ReadFile(f.local)
		if err != nil {
			continue
		}
		c.mu.Lock()
		for _, raw := range leafRefsBroad(string(data)) {
			resolved := c.resolve(raw, f.canon)
			if resolved == "" || c.domainOf(resolved) != c.baseDomain || !isLeafAsset(resolved) {
				continue
			}
			canon := canonicalURL(resolved)
			if _, known := c.state[canon]; known || !c.shouldDownload(resolved, false) {
				continue
			}
			if c.rawVariants[canon] == nil {
				c.rawVariants[canon] = map[string]bool{}
			}
			c.rawVariants[canon][raw] = true
			c.enqueueLocked(resolved)
			n++
		}
		c.mu.Unlock()
	}
	if n > 0 {
		c.logf("safety net: %d referenced-but-missing file(s) queued", n)
	}
}

// Engines that build paths in the browser (`imgSrc + names[i]`): the names alone 404 at the page
// root. Guess the folder from bare folder literals and folders of assets we did get, confirm on a
// few misses, then refetch all misses under it.
func (c *Crawler) recoverPrefixed() {
	var misses []string
	c.mu.Lock()
	for canon, st := range c.state {
		if st != stMissing || !isLeafAsset(canon) || c.domainOf(canon) != c.baseDomain {
			continue
		}
		pu, _ := url.Parse(canon)
		if pu != nil && strings.HasPrefix(pu.Path, c.basePath) {
			misses = append(misses, canon)
		}
	}
	counter := map[string]int{}
	for _, p := range c.local {
		if leafExt[strings.ToLower(filepath.Ext(p))] {
			if r, err := filepath.Rel(c.outDir, filepath.Dir(p)); err == nil && r != "." && !strings.HasPrefix(r, "external") {
				counter[filepath.ToSlash(r)+"/"]++
			}
		}
	}
	c.mu.Unlock()
	if len(misses) == 0 {
		return
	}
	sort.Strings(misses)
	for _, p := range c.textFiles() {
		data, _ := os.ReadFile(p)
		for _, m := range dirLiteralRe.FindAllStringSubmatch(string(data), -1) {
			if d := m[1]; len(d) <= 40 && !strings.Contains(d, "://") {
				counter[d]++
			}
		}
	}
	type kv struct {
		k string
		v int
	}
	var cands []kv
	for k, v := range counter {
		cands = append(cands, kv{k, v})
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].v > cands[j].v || cands[i].v == cands[j].v && cands[i].k < cands[j].k })
	if len(cands) > 8 {
		cands = cands[:8]
	}
	withPrefix := func(u, prefix string) string {
		pu, err := url.Parse(u)
		if err != nil || !strings.HasPrefix(pu.Path, c.basePath) {
			return ""
		}
		rel := strings.TrimLeft(pu.Path[len(c.basePath):], "/")
		if rel == "" || strings.HasPrefix(rel, prefix) {
			return ""
		}
		pu.Path = c.basePath + prefix + rel
		pu.RawPath = ""
		return pu.String()
	}
	step := len(misses) / 3
	if step < 1 {
		step = 1
	}
	var probes []string
	for i := 0; i < len(misses) && len(probes) < 3; i += step {
		probes = append(probes, misses[i])
	}
	for _, cand := range cands {
		hit := false
		for _, m := range probes {
			fixed := withPrefix(m, cand.k)
			if fixed == "" {
				continue
			}
			c.rateLimit(c.baseDomain)
			resp, err := c.get(fixed, false)
			if err != nil {
				continue
			}
			ct, _ := normCT(resp)
			resp.Body.Close()
			if resp.StatusCode == 200 && ctIsAsset(ct) {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		c.logf("runtime folder %q found — refetching %d file(s) under it", cand.k, len(misses))
		c.mu.Lock()
		for _, m := range misses {
			if fixed := withPrefix(m, cand.k); fixed != "" {
				c.enqueueLocked(fixed)
			}
		}
		c.mu.Unlock()
		_ = c.processQueue()
		return
	}
}

// Neocities serves /a/b from /a/b.html: the browser resolves assets against the PARENT folder.
func (c *Crawler) neocitiesPrettyFile() string {
	if !strings.HasSuffix(c.baseDomain, "neocities.org") {
		return ""
	}
	pu, err := url.Parse(c.startURL)
	if err != nil || strings.HasSuffix(pu.Path, "/") || pu.Path == "" {
		return ""
	}
	leaf := path.Base(strings.TrimSuffix(pu.Path, ".html"))
	if leaf == "" || strings.EqualFold(leaf, "index") {
		return ""
	}
	if e := path.Ext(leaf); e != "" && !allDigits(e[1:]) {
		return ""
	}
	base := strings.TrimSuffix(c.startURL, ".html")
	asFile, err1 := c.get(base+".html", false)
	asDir, err2 := c.get(base+"/", false)
	if err1 != nil || err2 != nil {
		return ""
	}
	defer asFile.Body.Close()
	defer asDir.Body.Close()
	if asFile.StatusCode == 200 && asDir.StatusCode != 200 {
		return leaf
	}
	return ""
}

func (c *Crawler) Run() (*CrawlStats, error) {
	c.logf("Downloading %s", c.startURL)
	if strings.HasSuffix(c.baseDomain, "neocities.org") {
		if resp, err := c.get(c.startURL, false); err == nil {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if bytes.Contains(b, []byte("<h1>Page Not Found</h1>")) {
				return nil, errors.New("neocities says the page doesn't exist (site deleted or banned) — ask the admin to recover it from the web archive")
			}
		}
	}
	entry := c.startURL
	pretty := c.neocitiesPrettyFile()
	if pretty != "" {
		pu, _ := url.Parse(c.startURL)
		c.basePath = path.Dir(strings.TrimSuffix(pu.Path, ".html")) + "/"
		if c.basePath == "//" {
			c.basePath = "/"
		}
		c.baseURL = (&url.URL{Scheme: pu.Scheme, Host: pu.Host, Path: c.basePath}).String()
		entry = strings.TrimSuffix(c.startURL, ".html") + ".html"
		c.startURL = entry
		c.logf("neocities pretty URL: using %s", entry)
	}

	c.mu.Lock()
	c.enqueueLocked(entry)
	c.mu.Unlock()
	steps := []struct {
		name string
		fn   func()
	}{
		{"pages and assets", func() {}},
		{"ICC game data", c.probeICC},
		{"images from the game data", func() {
			c.mu.Lock()
			pj := c.projectJSON
			c.mu.Unlock()
			if pj != "" {
				n := c.queueFromDataFile(pj)
				c.logf("game data lists %d more file(s)", n)
			}
		}},
		{"cyoap data", c.patchCyoap},
		{"safety net", c.safetyNet},
		{"runtime folders", c.recoverPrefixed},
	}
	for _, s := range steps {
		if c.progress != nil {
			c.progress(c.files, len(c.queue), c.bytes, s.name)
		}
		s.fn()
		if err := c.processQueue(); err != nil {
			return nil, err
		}
	}

	c.mu.Lock()
	for canon := range c.rawVariants {
		c.syncRawLocked(canon)
	}
	urlMap := make(map[string]string, len(c.urlMap))
	for k, v := range c.urlMap {
		urlMap[k] = v
	}
	c.mu.Unlock()

	if c.progress != nil {
		c.progress(c.files, 0, c.bytes, "rewriting links")
	}
	n := rewriteURLsInTree(c.outDir, urlMap)
	c.logf("rewrote links in %d file(s)", n)
	unresolvedRefs := fixForHosting(c.outDir, c.logf)

	entryLocal := ""
	c.mu.Lock()
	entryLocal = c.local[canonicalURL(entry)]
	c.mu.Unlock()
	if pretty != "" && entryLocal != "" {
		idx := filepath.Join(c.outDir, "index.html")
		if _, err := os.Stat(idx); err != nil {
			if b, err := os.ReadFile(entryLocal); err == nil {
				_ = os.WriteFile(idx, b, 0o644)
			}
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	st := &CrawlStats{Files: c.files, Bytes: c.bytes, External: c.external, Escaping: capList(unresolvedRefs, 30)}
	if len(c.failed) > 0 {
		st.Failed = capList(c.failed, 50)
	}
	for u := range c.skipped {
		st.SkippedExternal = append(st.SkippedExternal, u)
	}
	sort.Strings(st.SkippedExternal)
	st.SkippedExternal = capList(st.SkippedExternal, 30)
	if c.projectJSON != "" {
		st.ProjectJSON = c.rel(c.projectJSON)
	}
	if entryLocal != "" {
		st.EntryFile = c.rel(entryLocal)
	}
	if entryLocal == "" {
		return st, errors.New("could not download the game page itself (check the link)")
	}
	return st, nil
}

func capList(xs []string, n int) []string {
	if len(xs) > n {
		return xs[:n]
	}
	return xs
}
