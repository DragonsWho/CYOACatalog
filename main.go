package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/daos"
	"github.com/pocketbase/pocketbase/forms"
	"github.com/pocketbase/pocketbase/models"
	"github.com/pocketbase/pocketbase/tools/security"
)

//go:embed dist/*
var assets embed.FS

func skipper(c echo.Context) bool {
	return strings.HasPrefix(c.Request().URL.Path, "/api") || strings.HasPrefix(c.Request().URL.Path, "/_")
}

func main() {
	isDevelopment := os.Getenv("NODE_ENV") == "development"

	app := pocketbase.New()
	app.OnBeforeServe().Add(func(e *core.ServeEvent) error {
		apiGroup := e.Router.Group("/api/custom")

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
				form := forms.NewRecordUpsert(app, record)
				form.SetDao(txDao)
				err = form.LoadData(map[string]any{
					"id":       commentID,
					"content":  comment.Content,
					"author":   userID,
					"children": []string{},
				})
				if err != nil {
					return fmt.Errorf("load data error: %w", err)
				}
				if err := form.Submit(); err != nil {
					return fmt.Errorf("comment submit form error: %w", err)
				}

				fmt.Println("commentID", commentID, "gameID", comment.GameID, "parentID", comment.ParentID)

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
			info := apis.RequestInfo(c)
			userID := info.AuthRecord.Id
			gameID := c.PathParam("id")
			state := true
			count := 0

			err := app.Dao().RunInTransaction(func(txDao *daos.Dao) error {
				record, err := txDao.FindRecordById("games", gameID)
				if err != nil {
					return fmt.Errorf("find game record error: %w", err)
				}

				upvotes := record.Get("upvotes").([]string)
				count = len(upvotes)
				if !slices.Contains(upvotes, userID) {
					record.Set("upvotes", append(upvotes, userID))
					count++
				} else {
					record.Set("upvotes", slices.DeleteFunc(upvotes, func(i string) bool { return i == userID }))
					state = false
					count--
				}
				err = txDao.SaveRecord(record)
				if err != nil {
					return fmt.Errorf("save game record error: %w", err)
				}

				return nil
			})
			if err != nil {
				return fmt.Errorf("run in transaction error: %w", err)
			}

			return c.JSON(http.StatusOK, map[string]any{"id": gameID, "state": state, "count": count})
		})

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
