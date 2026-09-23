// Message reactions: one toggle handler POST /api/custom/shoutbox/react. Denormalized map in the
// message record: {"fire": ["u123","u456"], "eyes": ["u123"]}. A separate collection would mean ~50
// queries per feed page or an aggregating endpoint; here reactions arrive with the text and update
// through the same realtime subscription. Names are validated against the chat_emoji pack held in
// memory (chat_emoji.go); the frontend gets the same list from the same handler, cache rebuilt by a
// record hook.
package main

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

const (
	// Max distinct reactions per message; removing your own is always allowed, the cap applies to new
	// ones only.
	shoutReactMaxKinds = 20
	// Per-reaction cap: never reached by humans, stops scripts filling the field from many accounts.
	shoutReactMaxPerKind = 500
)

// Same format as the client (SHORTCODE in richText.tsx): min 2 chars so ":3" and ":D" never become
// reactions.
var shoutReactNameRe = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)

// Read-modify-write; without a lock two simultaneous clicks overwrite each other. One global lock
// on purpose: clicks are a few per second, and a per-id lock map needs cleanup.
var shoutReactMu sync.Mutex

func shoutReactions(rec *core.Record) map[string][]string {
	return shoutReactionsField(rec, "reactions")
}

// The same map format lives in two places: message `reactions` and topic-OP `op_reactions` on the
// room record (shoutbox_community.go). Parsing and toggle are shared so caps can't drift.
func shoutReactionsField(rec *core.Record, field string) map[string][]string {
	out := map[string][]string{}
	// Errors swallowed on purpose: empty, "null" or broken JSON from a manual admin edit all mean "no
	// reactions yet".
	_ = rec.UnmarshalJSONField(field, &out)
	if out == nil {
		out = map[string][]string{}
	}
	return out
}

// Empty pack (chat_emoji missing/empty) is its own error → 503, not 400 ("we have nothing to react
// with right now").
var errShoutReactPackDown = errors.New("Reactions are not available.")

// Shared by message and OP handlers: one rule "not in pack = not a reaction", else the lesser
// handler lets in names the frontend can't draw.
func shoutReactValidName(emoji string) (string, error) {
	name := strings.TrimSpace(strings.ToLower(emoji))
	if !shoutReactNameRe.MatchString(name) {
		return "", errors.New("Bad emoji name")
	}
	pack := chatEmojiPack.validNames()
	if len(pack) == 0 {
		return "", errShoutReactPackDown
	}
	if !pack[name] {
		return "", errors.New("Unknown emoji")
	}
	return name, nil
}

// Caps checked only when adding — removing your own can't be blocked even if others overfilled the
// map.
func shoutReactToggle(reactions map[string][]string, name, uid string) error {
	uids := reactions[name]
	for i, u := range uids {
		if u != uid {
			continue
		}
		// Drop names that became empty, or the frontend gets pills with count 0.
		uids = append(uids[:i:i], uids[i+1:]...)
		if len(uids) == 0 {
			delete(reactions, name)
		} else {
			reactions[name] = uids
		}
		return nil
	}
	if _, exists := reactions[name]; !exists && len(reactions) >= shoutReactMaxKinds {
		return errors.New("Too many different reactions on this message")
	}
	if len(uids) >= shoutReactMaxPerKind {
		return errors.New("Too many reactions")
	}
	reactions[name] = append(uids, uid)
	return nil
}

func registerShoutboxReactions(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	type reactPayload struct {
		ID    string `json:"id"`
		Emoji string `json:"emoji"`
	}

	// Toggle, not "set": no separate remove handler, because the client knows current state only with
	// a delay.
	g.POST("/react", func(c *core.RequestEvent) error {
		var p reactPayload
		if err := c.BindBody(&p); err != nil || strings.TrimSpace(p.ID) == "" {
			return c.BadRequestError("Missing id", err)
		}
		name, err := shoutReactValidName(p.Emoji)
		if err != nil {
			// Empty pack: don't store unchecked names and don't pretend it saved — fail loudly.
			if errors.Is(err, errShoutReactPackDown) {
				return apis.NewApiError(http.StatusServiceUnavailable, err.Error(), nil)
			}
			return c.BadRequestError(err.Error(), nil)
		}

		shoutReactMu.Lock()
		defer shoutReactMu.Unlock()

		rec, err := app.FindRecordById(shoutboxCol, strings.TrimSpace(p.ID))
		if err != nil {
			return c.NotFoundError("Message not found", err)
		}
		// Private room: non-member → 404 not 403 (existence is private, same as shoutResolveChannel).
		if chID := rec.GetString("channel"); chID != "" {
			if ch, chErr := app.FindRecordById(shoutChannelsCol, chID); chErr == nil {
				if ch.GetBool("is_private") && !shoutIsMember(ch, c.Auth.Id) {
					return c.NotFoundError("Message not found", nil)
				}
			}
		}
		// Muted users are fully silent, including reactions.
		if shoutMutedUser(c.Auth.Id) {
			return c.ForbiddenError("You are muted.", nil)
		}

		reactions := shoutReactions(rec)
		if err := shoutReactToggle(reactions, name, c.Auth.Id); err != nil {
			return c.BadRequestError(err.Error(), nil)
		}

		rec.Set("reactions", reactions)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Failed to save reaction", err)
		}
		return c.JSON(http.StatusOK, map[string]any{"reactions": reactions})
	}).Bind(apis.RequireAuth())
}
