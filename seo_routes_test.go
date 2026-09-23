package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// seo.go's registry duplicates the <Route> table in src/App.tsx; drift fails worst-case (works in
// browser, 404 to Google). This test reads the real App.tsx so a missing registration breaks the
// build, not indexing.
func TestKnownAppPathsMatchFrontendRoutes(t *testing.T) {
	src, err := os.ReadFile("src/App.tsx")
	if err != nil {
		t.Skipf("frontend source not available: %v", err)
	}
	re := regexp.MustCompile(`path="/([^"*]*)"`)
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		seg, _, _ := strings.Cut(m[1], "/")
		if !isKnownAppPath(seg) {
			t.Errorf("route /%s exists in App.tsx but %q is missing from knownAppPaths "+
				"(seo.go) — the page would answer 404 to crawlers", m[1], seg)
		}
	}
}

func TestIsKnownAppPath(t *testing.T) {
	known := []string{"", "search", "game", "game/some-slug", "moderator/tickets", "hosting/"}
	for _, p := range known {
		if !isKnownAppPath(p) {
			t.Errorf("isKnownAppPath(%q) = false, want true", p)
		}
	}
	phantom := []string{"en", "en/", "ru", "index.php", "wp-admin", "game-list", "play", "play/someuser"}
	for _, p := range phantom {
		if isKnownAppPath(p) {
			t.Errorf("isKnownAppPath(%q) = true, want false", p)
		}
	}
}

// Disallow and noindex are mutually exclusive: a Disallowed path is never fetched, so its noindex
// is never read. Every private surface uses exactly one — for us always noindex.
func TestNoindexPathsAreNotDisallowed(t *testing.T) {
	for seg := range noindexPaths {
		if strings.Contains(robotsTxt, "Disallow: /"+seg) {
			t.Errorf("%q is both noindex and Disallow'd in robots.txt — the crawler "+
				"can never read the noindex; drop the Disallow", seg)
		}
	}
}

func TestRobotsAllowsRenderCriticalAPIs(t *testing.T) {
	for _, path := range []string{
		"/api/collections/games/records",
		"/api/collections/tags/records",
		"/api/collections/comments/records",
		"/api/files/",
	} {
		if !strings.Contains(robotsTxt, "Allow: "+path) {
			t.Errorf("robots.txt must allow %s — the SPA cannot render without it", path)
		}
	}
	if !strings.Contains(robotsTxt, "Disallow: /api/\n") {
		t.Error("the blanket Disallow: /api/ must stay — Allow wins by longest match")
	}
}

func TestLabPathsNeedNoRegistration(t *testing.T) {
	for _, seg := range []string{"chat-lab", "feed-lab3", "emoji-lab", "brand-new-lab", "feed-lab12"} {
		if !isLabPath(seg) {
			t.Errorf("isLabPath(%q) = false, want true", seg)
		}
		if !isKnownAppPath(seg) {
			t.Errorf("%q should not 404 — labs are recognised by name", seg)
		}
		if !isNoindexPath(seg) {
			t.Errorf("%q must be noindex — no lab belongs in search results", seg)
		}
	}
	for _, seg := range []string{"lab", "labs", "collaborate", "game"} {
		if isLabPath(seg) {
			t.Errorf("isLabPath(%q) = true, want false", seg)
		}
	}
}

func TestServiceFeedsAreNoindex(t *testing.T) {
	for _, p := range []string{"log", "roulette"} {
		if !isKnownAppPath(p) || !isNoindexPath(p) {
			t.Errorf("/%s must be a live route AND noindex", p)
		}
		if _, ok := staticPageMeta[p]; ok {
			t.Errorf("/%s has staticPageMeta — it would land in sitemap.xml next to its noindex", p)
		}
	}
}
