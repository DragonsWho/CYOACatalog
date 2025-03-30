package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"

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

	body, err := ioutil.ReadAll(resp.Body)
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
	// Указываем путь к директории с JS хуками
	hooksDir := "pb_hooks"

	if _, err := os.Stat(hooksDir); os.IsNotExist(err) {
		log.Printf("Hooks directory '%s' not found, skipping JS hooks loading.", hooksDir)
	} else {
		// Передаем только HooksDir, остальные параметры будут по умолчанию
		jsvm.MustRegister(app, jsvm.Config{
			HooksDir: hooksDir,
		})
		log.Printf("Registered JS hooks from directory: %s", hooksDir)
	}

	app.OnBeforeServe().Add(func(e *core.ServeEvent) error {
		apiGroup := e.Router.Group("/api/custom")

		// Endpoint for Turnstile (cloudflare captha) token validation
		apiGroup.POST("/verify-turnstile", func(c echo.Context) error {
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

		type Comment struct {
			GameID   string  `json:"game_id"`
			ParentID *string `json:"parent_id"`
			Content  string  `json:"content"`
		}

		commentGroup.POST("", func(c echo.Context) error {
			info := apis.RequestInfo(c)
			userID := info.AuthRecord.Id
			comment := new(Comment)
			if err := c.Bind(comment); err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, err.Error())
			}
			commentID := security.RandomStringWithAlphabet(models.DefaultIdLength, models.DefaultIdAlphabet)

			err := app.Dao().RunInTransaction(func(txDao *daos.Dao) error {
				collection, err := txDao.FindCollectionByNameOrId("comments")
				if err != nil {
					return fmt.Errorf("find collection error: %w", err)
				}
				record := models.NewRecord(collection)
				record.Set("id", commentID)
				record.Set("content", comment.Content)
				record.Set("author", userID)
				record.Set("children", []string{})
				if comment.ParentID != nil {
					record.Set("parent", *comment.ParentID)
				}
				err = txDao.SaveRecord(record)
				if err != nil {
					return fmt.Errorf("comment save record error: %w", err)
				}

				record, err = txDao.FindRecordById("games", comment.GameID)
				if err != nil {
					return fmt.Errorf("find game record error: %w", err)
				}
				record.Set("comments", append(record.Get("comments").([]string), commentID))
				err = txDao.SaveRecord(record)
				if err != nil {
					return fmt.Errorf("save game record error: %w", err)
				}

				if comment.ParentID != nil {
					record, err := txDao.FindRecordById("comments", *comment.ParentID)
					if err != nil {
						return fmt.Errorf("find parent comment record error: %w", err)
					}
					record.Set("children", append(record.Get("children").([]string), commentID))
					err = txDao.SaveRecord(record)
					if err != nil {
						return fmt.Errorf("save parent comment record error: %w", err)
					}
				}

				return nil
			})
			if err != nil {
				return fmt.Errorf("run in transaction error: %w", err)
			}

			return c.JSON(http.StatusOK, map[string]any{"id": commentID})
		})

		upvoteGroup := apiGroup.Group("/upvotes")

		upvoteGroup.POST("/:id", func(c echo.Context) error {
			// Получаем информацию о пользователе и ID игры
			info := apis.RequestInfo(c)
			if info == nil || info.AuthRecord == nil {
				return apis.NewUnauthorizedError("User not authenticated", nil) // Добавлена проверка авторизации
			}
			userID := info.AuthRecord.Id
			gameID := c.PathParam("id")

			// Переменные для результата
			var finalState bool // true если лайк поставлен, false если снят
			var finalCount int  // Итоговое количество лайков

			// Выполняем операцию в транзакции
			err := app.Dao().RunInTransaction(func(txDao *daos.Dao) error {
				// Находим запись игры
				record, err := txDao.FindRecordById("games", gameID)
				if err != nil {
					log.Printf("Error finding game %s: %v", gameID, err) // Логируем ошибку
					return apis.NewNotFoundError("Game not found", err)
				}

				// Получаем текущий массив лайков
				// Используем GetStringSlice для работы со срезом строк
				upvotes := record.GetStringSlice("upvotes") // ИЗМЕНЕНО: record.Get("upvotes").([]string) -> GetStringSlice

				// Проверяем, лайкнул ли уже пользователь
				userLiked := false
				userIndex := -1
				for i, id := range upvotes {
					if id == userID {
						userLiked = true
						userIndex = i
						break
					}
				}

				// Обновляем массив лайков
				if !userLiked {
					// Добавляем лайк
					upvotes = append(upvotes, userID)
					finalState = true
				} else {
					// Удаляем лайк (более безопасный способ)
					if userIndex >= 0 {
						upvotes = append(upvotes[:userIndex], upvotes[userIndex+1:]...)
					}
					finalState = false
				}

				// --- ДОБАВЛЕНА ЛОГИКА ПОДСЧЕТА ---
				// Считаем итоговое количество лайков
				finalCount = len(upvotes)
				// Обновляем поле upvotes_count в записи
				record.Set("upvotes_count", finalCount)
				// ---------------------------------

				// Устанавливаем обновленный массив лайков
				record.Set("upvotes", upvotes)

				// Сохраняем запись
				if err := txDao.SaveRecord(record); err != nil {
					log.Printf("Error saving game %s: %v", gameID, err) // Логируем ошибку сохранения
					return apis.NewApiError(500, "Failed to save game record", err)
				}

				log.Printf("Game %s updated. User %s action: %t. New upvote count: %d", gameID, userID, finalState, finalCount) // Лог успеха

				return nil // Транзакция успешна
			})

			// Обработка ошибки транзакции
			if err != nil {
				// Ошибка уже залогирована внутри транзакции
				// Возвращаем ошибку клиенту (NewNotFoundError или NewApiError)
				return err
			}

			// Возвращаем успешный ответ клиенту с итоговым состоянием и счетчиком
			return c.JSON(http.StatusOK, map[string]any{
				"id":    gameID,
				"state": finalState,
				"count": finalCount, // Возвращаем актуальный счетчик
			})
		}) // Конец обработчика POST

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
			e.Router.Use(middleware.StaticWithConfig(
				middleware.StaticConfig{
					Skipper:               skipper,
					Root:                  "dist",
					Filesystem:            assets,
					Index:                 "index.html",
					HTML5:                 true,
					Browse:                false,
					IgnoreBase:            false,
					DisablePathUnescaping: false,
				},
			))
			return nil
		})
	}

	log.Fatal(app.Start())
}
