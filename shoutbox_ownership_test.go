package main

import (
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func ownershipTestMessage() *core.Record {
	col := core.NewBaseCollection("ownership_test_messages")
	col.Fields.Add(
		&core.TextField{Name: "kind"},
		&core.TextField{Name: "user"},
		&core.TextField{Name: "author_ref"},
		&core.TextField{Name: "anon_key"},
		&core.TextField{Name: "del_pass"},
	)
	rec := core.NewRecord(col)
	rec.Set("kind", "user")
	return rec
}

func TestAnonymousOwnershipRequiresSecret(t *testing.T) {
	rec := ownershipTestMessage()
	rec.Set("anon_key", "shared-ip-week")

	if err := shoutCanDeleteOwn(rec, "", ""); !errors.Is(err, errShoutNotOwner) {
		t.Fatalf("anon_key must not grant ownership: %v", err)
	}

	const secret = "browser-local-secret"
	rec.Set("del_pass", shoutDelPassMake(secret))
	if err := shoutCanDeleteOwn(rec, "", secret); err != nil {
		t.Fatalf("matching secret must grant ownership: %v", err)
	}
}

func TestMaskedAccountOwnershipUsesAuthorRef(t *testing.T) {
	rec := ownershipTestMessage()
	rec.Set("author_ref", "actual-author")
	rec.Set("anon_key", "shared-ip-week")

	if err := shoutCanDeleteOwn(rec, "different-account", ""); !errors.Is(err, errShoutNotOwner) {
		t.Fatalf("another account must not inherit ownership from the same IP: %v", err)
	}
	if err := shoutCanDeleteOwn(rec, "actual-author", ""); err != nil {
		t.Fatalf("hidden account author must retain ownership: %v", err)
	}
}
