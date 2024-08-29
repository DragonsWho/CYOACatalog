package main

import (
	"embed"
	"log"
	"net/url"
	"os"
	"strings"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

//go:embed dist/*
var assets embed.FS

func skipper(c echo.Context) bool {
	return strings.HasPrefix(c.Request().URL.Path, "/api") || strings.HasPrefix(c.Request().URL.Path, "/_")
}

func main() {
	isDevelopment := os.Getenv("NODE_ENV") == "development"

	app := pocketbase.New()

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
