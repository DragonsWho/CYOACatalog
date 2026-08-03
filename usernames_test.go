package main

import "testing"

// Discord отдаёт всем «0» вместо отменённого дискриминатора, а PocketBase
// склеивает его с ником в отображаемое имя — «cat» приезжает как «cat#0».
func TestCleanOAuthName(t *testing.T) {
	cases := []struct{ provider, in, want string }{
		{"discord", "cat#0", "cat"},
		{"discord", "therandomizer2500__#0", "therandomizer2500__"},
		{"discord", "old school#1234", "old school"}, // легаси-дискриминатор
		{"discord", " spaced#0 ", "spaced"},
		{"discord", "cat", "cat"},  // уже чистое
		{"discord", "#0", "#0"},    // имени нет — резать нечего
		{"discord", "", ""},
		// у прочих провайдеров «#» — законная часть имени
		{"google", "C#developer#0", "C#developer#0"},
		{"discord", "C#developer#0", "C#developer"}, // ...а у Discord режем последнюю
	}
	for _, c := range cases {
		if got := cleanOAuthName(c.provider, c.in); got != c.want {
			t.Errorf("cleanOAuthName(%q, %q) = %q, want %q", c.provider, c.in, got, c.want)
		}
	}
}
