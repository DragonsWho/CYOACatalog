package main

import "testing"

// normalizeAliases — общий контракт с `_split_aliases` в
// CYOA Harvester/agent_ops.py (ночные агенты пишут то же поле через
// pipeline.py aliases). Обе стороны режут ТОЛЬКО по переводу строки: запятые
// в названиях CYOA обычны и разделителем не считаются.
func TestNormalizeAliases(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"  ", ""},
		{"One", "One"},
		{"  One  \n\n  Two  ", "One\nTwo"},
		{"One\r\nTwo", "One\nTwo"},
		// дедуп без учёта регистра, первое написание побеждает
		{"One\none\nONE", "One"},
		// запятая — часть названия, не разделитель
		{"Hero, Villain, Whatever", "Hero, Villain, Whatever"},
		{"A\n\n\nB\n", "A\nB"},
	}
	for _, c := range cases {
		if got := normalizeAliases(c.in); got != c.want {
			t.Errorf("normalizeAliases(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
