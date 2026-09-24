// Resource references in downloaded files. Port of the pipeline's url_extractor: broad on purpose —
// a false positive costs one 404, a miss costs a broken game. Every extractor returns raw strings
// (absolute URLs, relative paths); the crawler resolves them.
package main

import (
	"bytes"
	"encoding/json"
	"path"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

var (
	imageExt = setOf(".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico")
	fontExt  = setOf(".woff", ".woff2", ".ttf", ".otf", ".eot")
	mediaExt = setOf(".mp3", ".ogg", ".wav", ".mp4", ".webm", ".m4a", ".opus", ".flac", ".aac")
	leafExt  = union(imageExt, fontExt, mediaExt)
	// Extensions we download at all (pages, scripts, styles, data + leaf assets).
	downloadableExt = union(leafExt, setOf(".html", ".htm", ".js", ".mjs", ".css", ".json", ".xml", ".txt", ".csv", ".wasm"))
	textExt         = setOf(".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".xml", ".txt", ".csv")
)

func setOf(xs ...string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

func union(ms ...map[string]bool) map[string]bool {
	out := map[string]bool{}
	for _, m := range ms {
		for k := range m {
			out[k] = true
		}
	}
	return out
}

// urlExt: lowercased extension of the URL's path (query/fragment ignored).
func urlExt(raw string) string {
	p := raw
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	if i := strings.Index(p, "://"); i >= 0 {
		p = p[i+3:]
		if j := strings.Index(p, "/"); j >= 0 {
			p = p[j:]
		} else {
			p = "/"
		}
	}
	return strings.ToLower(path.Ext(p))
}

func isLeafAsset(u string) bool { return leafExt[urlExt(u)] }

func looksLikeResource(u string) bool { return downloadableExt[urlExt(u)] }

func isSkippable(u string) bool {
	for _, p := range []string{"data:", "blob:", "javascript:", "mailto:", "#", "about:", "tel:"} {
		if strings.HasPrefix(u, p) {
			return true
		}
	}
	return false
}

var (
	// url("...") / url('...') / url(...): a quoted target may contain spaces.
	cssURLRe    = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)`)
	cssImportRe = regexp.MustCompile(`(?i)@import\s+["']([^"']+)["']`)

	jsQuotedRe = regexp.MustCompile(`(?i)["'` + "`" + `]((?:https?://[^\s"'` + "`" + `<>]+)|(?:\.{0,2}/[^"'` + "`" + `<>\n]+\.\w{2,5}(?:[?#][^"'` + "`" + `<>\n]+)?)|(?:\w[\w ./+-]*\.(?:json|js|mjs|css|html|htm|png|jpe?g|gif|webp|avif|svg|bmp|ico|woff2?|ttf|otf|eot|mp3|mp4|ogg|wav|webm|m4a|opus|flac|aac)(?:[?#][^"'` + "`" + `<>\n]+)?))["'` + "`" + `]`)
	jsFetchRe  = regexp.MustCompile(`(?i)(?:fetch|\.open|\.src|\.href|import|require|loadProject|getJSON)\s*\(\s*["'` + "`" + `]([^"'` + "`" + `]+)["'` + "`" + `]`)
	jsAssignRe = regexp.MustCompile(`(?i)(?:var|let|const|=)\s*\w*(?:url|src|path|file|href|img|image|font|project|data)\w*\s*=\s*["'` + "`" + `]([^"'` + "`" + `]+\.(?:json|js|mjs|png|jpe?g|gif|webp|avif|svg|bmp|ico|html|css|woff2?|ttf|otf|eot|mp3|mp4|ogg|wav|webm|m4a|opus|flac)(?:[?#][^\s"'` + "`" + `<>]+)?)["'` + "`" + `]`)
	// Webpack lazy chunks: "js/"+({}[t]||t)+"."+{"chunk-2d0e6102":"09695d49"}[t]+".js"
	chunkMapRe  = regexp.MustCompile(`"(js|css)/"\s*\+[^;]{0,200}?\{((?:"[\w-]+":"[0-9a-f]{8}",?)+)\}\[\w+\]\s*\+\s*"\.(js|css)"`)
	chunkPairRe = regexp.MustCompile(`"([\w-]+)":"([0-9a-f]{8})"`)

	// ICC loader scripts (core.js) inject assets through add(tag, {href: base + 'x'}).
	iccLoaderRe   = regexp.MustCompile(`(?i)add\s*\(\s*['"](?:link|script|style)['"]`)
	iccObjKeyRe   = regexp.MustCompile(`(?i)(?:href|src|data-src)\s*:\s*(?:\w+\s*\+\s*)?['"]([^'"]+)['"]`)
	iccPropRe     = regexp.MustCompile(`\.(?:src|href)\s*=\s*(?:\w+\s*\+\s*)?['"]([^'"]+)['"]`)
	iccVarAssigRe = regexp.MustCompile(`(?:var|const|let)\s+\w+\s*=\s*(?:\w+\s*\+\s*)?['"]([^'"]+\.(?:js|css))['"]`)

	imgTagRe = regexp.MustCompile(`(?i)<img[^>]+src=["']([^"']+)["']`)
)

func cssURLs(text string) []string {
	var out []string
	for _, m := range cssURLRe.FindAllStringSubmatch(text, -1) {
		v := strings.TrimSpace(m[1] + m[2] + m[3])
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func extractFromCSS(text string) []string {
	out := cssURLs(text)
	for _, m := range cssImportRe.FindAllStringSubmatch(text, -1) {
		out = append(out, m[1])
	}
	return clean(out)
}

func extractFromJS(text string) []string {
	var out []string
	for _, re := range []*regexp.Regexp{jsQuotedRe, jsFetchRe, jsAssignRe} {
		for _, m := range re.FindAllStringSubmatch(text, -1) {
			out = append(out, m[1])
		}
	}
	for _, m := range chunkMapRe.FindAllStringSubmatch(text, -1) {
		if m[1] != m[3] {
			continue
		}
		for _, p := range chunkPairRe.FindAllStringSubmatch(m[2], -1) {
			out = append(out, m[1]+"/"+p[1]+"."+p[2]+"."+m[1])
		}
	}
	if iccLoaderRe.MatchString(text) {
		for _, re := range []*regexp.Regexp{iccObjKeyRe, iccPropRe, iccVarAssigRe} {
			for _, m := range re.FindAllStringSubmatch(text, -1) {
				if strings.Contains(m[1], ".") && len(m[1]) > 2 {
					out = append(out, m[1])
				}
			}
		}
	}
	return clean(out)
}

func extractFromHTML(src []byte) []string {
	var out []string
	z := html.NewTokenizer(bytes.NewReader(src))
	inStyle, inScript := false, false
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return clean(out)
		case html.TextToken:
			if inStyle {
				out = append(out, extractFromCSS(string(z.Text()))...)
			} else if inScript {
				out = append(out, extractFromJS(string(z.Text()))...)
			}
		case html.EndTagToken:
			inStyle, inScript = false, false
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			tag := string(name)
			inStyle = tag == "style" && tt == html.StartTagToken
			inScript = tag == "script" && tt == html.StartTagToken
			for hasAttr {
				var k, v []byte
				k, v, hasAttr = z.TagAttr()
				key, val := string(k), strings.TrimSpace(string(v))
				switch key {
				case "src", "data-src", "poster":
					out = append(out, val)
				case "href":
					if tag != "a" || looksLikeResource(val) {
						out = append(out, val)
					}
				case "srcset":
					for _, part := range strings.Split(val, ",") {
						if f := strings.Fields(part); len(f) > 0 {
							out = append(out, f[0])
						}
					}
				case "content":
					if tag == "meta" && (looksLikeResource(val) || strings.HasPrefix(val, "http")) {
						out = append(out, val)
					}
				case "style":
					out = append(out, cssURLs(val)...)
				}
			}
		}
	}
}

// Every string in a JSON document that looks like a path or URL (ICC project.json: images of every
// choice/row, fonts, audio).
func extractFromJSON(data []byte) []string {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil
	}
	var out []string
	var walk func(any)
	walk = func(n any) {
		switch t := n.(type) {
		case map[string]any:
			for _, x := range t {
				walk(x)
			}
		case []any:
			for _, x := range t {
				walk(x)
			}
		case string:
			if isSkippable(t) {
				return
			}
			if strings.Contains(t, "<img") {
				for _, m := range imgTagRe.FindAllStringSubmatch(t, -1) {
					out = append(out, m[1])
				}
			}
			if strings.HasPrefix(t, "http://") || strings.HasPrefix(t, "https://") ||
				strings.HasPrefix(t, "./") || strings.HasPrefix(t, "../") || strings.HasPrefix(t, "/") {
				if looksLikeResource(t) {
					out = append(out, t)
				}
			} else if strings.Contains(t, ".") && !strings.Contains(t, " ") && len(t) < 300 && looksLikeResource(t) {
				out = append(out, t)
			}
		}
	}
	walk(v)
	return clean(out)
}

func clean(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, u := range in {
		u = strings.TrimSpace(u)
		if u == "" || isSkippable(u) || seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, u)
	}
	return out
}

// ---- leaf-asset references (safety net + completeness check) ----

var leafAlt = func() string {
	var exts []string
	for e := range leafExt {
		exts = append(exts, regexp.QuoteMeta(e[1:]))
	}
	// longest first so "jpeg" wins over "jpg"-style prefixes
	for i := 0; i < len(exts); i++ {
		for j := i + 1; j < len(exts); j++ {
			if len(exts[j]) > len(exts[i]) {
				exts[i], exts[j] = exts[j], exts[i]
			}
		}
	}
	return strings.Join(exts, "|")
}()

// RE2 has no backreferences: one pattern per quote character.
var leafQuotedRes = func() []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, q := range []string{`"`, `'`, "`"} {
		out = append(out, regexp.MustCompile(`(?i)`+q+`([^"'`+"`"+`<>\n]*?\.(?:`+leafAlt+`))(?:[?#][^"'`+"`"+`<>\n]*)?`+q))
	}
	return out
}()

// Bare path-like tokens; the "not preceded by" guard of the Python version is checked by hand.
var leafBareRe = regexp.MustCompile(`(?i)((?:\.{0,2}/)?[\w\-./+%]+\.(?:` + leafAlt + `))\b`)

func isConcatTail(ref string) bool {
	stem := strings.TrimSuffix(path.Base(ref), path.Ext(ref))
	return stem == "" || strings.ContainsRune("-_.", rune(stem[0]))
}

// leafRefsStrict: whole references only (url(...) and string literals), minus runtime-concat stubs
// like "_normal.webp". Used where a false "missing" is expensive (the check report).
func leafRefsStrict(text string) []string {
	var out []string
	for _, r := range cssURLs(text) {
		if isLeafAsset(r) {
			out = append(out, r)
		}
	}
	for _, re := range leafQuotedRes {
		for _, m := range re.FindAllStringSubmatch(text, -1) {
			if v := strings.TrimSpace(m[1]); v != "" {
				out = append(out, v)
			}
		}
	}
	var keep []string
	for _, u := range clean(out) {
		if !isConcatTail(u) {
			keep = append(keep, u)
		}
	}
	return keep
}

// leafRefsBroad adds bare tokens (for the crawler's safety net, where a false hit costs a 404).
func leafRefsBroad(text string) []string {
	out := leafRefsStrict(text)
	for _, idx := range leafBareRe.FindAllStringSubmatchIndex(text, -1) {
		start := idx[2]
		if start > 0 {
			prev := text[start-1]
			if strings.ContainsRune("-./+%\"'`", rune(prev)) || prev == ' ' || prev == '\t' || prev == '\n' ||
				prev == '_' || (prev >= '0' && prev <= '9') || (prev >= 'a' && prev <= 'z') || (prev >= 'A' && prev <= 'Z') {
				continue
			}
		}
		out = append(out, text[idx[2]:idx[3]])
	}
	return clean(out)
}
