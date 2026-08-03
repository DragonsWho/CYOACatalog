package main

import "testing"

func TestNormalizeName(t *testing.T) {
	cases := []struct{ in, want string }{
		// то, ради чего всё затевалось: «The Unseen Trial » ≠ «The Unseen Trial»
		{"The Unseen Trial ", "The Unseen Trial"},
		{"  Wifu garden  ", "Wifu garden"},
		{"\tBecoming a Sister\n", "Becoming a Sister"},
		{"Too  Small  -  A Sissy", "Too Small - A Sissy"},
		{"\u00a0Ghost\u00a0", "Ghost"},         // NBSP по краям
		{"Zero\u200bWidth", "Zero Width"},      // zero-width внутри → обычный пробел
		{"\ufeffBOM at start", "BOM at start"}, // BOM из копипасты
		{"", ""},
		{"   ", ""},
		// чистое название не трогаем — включая знаки и не-латиницу
		{"Ghost", "Ghost"},
		{"Too Small - A Sissy in a Woman's World!", "Too Small - A Sissy in a Woman's World!"},
		{"Тень и Пламя", "Тень и Пламя"},
	}
	for _, c := range cases {
		if got := normalizeName(c.in); got != c.want {
			t.Errorf("normalizeName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
