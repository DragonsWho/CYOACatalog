package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"

	"github.com/joho/godotenv"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

//go:embed all:dist
var assets embed.FS

// --- Вспомогательная логика для Turnstile ---
type TurnstileResponse struct {
	Success    bool     `json:"success"`
	ErrorCodes []string `json:"error-codes"`
}

func verifyTurnstile(token string) (bool, error) {
	secretKey := os.Getenv("TURNSTILE_SECRET_KEY")
	if secretKey == "" {
		return false, fmt.Errorf("TURNSTILE_SECRET_KEY is not set")
	}
	data := url.Values{}
	data.Set("secret", secretKey)
	data.Set("response", token)
	resp, err := http.PostForm("https://challenges.cloudflare.com/turnstile/v0/siteverify", data)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, err
	}
	var turnstileResp TurnstileResponse
	if err := json.Unmarshal(body, &turnstileResp); err != nil {
		return false, err
	}
	return turnstileResp.Success, nil
}

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("Info: No .env file found, using environment variables.")
	}

	app := pocketbase.New()

	// --- Блок с JS-хуками ---
	hooksDir := "pb_hooks"
	if _, err := os.Stat(hooksDir); os.IsNotExist(err) {
		log.Printf("Info: Hooks directory '%s' not found, skipping JS hooks loading.", hooksDir)
	} else {
		jsvm.MustRegister(app, jsvm.Config{HooksDir: hooksDir})
		log.Printf("Info: Registered JS hooks from directory: %s", hooksDir)
	}

	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		apiGroup := e.Router.Group("/api/custom")

		// --- Эндпоинт для Turnstile ---
		apiGroup.POST("/verify-turnstile", func(c *core.RequestEvent) error {
			token := c.Request.FormValue("token")
			if token == "" {
				return c.BadRequestError("Token required", nil)
			}
			success, err := verifyTurnstile(token)
			if err != nil {
				return c.InternalServerError("Failed to verify token", err)
			}
			if !success {
				return c.ForbiddenError("Turnstile verification failed", nil)
			}
			return c.JSON(http.StatusOK, map[string]bool{"success": true})
		})

		// --- Эндпоинт для комментариев ---
		type CommentPayload struct {
			GameID   string  `json:"game_id"`
			ParentID *string `json:"parent_id"`
			Content  string  `json:"content"`
		}
		apiGroup.POST("/comments", func(c *core.RequestEvent) error {
			userID := c.Auth.Id
			payload := new(CommentPayload)
			if err := c.BindBody(payload); err != nil {
				return c.BadRequestError("Invalid request body", err)
			}
			if payload.GameID == "" || payload.Content == "" {
				return c.BadRequestError("Missing game_id or content", nil)
			}
			var newComment *core.Record
			var gameRecord *core.Record
			err := app.RunInTransaction(func(txApp core.App) error {
				commentsCollection, err := txApp.FindCollectionByNameOrId("comments")
				if err != nil {
					return fmt.Errorf("failed to find comments collection: %w", err)
				}
				newComment = core.NewRecord(commentsCollection)
				newComment.Set("content", payload.Content)
				newComment.Set("author", userID)
				newComment.Set("game", payload.GameID)
				if payload.ParentID != nil && *payload.ParentID != "" {
					newComment.Set("parent", *payload.ParentID)
				}
				if err := txApp.Save(newComment); err != nil {
					return fmt.Errorf("failed to save comment: %w", err)
				}
				if payload.ParentID != nil && *payload.ParentID != "" {
					parent, err := txApp.FindRecordById("comments", *payload.ParentID)
					if err != nil {
						log.Printf("Warning: could not find parent comment %s: %v", *payload.ParentID, err)
					} else {
						parent.Set("children+", newComment.Id)
						if err := txApp.Save(parent); err != nil {
							return fmt.Errorf("failed to update parent comment: %w", err)
						}
					}
				} else {
					gameRecord, err = txApp.FindRecordById("games", payload.GameID)
					if err != nil {
						log.Printf("Warning: could not find game %s to update: %v", payload.GameID, err)
					} else {
						gameRecord.Set("comments+", newComment.Id)
						gameRecord.Set("comments_count", len(gameRecord.GetStringSlice("comments")))
						if err := txApp.Save(gameRecord); err != nil {
							return fmt.Errorf("failed to update game record: %w", err)
						}
					}
				}
				return nil
			})
			if err != nil {
				return c.InternalServerError("Comment creation failed", err)
			}
			finalCommentCount := 0
			if gameRecord != nil {
				finalCommentCount = gameRecord.GetInt("comments_count")
			}
			return c.JSON(http.StatusOK, map[string]any{"id": newComment.Id, "comments_count": finalCommentCount})
		}).Bind(apis.RequireAuth())

		// --- Эндпоинт для апвоутов ---
		// <<< ИЗМЕНЕНИЕ: /upvotes/:id -> /upvotes/{id}
		apiGroup.POST("/upvotes/{id}", func(c *core.RequestEvent) error {
			userID := c.Auth.Id
			gameID := c.Request.PathValue("id")

			var finalState bool
			var finalCount int

			err := app.RunInTransaction(func(txApp core.App) error {
				record, err := txApp.FindRecordById("games", gameID)
				if err != nil {
					log.Printf("Upvote error: failed to find game %s. Actual error: %v", gameID, err)
					return apis.NewNotFoundError("Game not found", err)
				}

				upvotes := record.GetStringSlice("upvotes")
				userLiked := false
				userIndex := -1

				for i, id := range upvotes {
					if id == userID {
						userLiked = true
						userIndex = i
						break
					}
				}

				if userLiked {
					upvotes = append(upvotes[:userIndex], upvotes[userIndex+1:]...)
					finalState = false
				} else {
					upvotes = append(upvotes, userID)
					finalState = true
				}

				finalCount = len(upvotes)
				record.Set("upvotes", upvotes)
				record.Set("upvotes_count", finalCount)

				return txApp.Save(record)
			})

			if err != nil {
				return err
			}

			return c.JSON(http.StatusOK, map[string]any{"id": gameID, "state": finalState, "count": finalCount})
		}).Bind(apis.RequireAuth())

		// --- Блок обслуживания фронтенда ---
		isDevelopment := os.Getenv("NODE_ENV") == "development"
		if isDevelopment {
			log.Println("Info: Running in development mode. Proxying frontend requests to http://localhost:8091")
			remoteUrl, err := url.Parse("http://localhost:8091")
			if err != nil {
				return err
			}
			proxy := httputil.NewSingleHostReverseProxy(remoteUrl)
			e.Router.GET("/{path...}", func(c *core.RequestEvent) error {
				proxy.ServeHTTP(c.Response, c.Request)
				return nil
			})
		} else {
			log.Println("Info: Running in production mode. Serving static files from embedded 'dist' directory.")
			distDirFS, err := fs.Sub(assets, "dist")
			if err != nil {
				return err
			}
			e.Router.GET("/{path...}", apis.Static(distDirFS, true))
		}

		return e.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
