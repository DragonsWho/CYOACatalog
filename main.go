package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io" // Добавлен импорт io
	"log"
	"net/http"
	"net/url"
	"os"

	// "slices" // Больше не нужен для upvotes
	"strings"

	"github.com/joho/godotenv"
	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/daos"
	"github.com/pocketbase/pocketbase/models"
	"github.com/pocketbase/pocketbase/plugins/jsvm" // Убедись, что импорт jsvm есть
	"github.com/pocketbase/pocketbase/tools/security"
	// "github.com/pocketbase/pocketbase/tools/list" // импорт list для проверки среза (если понадобится)
)

//go:embed dist/*
var assets embed.FS

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

	body, err := io.ReadAll(resp.Body) // ИЗМЕНЕНО: ioutil.ReadAll -> io.ReadAll
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

	// Регистрация JS хуков (код без изменений)
	hooksDir := "pb_hooks"
	if _, err := os.Stat(hooksDir); os.IsNotExist(err) {
		log.Printf("Hooks directory '%s' not found, skipping JS hooks loading.", hooksDir)
	} else {
		jsvm.MustRegister(app, jsvm.Config{
			HooksDir: hooksDir,
			// Watch: true, // Раскомментируй для разработки, если нужно автообновление хуков
		})
		log.Printf("Registered JS hooks from directory: %s", hooksDir)
	}

	app.OnBeforeServe().Add(func(e *core.ServeEvent) error {
		apiGroup := e.Router.Group("/api/custom")

		// Эндпоинт верификации Turnstile (без изменений)
		apiGroup.POST("/verify-turnstile", func(c echo.Context) error {
			// ... (код без изменений) ...
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

		// --- Эндпоинт комментариев ---
		commentGroup := apiGroup.Group("/comments")

		type CommentPayload struct { // Переименовал для ясности
			GameID   string  `json:"game_id"`
			ParentID *string `json:"parent_id"` // Указатель, может быть nil
			Content  string  `json:"content"`
		}

		commentGroup.POST("", func(c echo.Context) error {
			// Получаем пользователя
			info := apis.RequestInfo(c)
			if info == nil || info.AuthRecord == nil {
				return apis.NewUnauthorizedError("User not authenticated", nil)
			}
			userID := info.AuthRecord.Id

			// Парсим тело запроса
			payload := new(CommentPayload)
			if err := c.Bind(payload); err != nil {
				return apis.NewBadRequestError("Invalid request body", err)
			}
			// Простая валидация
			if payload.GameID == "" || payload.Content == "" {
				return apis.NewBadRequestError("Missing game_id or content", nil)
			}

			commentID := security.RandomStringWithAlphabet(models.DefaultIdLength, models.DefaultIdAlphabet)
			var gameRecord *models.Record // Объявляем заранее для доступа к счетчику

			err := app.Dao().RunInTransaction(func(txDao *daos.Dao) error {
				// 1. Находим коллекцию комментариев
				commentsCollection, err := txDao.FindCollectionByNameOrId("comments")
				if err != nil {
					log.Printf("Error finding comments collection: %v", err)
					return apis.NewApiError(500, "Internal error finding collection", err)
				}

				// 2. Создаем новую запись комментария
				commentRecord := models.NewRecord(commentsCollection)
				commentRecord.Set("id", commentID) // Устанавливаем сгенерированный ID
				commentRecord.Set("content", payload.Content)
				commentRecord.Set("author", userID)
				commentRecord.Set("children", []string{}) // Инициализируем пустым срезом
				commentRecord.Set("game", payload.GameID) // --- ДОБАВЛЕНО: Устанавливаем связь с игрой ---

				// Устанавливаем родителя, если он есть
				if payload.ParentID != nil && *payload.ParentID != "" {
					commentRecord.Set("parent", *payload.ParentID)
				}

				// 3. Сохраняем комментарий
				if err := txDao.SaveRecord(commentRecord); err != nil {
					log.Printf("Error saving comment record: %v", err)
					return apis.NewApiError(500, "Failed to save comment", err)
				}
				log.Printf("Saved new comment %s for game %s", commentID, payload.GameID)

				// 4. Обновляем запись игры (только если это не ответ на другой коммент)
				isTopLevelComment := payload.ParentID == nil || *payload.ParentID == ""
				if isTopLevelComment {
					gameRecord, err = txDao.FindRecordById("games", payload.GameID)
					if err != nil {
						log.Printf("Error finding game record %s: %v", payload.GameID, err)
						// Не прерываем транзакцию из-за этого, но логируем
						return nil // Комментарий создан, но игра не обновилась
					}

					// Получаем текущий массив и счетчик
					commentsSlice := gameRecord.GetStringSlice("comments")
					currentCount := gameRecord.GetInt("comments_count") // Текущий счетчик

					// Добавляем новый ID и обновляем счетчик
					commentsSlice = append(commentsSlice, commentID)
					newCount := currentCount + 1 // Просто инкрементируем

					gameRecord.Set("comments", commentsSlice)
					gameRecord.Set("comments_count", newCount) // Обновляем счетчик

					if err := txDao.SaveRecord(gameRecord); err != nil {
						log.Printf("Error saving game record %s after adding comment: %v", payload.GameID, err)
						// Опять же, не прерываем транзакцию, но логируем
						return nil
					}
					log.Printf("Updated game %s comment count to %d", payload.GameID, newCount)
				} else {
					log.Printf("Comment %s is a reply, not updating game count.", commentID)
				}

				// 5. Обновляем родительский комментарий, если это ответ
				if payload.ParentID != nil && *payload.ParentID != "" {
					parentCommentRecord, err := txDao.FindRecordById("comments", *payload.ParentID)
					if err != nil {
						log.Printf("Error finding parent comment %s: %v", *payload.ParentID, err)
						// Не прерываем, но логируем
						return nil
					}
					childrenSlice := parentCommentRecord.GetStringSlice("children")
					childrenSlice = append(childrenSlice, commentID)
					parentCommentRecord.Set("children", childrenSlice)

					if err := txDao.SaveRecord(parentCommentRecord); err != nil {
						log.Printf("Error saving parent comment %s after adding child: %v", *payload.ParentID, err)
						// Не прерываем, но логируем
						return nil
					}
					log.Printf("Updated parent comment %s children array", *payload.ParentID)
				}

				return nil // Транзакция успешна
			})

			// Обработка ошибки транзакции
			if err != nil {
				// Ошибка уже должна быть залогирована внутри
				return err // Возвращаем ошибку клиенту
			}

			// Получаем итоговый счетчик, если игра обновлялась
			finalCommentCount := 0
			if gameRecord != nil {
				finalCommentCount = gameRecord.GetInt("comments_count")
			}

			// Возвращаем ID созданного комментария и итоговый счетчик (если есть)
			return c.JSON(http.StatusOK, map[string]any{
				"id":             commentID,
				"comments_count": finalCommentCount, // Добавляем счетчик в ответ
			})
		}, apis.RequireRecordAuth()) // Требуем аутентификацию

		// --- Эндпоинт лайков (код без изменений, но проверим, что он тут) ---
		upvoteGroup := apiGroup.Group("/upvotes")
		upvoteGroup.POST("/:id", func(c echo.Context) error {
			// ... (весь код для лайков, как в предыдущем шаге) ...
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
		}, apis.RequireRecordAuth()) // Требуем аутентификацию

		return nil
	}) // Конец OnBeforeServe

	// Настройка статики и прокси (без изменений)
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
				Skipper: skipper, Root: "dist", Filesystem: assets,
				Index: "index.html", HTML5: true, Browse: false,
				IgnoreBase: false, DisablePathUnescaping: false,
			},
			))
			return nil
		})
	}

	log.Fatal(app.Start()) // Запуск сервера
} // Конец main
