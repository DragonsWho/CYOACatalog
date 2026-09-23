package main

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

// Exactly what tripped the JSVM hook: the json field `perms` must read as a string list. If PB
// changes the cast, fail here rather than silently locking moderators out of half the site.
func TestPermsJSONFieldReadsAsStringSlice(t *testing.T) {
	col := core.NewBaseCollection("mod_permissions_test")
	col.Fields.Add(&core.JSONField{Name: "perms", MaxSize: 4000})

	rec := core.NewRecord(col)
	rec.Set("perms", []string{"queue", "tickets"})

	got := rec.GetStringSlice("perms")
	if len(got) != 2 || got[0] != "queue" || got[1] != "tickets" {
		t.Fatalf("GetStringSlice on a JSON field = %#v, want [queue tickets]", got)
	}

	rec.Set("perms", []string{"*"})
	if got := rec.GetStringSlice("perms"); len(got) != 1 || got[0] != "*" {
		t.Fatalf(`"*" round-trip = %#v`, got)
	}
}
