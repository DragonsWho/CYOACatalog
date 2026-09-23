package main

import "testing"

// Shared contract with the ingest pipeline (CYOA Harvester agent_ops.py _split_aliases): split ONLY
// on newline. Commas are common in CYOA titles.
func TestNormalizeAliases(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"  ", ""},
		{"One", "One"},
		{"  One  \n\n  Two  ", "One\nTwo"},
		{"One\r\nTwo", "One\nTwo"},
		{"One\none\nONE", "One"},
		{"Hero, Villain, Whatever", "Hero, Villain, Whatever"},
		{"A\n\n\nB\n", "A\nB"},
	}
	for _, c := range cases {
		if got := normalizeAliases(c.in); got != c.want {
			t.Errorf("normalizeAliases(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
