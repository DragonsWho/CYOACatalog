package main

import (
	"strconv"
	"strings"
	"testing"
)

func TestAllPageCount(t *testing.T) {
	cases := []struct{ total, want int }{
		{0, 1}, {1, 1}, {100, 1}, {101, 2}, {1301, 14},
	}
	for _, c := range cases {
		if got := allPageCount(c.total); got != c.want {
			t.Errorf("allPageCount(%d) = %d, want %d", c.total, got, c.want)
		}
	}
}

func TestAllPagePath(t *testing.T) {
	if got := allPagePath(1); got != "/all" {
		t.Errorf("allPagePath(1) = %q, want /all", got)
	}
	if got := allPagePath(7); got != "/all/7" {
		t.Errorf("allPagePath(7) = %q, want /all/7", got)
	}
}

func fakeEntries(n int) []allIndexEntry {
	out := make([]allIndexEntry, n)
	for i := range out {
		out[i] = allIndexEntry{key: "game-" + strconv.Itoa(i), title: "Game " + strconv.Itoa(i)}
	}
	return out
}

func TestRenderAllPageLinksEveryGameOnThePage(t *testing.T) {
	doc := renderAllPage(fakeEntries(250), 2)
	for i := 100; i < 200; i++ {
		want := `<a href="/game/game-` + strconv.Itoa(i) + `">`
		if !strings.Contains(doc, want) {
			t.Fatalf("page 2 is missing link %s", want)
		}
	}
	if strings.Contains(doc, `<a href="/game/game-99">`) {
		t.Error("page 2 leaked an entry from page 1")
	}
	if strings.Contains(doc, `<a href="/game/game-200">`) {
		t.Error("page 2 leaked an entry from page 3")
	}
}

func TestRenderAllPageCanonicalAndPagination(t *testing.T) {
	doc := renderAllPage(fakeEntries(250), 2)
	if !strings.Contains(doc, `<link rel="canonical" href="https://cyoa.cafe/all/2">`) {
		t.Error("page 2 lacks a self-canonical")
	}
	if !strings.Contains(doc, `<link rel="prev" href="https://cyoa.cafe/all">`) {
		t.Error("page 2 lacks rel=prev pointing at /all")
	}
	if !strings.Contains(doc, `<link rel="next" href="https://cyoa.cafe/all/3">`) {
		t.Error("page 2 lacks rel=next")
	}

	first := renderAllPage(fakeEntries(250), 1)
	if strings.Contains(first, `rel="prev"`) {
		t.Error("page 1 must not carry rel=prev")
	}
	last := renderAllPage(fakeEntries(250), 3)
	if strings.Contains(last, `rel="next"`) {
		t.Error("last page must not carry rel=next")
	}
}

// Titles are user input going into HTML — escaping here is the page's only protection.
func TestRenderAllPageEscapes(t *testing.T) {
	doc := renderAllPage([]allIndexEntry{{key: `a"b`, title: `<script>alert(1)</script>`}}, 1)
	if strings.Contains(doc, "<script>alert(1)</script>") {
		t.Error("game title rendered unescaped")
	}
	if !strings.Contains(doc, "&lt;script&gt;") {
		t.Error("expected the title escaped")
	}
	if strings.Contains(doc, `href="/game/a"b"`) {
		t.Error("slug rendered unescaped into the href")
	}
}
