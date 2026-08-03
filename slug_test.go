package main

import "testing"

// These vectors are the shared contract with PB/slugify.py — the two slugifiers
// must agree byte-for-byte. Keep this list in sync with slugify.py's _VECTORS.
func TestSlugifyGameMatchesPython(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Angel of Shin Eden", "angel-of-shin-eden"},
		{"Café CYOA!", "cafe-cyoa"},
		{"  Multiple   Spaces  ", "multiple-spaces"},
		{"A/B: Test (v2)", "a-b-test-v2"},
		{"Naïve Café — Déjà Vu", "naive-cafe-deja-vu"},
		{"Über Mensch", "uber-mensch"},
		{"Hello___World", "hello-world"},
		{"--edge--", "edge"},
		{"2049: A Space CYOA", "2049-a-space-cyoa"},
		{"Magic Academia (Interactive)", "magic-academia-interactive"},
		// non-Latin → "" → caller keeps the record id
		{"Ангел Син Эдема", ""},
		{"魔法少女", ""},
		{"🔥🔥🔥", ""},
		{"", ""},
		{"   ", ""},
	}
	for _, c := range cases {
		if got := slugifyGame(c.in); got != c.want {
			t.Errorf("slugifyGame(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
