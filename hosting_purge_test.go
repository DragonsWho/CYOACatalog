package main

import "testing"

// The site loads games in the iframe only with ?__save=1 (src/utils/cheat.ts) — a separate CF cache
// key. Purging only clean URLs left the iframe stale: "Infinite Travels" 2026-09-13 was 32 days
// behind.
func TestWithSaveFlagURLs(t *testing.T) {
	got := withSaveFlagURLs([]string{
		"https://om1cr0n.cyoa.cafe/infinite/",
		"https://om1cr0n.cyoa.cafe/infinite/index.html",
		"https://om1cr0n.cyoa.cafe/infinite/project.json",
		"https://om1cr0n.cyoa.cafe/infinite/?__save=1",
	})
	want := []string{
		"https://om1cr0n.cyoa.cafe/infinite/",
		"https://om1cr0n.cyoa.cafe/infinite/?__save=1",
		"https://om1cr0n.cyoa.cafe/infinite/index.html",
		"https://om1cr0n.cyoa.cafe/infinite/index.html?__save=1",
		"https://om1cr0n.cyoa.cafe/infinite/project.json",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d URLs %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] got %q, want %q", i, got[i], want[i])
		}
	}
}
