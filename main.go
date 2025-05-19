// ... другие импорты ...
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time" // <<< ДОБАВЛЕНО

	"github.com/golang-jwt/jwt/v5" // <<< ДОБАВЛЕНО
	"github.com/joho/godotenv"
	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/daos"
	"github.com/pocketbase/pocketbase/models"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/tools/security"
)

//go:embed dist/*
var assets embed.FS

type TurnstileResponse struct {
	Success    bool     `json:"success"`
	ErrorCodes []string `json:"error-codes"`
}

func verifyTurnstile(token string) (bool, error) {
	// ... ваш код ...
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

func skipper(c echo.Context) bool {
	return strings.HasPrefix(c.Request().URL.Path, "/api") || strings.HasPrefix(c.Request().URL.Path, "/_")
}

func main() {

	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using environment variables")
	}

	isDevelopment := os.Getenv("NODE_ENV") == "development"

	app := pocketbase.New()

	// Удаляем предыдущий хук app.OnRecordAuthRequest(), если он был добавлен для SSO
	// Он нам больше не нужен в том виде для модификации JWT.

	hooksDir := "pb_hooks"
	if _, err := os.Stat(hooksDir); os.IsNotExist(err) {
		log.Printf("Hooks directory '%s' not found, skipping JS hooks loading.", hooksDir)
	} else {
		jsvm.MustRegister(app, jsvm.Config{
			HooksDir: hooksDir,
		})
		log.Printf("Registered JS hooks from directory: %s", hooksDir)
	}

	app.OnBeforeServe().Add(func(e *core.ServeEvent) error {
		// Внутри app.OnBeforeServe().Add(func(e *core.ServeEvent) error { ... })

		// --- НАЧАЛО: Определение или получение apiGroup ---
		// ИЩИТЕ В ВАШЕМ КОДЕ СТРОКУ, ПОХОЖУЮ НА ЭТУ, ГДЕ СОЗДАЕТСЯ ГРУППА /api/custom
		// Если она уже есть, используйте ту же переменную.
		// Если ее нет (что маловероятно, если у вас есть эндпоинты /verify-turnstile и т.д.),
		// то раскомментируйте и используйте следующую строку:
		var apiGroup *echo.Group // Объявляем переменную здесь

		// Попытка найти существующее определение apiGroup в вашем коде выше этого блока.
		// Если вы уже объявляете `apiGroup := e.Router.Group("/api/custom")` где-то выше в этой функции,
		// то эта переменная `apiGroup` уже будет доступна, и следующая строка не нужна (или ее нужно адаптировать).
		// Для чистоты, лучше всего объявить `apiGroup` один раз в начале этой функции OnBeforeServe.

		// Если вы НЕ МОЖЕТЕ найти, где `apiGroup` создается для ваших других эндпоинтов /api/custom/*,
		// тогда создайте его здесь:
		if apiGroup == nil { // Эта проверка сработает, если apiGroup не был присвоен ранее в этой функции
			apiGroup = e.Router.Group("/api/custom")
			// Если вы уверены, что `apiGroup` уже создан выше, эту строку можно удалить,
			// и компилятор подскажет, если переменная `apiGroup` не определена.
		}
		// --- КОНЕЦ: Определение или получение apiGroup ---

		// --- НАЧАЛО: Кастомный эндпоинт для генерации Flarum SSO JWT ---
		// Теперь используем `apiGroup` для добавления нового маршрута
		apiGroup.GET("/sso/flarum-token", func(c echo.Context) error {
			requestInfo := apis.RequestInfo(c)
			if requestInfo == nil || requestInfo.AuthRecord == nil {
				return apis.NewUnauthorizedError("User not authenticated to generate Flarum token.", nil)
			}

			authRecord := requestInfo.AuthRecord

			jwtSecret := os.Getenv("POCKETBASE_TOKEN_SIGN_KEY") // Используйте вашу переменную для JWT секрета
			if jwtSecret == "" {
				log.Println("ERROR: POCKETBASE_TOKEN_SIGN_KEY (or your JWT secret env var) is not set for Flarum SSO token generation.")
				return apis.NewApiError(http.StatusInternalServerError, "SSO configuration error.", nil)
			}

			flarumUserAttrs := map[string]interface{}{
				"email":            authRecord.Email(),
				"username":         authRecord.Username(),
				"isEmailConfirmed": authRecord.Verified(),
			}

			avatarFilename := authRecord.GetString("avatar")
			if avatarFilename != "" {
				baseUrl := "https://cyoa.cafe"
				flarumUserAttrs["avatarUrl"] = fmt.Sprintf("%s/api/files/%s/%s/%s", baseUrl, authRecord.Collection().Id, authRecord.Id, avatarFilename)
			} else {
				flarumUserAttrs["avatarUrl"] = ""
			}

			claims := jwt.MapClaims{
				"iss": "https://cyoa.cafe",
				"aud": "https://forum.cyoa.cafe",
				"iat": time.Now().Unix(),
				"exp": time.Now().Add(time.Hour * 1).Unix(),
				"sub": authRecord.Id,
				"user": map[string]interface{}{
					"id":         authRecord.Id,
					"attributes": flarumUserAttrs,
				},
			}

			token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
			signedToken, err := token.SignedString([]byte(jwtSecret))
			if err != nil {
				log.Printf("Error signing Flarum SSO token: %v", err)
				return apis.NewApiError(http.StatusInternalServerError, "Failed to generate SSO token.", err)
			}

			return c.JSON(http.StatusOK, map[string]string{
				"flarum_sso_token": signedToken,
			})
		}, apis.RequireRecordAuth())
		// --- КОНЕЦ: Кастомный эндпоинт ---

		// --- Ваш существующий код для /api/custom/verify-turnstile, /comments, /upvotes ---
		// Убедитесь, что он находится в правильном месте относительно `apiGroup`
		// Если вы определяли `apiGroup` ранее в этой функции, он должен быть здесь.
		// Например:
		apiGroup.POST("/verify-turnstile", func(c echo.Context) error {
			// ... ваш код ...
			token := c.FormValue("token")
			if token == "" {
				return c.JSON(http.StatusBadRequest, map[string]string{"error": "Token required"})
			}
			success, err := verifyTurnstile(token)
			if err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}
			if !success {
				return c.JSON(http.StatusForbidden, map[string]string{"error": "Turnstile verification failed"})
			}
			return c.JSON(http.StatusOK, map[string]bool{"success": true})
		})

		commentGroup := apiGroup.Group("/comments")
		type CommentPayload struct {
			GameID   string  `json:"game_id"`
			ParentID *string `json:"parent_id"`
			Content  string  `json:"content"`
		}
		commentGroup.POST("", func(c echo.Context) error {
			// ... ваш код ...
			info := apis.RequestInfo(c)
			if info == nil || info.AuthRecord == nil {
				return apis.NewUnauthorizedError("User not authenticated", nil)
			}
			userID := info.AuthRecord.Id
			payload := new(CommentPayload)
			if err := c.Bind(payload); err != nil {
				return apis.NewBadRequestError("Invalid request body", err)
			}
			if payload.GameID == "" || payload.Content == "" {
				return apis.NewBadRequestError("Missing game_id or content", nil)
			}
			commentID := security.RandomStringWithAlphabet(models.DefaultIdLength, models.DefaultIdAlphabet)
			var gameRecord *models.Record
			err := app.Dao().RunInTransaction(func(txDao *daos.Dao) error {
				commentsCollection, err := txDao.FindCollectionByNameOrId("comments")
				if err != nil {
					log.Printf("Error finding comments collection: %v", err)
					return apis.NewApiError(500, "Internal error finding collection", err)
				}
				commentRecord := models.NewRecord(commentsCollection)
				commentRecord.Set("id", commentID)
				commentRecord.Set("content", payload.Content)
				commentRecord.Set("author", userID)
				commentRecord.Set("children", []string{})
				commentRecord.Set("game", payload.GameID)
				if payload.ParentID != nil && *payload.ParentID != "" {
					commentRecord.Set("parent", *payload.ParentID)
				}
				if err := txDao.SaveRecord(commentRecord); err != nil {
					log.Printf("Error saving comment record: %v", err)
					return apis.NewApiError(500, "Failed to save comment", err)
				}
				log.Printf("Saved new comment %s for game %s", commentID, payload.GameID)
				isTopLevelComment := payload.ParentID == nil || *payload.ParentID == ""
				if isTopLevelComment {
					gameRecord, err = txDao.FindRecordById("games", payload.GameID)
					if err != nil {
						log.Printf("Error finding game record %s: %v", payload.GameID, err)
						return nil
					}
					commentsSlice := gameRecord.GetStringSlice("comments")
					currentCount := gameRecord.GetInt("comments_count")
					commentsSlice = append(commentsSlice, commentID)
					newCount := currentCount + 1
					gameRecord.Set("comments", commentsSlice)
					gameRecord.Set("comments_count", newCount)
					if err := txDao.SaveRecord(gameRecord); err != nil {
						log.Printf("Error saving game record %s after adding comment: %v", payload.GameID, err)
						return nil
					}
					log.Printf("Updated game %s comment count to %d", payload.GameID, newCount)
				} else {
					log.Printf("Comment %s is a reply, not updating game count.", commentID)
				}
				if payload.ParentID != nil && *payload.ParentID != "" {
					parentCommentRecord, err := txDao.FindRecordById("comments", *payload.ParentID)
					if err != nil {
						log.Printf("Error finding parent comment %s: %v", *payload.ParentID, err)
						return nil
					}
					childrenSlice := parentCommentRecord.GetStringSlice("children")
					childrenSlice = append(childrenSlice, commentID)
					parentCommentRecord.Set("children", childrenSlice)
					if err := txDao.SaveRecord(parentCommentRecord); err != nil {
						log.Printf("Error saving parent comment %s after adding child: %v", *payload.ParentID, err)
						return nil
					}
					log.Printf("Updated parent comment %s children array", *payload.ParentID)
				}
				return nil
			})
			if err != nil {
				return err
			}
			finalCommentCount := 0
			if gameRecord != nil {
				finalCommentCount = gameRecord.GetInt("comments_count")
			}
			return c.JSON(http.StatusOK, map[string]any{
				"id":             commentID,
				"comments_count": finalCommentCount,
			})
		}, apis.RequireRecordAuth())

		upvoteGroup := apiGroup.Group("/upvotes")
		upvoteGroup.POST("/:id", func(c echo.Context) error {
			// ... ваш код ...
			info := apis.RequestInfo(c)
			if info == nil || info.AuthRecord == nil {
				return apis.NewUnauthorizedError("User not authenticated", nil)
			}
			userID := info.AuthRecord.Id
			gameID := c.PathParam("id")
			var finalState bool
			var finalCount int
			err := app.Dao().RunInTransaction(func(txDao *daos.Dao) error {
				record, err := txDao.FindRecordById("games", gameID)
				if err != nil {
					log.Printf("Error finding game %s: %v", gameID, err)
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
				if !userLiked {
					upvotes = append(upvotes, userID)
					finalState = true
				} else {
					if userIndex >= 0 {
						upvotes = append(upvotes[:userIndex], upvotes[userIndex+1:]...)
					}
					finalState = false
				}
				finalCount = len(upvotes)
				record.Set("upvotes_count", finalCount)
				record.Set("upvotes", upvotes)
				if err := txDao.SaveRecord(record); err != nil {
					log.Printf("Error saving game %s: %v", gameID, err)
					return apis.NewApiError(500, "Failed to save game record", err)
				}
				log.Printf("Game %s updated. User %s action: %t. New upvote count: %d", gameID, userID, finalState, finalCount)
				return nil
			})
			if err != nil {
				return err
			}
			return c.JSON(http.StatusOK, map[string]any{"id": gameID, "state": finalState, "count": finalCount})
		}, apis.RequireRecordAuth())
		// ---------------------------------------------------------------------------------
		return nil
	})

	if isDevelopment {
		proxyURL, err := url.Parse("http://localhost:8091")
		if err != nil {
			log.Fatal(err)
		}
		app.OnBeforeServe().Add(func(e *core.ServeEvent) error {
			e.Router.Use(middleware.ProxyWithConfig(middleware.ProxyConfig{
				Skipper:  skipper,
				Balancer: middleware.NewRoundRobinBalancer([]*middleware.ProxyTarget{{URL: proxyURL}}),
			}))
			return nil
		})
	} else {
		app.OnBeforeServe().Add(func(e *core.ServeEvent) error {
			e.Router.Use(middleware.StaticWithConfig(middleware.StaticConfig{
				Skipper:    skipper,
				Root:       "dist",
				Filesystem: assets,
				Index:      "index.html",
				HTML5:      true,
				Browse:     false,
			}))
			return nil
		})
	}

	log.Fatal(app.Start())
}
