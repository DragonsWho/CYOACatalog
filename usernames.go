// Sane usernames on OAuth signup + "change once" rule. 1) Discord/OIDC often give a nick failing
// the username pattern (dots, unicode, too short) or already taken → PB core generates faceless
// `usersNNNNNN`. The hook sets a meaningful unique username in CreateData (nick → name → email) and
// fills empty name. 2) Author names are held by reserved stubs the pipeline creates when hosting
// their games (s06_upload._ensure_user); a real author signing up hit the NOCASE unique index
// ("already in use"). On signup and rename we now return a message linking the claim page
// <hosting_slug>.cyoa.cafe. 3) updateRule `id = @request.auth.id` lets users edit their record and
// PB rules can't restrict a SINGLE field, so "change username once" is a server guard: first change
// sets username_locked, second → 403. Requires bool field `users.username_locked` (default false).
package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// username field pattern: ^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$ (min 3, max 60).
var (
	usernameInvalidChars = regexp.MustCompile(`[^a-z0-9_-]+`)
	usernameEdgeTrim     = regexp.MustCompile(`^[_-]+|[_-]+$`)
)

const (
	usernameMinLen = 3
	usernameMaxLen = 60
)

// Arbitrary string → valid username or "". Lowercased to avoid NOCASE-index collisions.
func slugifyUsername(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.ReplaceAll(s, " ", "-") // spaces in display name → hyphens
	s = usernameInvalidChars.ReplaceAllString(s, "")
	s = usernameEdgeTrim.ReplaceAllString(s, "")
	if len(s) > usernameMaxLen {
		s = usernameEdgeTrim.ReplaceAllString(s[:usernameMaxLen], "")
	}
	if len(s) < usernameMinLen {
		return ""
	}
	return s
}

// Strip the discriminator tail. PB builds Discord Name as `username#discriminator`
// (tools/auth/discord.go); Discord abolished discriminators in 2023 and now sends "0", so names
// arrive as "cat#0". `#` is forbidden in Discord nicks, so cut at the LAST `#` and only for Discord
// — elsewhere `#` is a legit part of a name.
func cleanOAuthName(provider, name string) string {
	name = strings.TrimSpace(name)
	if provider != "discord" {
		return name
	}
	if i := strings.LastIndexByte(name, '#'); i > 0 {
		if trimmed := strings.TrimSpace(name[:i]); trimmed != "" {
			return trimmed
		}
	}
	return name
}

func emailLocalPart(email string) string {
	if i := strings.IndexByte(email, '@'); i > 0 {
		return email[:i]
	}
	return ""
}

// Case-insensitive taken check (username index is NOCASE).
func usernameTaken(app core.App, username string) bool {
	var dummy int
	err := app.ConcurrentDB().
		Select("(1)").
		From("users").
		AndWhere(dbx.NewExp("username = {:u} COLLATE NOCASE", dbx.Params{"u": username})).
		Limit(1).
		Row(&dummy)
	return err == nil && dummy > 0
}

// Append numeric suffix until free.
func uniqueUsername(app core.App, base string) string {
	base = slugifyUsername(base)
	if base == "" {
		base = "user"
	}
	for len(base) < usernameMinLen {
		base += "0"
	}
	if !usernameTaken(app, base) {
		return base
	}
	for i := 2; i < 100000; i++ {
		suffix := strconv.Itoa(i)
		trimmed := base
		if len(trimmed)+len(suffix) > usernameMaxLen {
			trimmed = trimmed[:usernameMaxLen-len(suffix)]
		}
		candidate := trimmed + suffix
		if !usernameTaken(app, candidate) {
			return candidate
		}
	}
	return base // practically unreachable
}

// Registers both hooks. Call before app.Start().
func registerUsernameHooks(app core.App) {
	// 1. OAuth signup: meaningful username instead of usersNNN + non-empty name.
	app.OnRecordAuthWithOAuth2Request("users").BindFunc(func(e *core.RecordAuthWithOAuth2RequestEvent) error {
		if !e.IsNewRecord || e.OAuth2User == nil {
			return e.Next()
		}
		if e.CreateData == nil {
			e.CreateData = map[string]any{}
		}

		// Only override username if the client didn't send one explicitly.
		if cur, _ := e.CreateData["username"].(string); strings.TrimSpace(cur) == "" {
			base := ""
			for _, cand := range []string{
				e.OAuth2User.Username,
				e.OAuth2User.Name,
				emailLocalPart(e.OAuth2User.Email),
			} {
				if s := slugifyUsername(cand); s != "" {
					base = s
					break
				}
			}
			e.CreateData["username"] = uniqueUsername(app, base)
		}

		// name: never empty, and without Discord's "#0". Our CreateData runs before core mapping
		// (record_auth_with_oauth2.go sets OAuth2User.Name only if the field is absent), so fixing it
		// here suffices.
		if cur, _ := e.CreateData["name"].(string); strings.TrimSpace(cur) == "" {
			name := cleanOAuthName(e.ProviderName, e.OAuth2User.Name)
			if name == "" {
				name, _ = e.CreateData["username"].(string)
			}
			e.CreateData["name"] = name
		}

		return e.Next()
	})

	// 2. Signup: a name reserved for an author isn't "taken" but "here's the door" — otherwise the
	// author registers as irontiger2 while their spot waits. The OAuth branch doesn't reach here (hook
	// #1 picks the username).
	app.OnRecordCreateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		info, err := e.RequestInfo()
		if err != nil {
			return e.Next()
		}
		if raw, ok := info.Body["username"]; ok {
			if newU, _ := raw.(string); strings.TrimSpace(newU) != "" {
				if holder := reservedUsernameHolder(app, strings.TrimSpace(newU)); holder != nil {
					return e.BadRequestError(reservedUsernameMessage(holder), nil)
				}
			}
		}
		return e.Next()
	})

	// 3. Guard on users self-update. PB rules can't restrict single fields, so: a) protected fields
	// are FORBIDDEN to non-superusers (else self-promotion via `{isModerator:true}`, unlocking via
	// `{username_locked:false}`, inflating hosting limits…); b) username changes only once — first
	// change sets username_locked. Superuser (admin UI) unrestricted.
	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		info, err := e.RequestInfo()
		if err != nil {
			return e.Next()
		}

		// (a) protected fields — server/admin only.
		for _, f := range protectedUserFields {
			if _, ok := info.Body[f]; ok {
				return e.ForbiddenError("Field '"+f+"' can't be edited.", nil)
			}
		}

		// (b) username — at most once.
		if raw, ok := info.Body["username"]; ok {
			newU, _ := raw.(string)
			newU = strings.TrimSpace(newU)
			// e.Record still holds the current values here (form submit happens inside e.Next()).
			oldU := e.Record.GetString("username")
			if newU != "" && newU != oldU {
				// Name may be reserved for an author — "here's the door", not "taken".
				if holder := reservedUsernameHolder(app, newU); holder != nil {
					return e.BadRequestError(reservedUsernameMessage(holder), nil)
				}
				if e.Record.GetBool("username_locked") {
					return e.ForbiddenError("Username can only be changed once.", nil)
				}
				// Latch the flag. username_locked is in protectedUserFields, so the client couldn't send it and
				// form.Submit won't overwrite it.
				e.Record.Set("username_locked", true)
			}
		}

		return e.Next()
	})
}

// Fields of `users` a regular user must NOT change (only server code via app.Save or superuser).
// verified/email are already protected by PB (require manage access).
var protectedUserFields = []string{
	"isModerator",
	"is_reserved",
	"username_locked",
	"hosting_slug",
	"hosting_max_games",
	"hosting_max_upload_mb",
	"hosting_daily_uploaded",
	"hosting_daily_reset",
}

// If the name is held by a reserved stub (created by s06_upload._ensure_user when we host an
// author's games), return it; nil for real accounts and free names. Separate from usernameTaken: a
// stub is a place reserved for the author, who needs the path to the claim page
// <hosting_slug>.cyoa.cafe, not "name taken".
func reservedUsernameHolder(app core.App, username string) *core.Record {
	var id string
	err := app.ConcurrentDB().
		Select("id").
		From("users").
		AndWhere(dbx.NewExp("username = {:u} COLLATE NOCASE", dbx.Params{"u": username})).
		AndWhere(dbx.HashExp{"is_reserved": true}).
		Limit(1).
		Row(&id)
	if err != nil || id == "" {
		return nil
	}
	rec, err := app.FindRecordById("users", id)
	if err != nil {
		return nil
	}
	return rec
}

// The URL inside the error text is intentional: AccountSettings.tsx extracts and linkifies it,
// because PB `data` can't carry custom fields (safeErrorsData collapses to {code, message}).
func reservedUsernameMessage(holder *core.Record) string {
	slug := holder.GetString("hosting_slug")
	if slug == "" {
		slug = strings.ToLower(holder.GetString("username"))
	}
	return fmt.Sprintf(
		"This username is reserved for the CYOA author it belongs to. "+
			"Their games are archived at https://%s.%s — if that author is you, "+
			"claim the page there and the username is yours.",
		slug, baseDomain)
}
