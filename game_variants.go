// Moderator edits of language/version variants (hybrid model, see wiki multilang-variants-spec).
// `games` holds the original's content; other languages/versions live in `game_variants`
// (updateRule admin-only in the schema), so this handler writes via app.Save, bypassing API rules
// like game_edits.go. UI replacement for PB/add_game_variant.py.
package main

import (
	"net/http"
	"slices"
	"strings"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const variantsColl = "game_variants"

const (
	maxVariantLangLen  = 8
	maxVariantLabelLen = 60
	maxVariantTitleLen = maxTitleLen
	maxVariantDescLen  = maxDescLen
	maxVariantLinkLen  = maxLinkLen
)

// Language (ISO 639-1) → Language-category tag id, so a game with a translation shows up under the
// catalog language filter. Maintained by hand; keep in sync with PB/add_game_variant.py:LANG_TAG.
var langTagID = map[string]string{
	"ko": "mid7ua6j8pgsepj",
}

// Unknown languages are skipped silently; a tag can be created and attached later.
func ensureCanonLangTag(app core.App, canon *core.Record, language string) {
	tagID, ok := langTagID[strings.ToLower(language)]
	if !ok {
		return
	}
	tags := canon.GetStringSlice("tags")
	if slices.Contains(tags, tagID) {
		return
	}
	canon.Set("tags", append(tags, tagID))
	if err := app.Save(canon); err != nil {
		app.Logger().Warn("variant lang tag save failed", "game", canon.Id, "error", err.Error())
	}
}

type variantPayload struct {
	Language     *string `json:"language"`
	VersionLabel *string `json:"version_label"`
	Title        *string `json:"title"`
	Description  *string `json:"description"`
	IframeURL    *string `json:"iframe_url"`
	ImgOrLink    *string `json:"img_or_link"`
}

func applyVariantFields(c *core.RequestEvent, variant *core.Record, p *variantPayload) error {
	if p.Language != nil {
		v := strings.ToLower(strings.TrimSpace(*p.Language))
		if v == "" {
			return c.BadRequestError("language cannot be empty", nil)
		}
		if len(v) > maxVariantLangLen {
			return c.BadRequestError("language is too long", nil)
		}
		variant.Set("language", v)
	}
	if p.VersionLabel != nil {
		v := strings.TrimSpace(*p.VersionLabel)
		if len(v) > maxVariantLabelLen {
			return c.BadRequestError("version_label is too long", nil)
		}
		variant.Set("version_label", v)
	}
	if p.Title != nil {
		v := strings.TrimSpace(*p.Title)
		if len(v) > maxVariantTitleLen {
			return c.BadRequestError("title is too long", nil)
		}
		variant.Set("title", v)
	}
	if p.Description != nil {
		v := strings.TrimSpace(*p.Description)
		if len(v) > maxVariantDescLen {
			return c.BadRequestError("description is too long", nil)
		}
		variant.Set("description", v)
	}
	if p.IframeURL != nil {
		v := strings.TrimSpace(*p.IframeURL)
		if len(v) > maxVariantLinkLen {
			return c.BadRequestError("iframe_url is too long", nil)
		}
		variant.Set("iframe_url", v)
	}
	if p.ImgOrLink != nil {
		if *p.ImgOrLink != "img" && *p.ImgOrLink != "link" {
			return c.BadRequestError("img_or_link must be 'img' or 'link'", nil)
		}
		variant.Set("img_or_link", *p.ImgOrLink)
	}
	return nil
}

func registerGameVariants(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		g := e.Router.Group("/api/custom")

		g.POST("/games/{id}/variants", func(c *core.RequestEvent) error {
			if !isModOrSuper(c) {
				return apis.NewForbiddenError("Moderator only", nil)
			}
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			payload := new(variantPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			if payload.Language == nil || strings.TrimSpace(*payload.Language) == "" {
				return c.BadRequestError("language is required", nil)
			}
			language := strings.ToLower(strings.TrimSpace(*payload.Language))
			versionLabel := ""
			if payload.VersionLabel != nil {
				versionLabel = strings.TrimSpace(*payload.VersionLabel)
			}

			// Idempotent like add_game_variant.py: (game, language, version_label) is unique — edit the
			// existing variant.
			existing, _ := app.FindFirstRecordByFilter(
				variantsColl, "game = {:game} && language = {:language} && version_label = {:label}",
				map[string]any{"game": game.Id, "language": language, "label": versionLabel},
			)
			if existing != nil {
				return c.BadRequestError("A variant for this language/version already exists — edit it instead", nil)
			}

			coll, err := app.FindCollectionByNameOrId(variantsColl)
			if err != nil {
				return c.InternalServerError("variants collection missing", err)
			}
			variant := core.NewRecord(coll)
			variant.Set("game", game.Id)
			variant.Set("img_or_link", game.GetString("img_or_link"))
			if err := applyVariantFields(c, variant, payload); err != nil {
				return err
			}
			if err := app.Save(variant); err != nil {
				return c.BadRequestError("Save failed", err)
			}

			ensureCanonLangTag(app, game, language)
			purgeGamePage(app, game.Id)
			logModAction(app, c, modAction{
				Action: "variant.create", Target: variantsColl + ":" + variant.Id, Game: game.Id,
				After:      modSnapshot(variant, "language", "version_label", "title", "iframe_url"),
				Reversible: true,
			})
			return c.JSON(http.StatusOK, variant)
		})

		g.POST("/games/{id}/variants/{variantId}/edit", func(c *core.RequestEvent) error {
			if !isModOrSuper(c) {
				return apis.NewForbiddenError("Moderator only", nil)
			}
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			variant, err := app.FindRecordById(variantsColl, c.Request.PathValue("variantId"))
			if err != nil || variant.GetString("game") != game.Id {
				return apis.NewNotFoundError("Variant not found", nil)
			}
			payload := new(variantPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			variantFields := []string{"language", "version_label", "title", "description", "iframe_url"}
			before := modSnapshot(variant, variantFields...)
			if err := applyVariantFields(c, variant, payload); err != nil {
				return err
			}
			if err := app.Save(variant); err != nil {
				return c.BadRequestError("Save failed", err)
			}

			ensureCanonLangTag(app, game, variant.GetString("language"))
			purgeGamePage(app, game.Id)
			logModAction(app, c, modAction{
				Action: "variant.update", Target: variantsColl + ":" + variant.Id, Game: game.Id,
				Before: before, After: modSnapshot(variant, variantFields...), Reversible: true,
			})
			return c.JSON(http.StatusOK, variant)
		})

		g.POST("/games/{id}/variants/{variantId}/delete", func(c *core.RequestEvent) error {
			if !isModOrSuper(c) {
				return apis.NewForbiddenError("Moderator only", nil)
			}
			game, err := app.FindRecordById("games", c.Request.PathValue("id"))
			if err != nil {
				return apis.NewNotFoundError("Game not found", err)
			}
			variant, err := app.FindRecordById(variantsColl, c.Request.PathValue("variantId"))
			if err != nil || variant.GetString("game") != game.Id {
				return apis.NewNotFoundError("Variant not found", nil)
			}
			snapshot := modSnapshot(variant, "language", "version_label", "title", "description", "iframe_url")
			if err := app.Delete(variant); err != nil {
				return c.BadRequestError("Delete failed", err)
			}
			purgeGamePage(app, game.Id)
			logModAction(app, c, modAction{
				Action: "variant.delete", Target: variantsColl + ":" + variant.Id, Game: game.Id,
				Before: snapshot, Reversible: true, Note: "undo = add the variant again with these fields",
			})
			return c.JSON(http.StatusOK, map[string]any{"success": true})
		})

		return e.Next()
	})
}
