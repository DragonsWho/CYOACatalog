package main

import "testing"

func TestValidEmail(t *testing.T) {
	ok := []string{"a@b.co", "user.name+tag@example.org", "Ünïcode@example.com"}
	for _, s := range ok {
		if !validEmail(s) {
			t.Errorf("%q must be accepted as an address", s)
		}
	}
	// Most dangerous case: the address goes into a mail header; CRLF injection ("To: a@b.co\r
	// Bcc: ...") would make this an open relay from our domain.
	bad := []string{
		"", "no-at-sign", "two@@at.com", "a@b.co, c@d.co",
		"Name <a@b.co>", "a@b.co\r\nBcc: x@y.z", "a b@c.de",
	}
	for _, s := range bad {
		if validEmail(s) {
			t.Errorf("%q must not be accepted as an address", s)
		}
	}
}

func TestNormalizeEmail(t *testing.T) {
	if got := normalizeEmail("  User@Example.COM "); got != "user@example.com" {
		t.Fatalf("normalization: %q", got)
	}
}

func TestMaskEmail(t *testing.T) {
	cases := map[string]string{
		"dragonswho@gmail.com": "d***@gmail.com",
		"a@b.co":               "*@b.co",
		"broken":               "***",
	}
	for in, want := range cases {
		if got := maskEmail(in); got != want {
			t.Errorf("maskEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEmailLinkRateLimit(t *testing.T) {
	c := &emailLinkCounter{hits: map[string]emailLinkRec{}}
	for i := 0; i < emailLinkMax; i++ {
		if !c.take("u1") {
			t.Fatalf("attempt %d must pass", i+1)
		}
	}
	if c.take("u1") {
		t.Fatal("the fourth attempt must hit the limit")
	}
	if !c.take("u2") {
		t.Fatal("one account's limit must not lock another")
	}
}
