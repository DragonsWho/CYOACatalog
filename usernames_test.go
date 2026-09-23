package main

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

// Discord sends "0" for the abolished discriminator; PB joins it into the display name — "cat"
// arrives as "cat#0".
func TestCleanOAuthName(t *testing.T) {
	cases := []struct{ provider, in, want string }{
		{"discord", "cat#0", "cat"},
		{"discord", "therandomizer2500__#0", "therandomizer2500__"},
		{"discord", "old school#1234", "old school"}, // legacy discriminator
		{"discord", " spaced#0 ", "spaced"},
		{"discord", "cat", "cat"},
		{"discord", "#0", "#0"}, // no name — nothing to cut
		{"discord", "", ""},
		// for other providers "#" is a legit part of a name
		{"google", "C#developer#0", "C#developer#0"},
		{"discord", "C#developer#0", "C#developer"}, // ...but for Discord cut the last one
	}
	for _, c := range cases {
		if got := cleanOAuthName(c.provider, c.in); got != c.want {
			t.Errorf("cleanOAuthName(%q, %q) = %q, want %q", c.provider, c.in, got, c.want)
		}
	}
}

// The claim link travels inside the error text (PB drops custom `data` fields; frontend extracts
// the URL by regex), so the message format is a contract with AccountSettings.tsx — keep it under
// test.
func TestReservedUsernameMessage(t *testing.T) {
	col, err := collectionForUsersStub()
	if err != nil {
		t.Fatalf("stub collection: %v", err)
	}

	withSlug := core.NewRecord(col)
	withSlug.Set("username", "IronTiger")
	withSlug.Set("hosting_slug", "irontiger")
	if got, want := reservedUsernameMessage(withSlug), "https://irontiger.cyoa.cafe"; !strings.Contains(got, want) {
		t.Errorf("reservedUsernameMessage() = %q, want substring %q", got, want)
	}

	// Slug may be unset — fall back to lowercased username, which is what ensureHostingSlug derives it
	// from.
	noSlug := core.NewRecord(col)
	noSlug.Set("username", "GastON2")
	if got, want := reservedUsernameMessage(noSlug), "https://gaston2.cyoa.cafe"; !strings.Contains(got, want) {
		t.Errorf("reservedUsernameMessage() = %q, want substring %q", got, want)
	}
}

func collectionForUsersStub() (*core.Collection, error) {
	col := core.NewBaseCollection("users")
	col.Fields.Add(&core.TextField{Name: "username"})
	col.Fields.Add(&core.TextField{Name: "hosting_slug"})
	return col, nil
}
