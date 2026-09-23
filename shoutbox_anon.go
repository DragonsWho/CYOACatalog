// Anonymous mask: the signature readers see instead of a name ("Anon Fox"). Before: name derived
// client-side from anon_key = hash(IP, salt, week window) — untraceable beyond a week, but names
// changed by themselves. Author asked for a months-long, self-chosen mask (decision 2026-09-16).
// Now the BROWSER keeps the mask (localStorage, anonMask.ts) and sends it with each message; the
// server validates it and stores it in anon_mask. What the mask is NOT: an identity — mutes, rate
// limits and delete rights still hang on the server-computed anon_key; a copied mask gives only a
// signature, no rights or history; and it doesn't prove two messages share an author. Old messages
// have an empty field and the client derives the name from anon_key (anonIdentity.ts), so an empty
// mask is normal and silently accepted.
package main

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/pocketbase/pocketbase/core"
)

const (
	shoutAnonMaskMin = 2
	shoutAnonMaskMax = 16
)

// Words that impersonate staff ("Anon Moderator"), not profanity (shoutBlockedWords handles that).
// Checked PER WORD, not substring ("Anon Modest" is fine).
var shoutAnonMaskReserved = map[string]bool{
	"admin": true, "administrator": true, "mod": true, "mods": true,
	"moderator": true, "staff": true, "official": true, "owner": true,
	"system": true, "server": true, "support": true, "bot": true,
	"dev": true, "developer": true, "team": true,
}

func shoutAnonMaskClean(raw string) (string, error) {
	// The input shows a grey "Anon " prefix and half of people type it again (sometimes twice) — strip
	// silently in a loop.
	s := strings.Join(strings.Fields(strings.TrimPrefix(raw, "\ufeff")), " ")
	for {
		low := strings.ToLower(s)
		if low == "anon" || low == "anonymous" {
			return "", nil
		}
		if strings.HasPrefix(low, "anon ") {
			s = s[len("anon "):]
			continue
		}
		if strings.HasPrefix(low, "anonymous ") {
			s = s[len("anonymous "):]
			continue
		}
		break
	}
	if s == "" {
		return "", nil
	}

	if n := utf8.RuneCountInString(s); n < shoutAnonMaskMin || n > shoutAnonMaskMax {
		return "", errors.New("Mask must be 2–16 characters.")
	}
	// Letters of any script (Cyrillic common), digits, space, hyphen, apostrophe. Nothing else:
	// markdown/emoji shortcodes/control chars break the author line and allow markup spoofing ("Anon
	// **Fox**").
	for _, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
		case r == ' ' || r == '-' || r == '\'':
		default:
			return "", errors.New("Mask can only have letters, digits, spaces, - and '.")
		}
	}
	for _, w := range strings.Fields(strings.ToLower(s)) {
		if shoutAnonMaskReserved[strings.Trim(w, "-'")] {
			return "", errors.New("That mask looks like a staff name — pick another.")
		}
	}
	return s, nil
}

// PB silently DROPS writes to nonexistent fields — without this check "schema not applied" looks
// like a bug.
func shoutRecHasField(rec *core.Record, name string) bool {
	return rec != nil && rec.Collection() != nil && rec.Collection().Fields.GetByName(name) != nil
}

func shoutApplyAnonMask(rec *core.Record, raw string) error {
	mask, err := shoutAnonMaskClean(raw)
	if err != nil {
		return err
	}
	// No field yet → skip silently; never fail a message over a signature.
	if mask == "" || !shoutRecHasField(rec, "anon_mask") {
		return nil
	}
	rec.Set("anon_mask", mask)
	return nil
}
