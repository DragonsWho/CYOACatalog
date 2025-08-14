package main

import (
	"embed"
	"io/fs"
	"log"
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

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("Info: No .env file found, using environment variables.")
	}

	app := pocketbase.New()

	// ... блок с JS-хуками ...
	hooksDir := "pb_hooks"
	if _, err := os.Stat(hooksDir); os.IsNotExist(err) {
		log.Printf("Info: Hooks directory '%s' not found, skipping JS hooks loading.", hooksDir)
	} else {
		jsvm.MustRegister(app, jsvm.Config{
			HooksDir: hooksDir,
		})
		log.Printf("Info: Registered JS hooks from directory: %s", hooksDir)
	}

	// --- Блок обслуживания фронтенда ---
	app.OnServe().BindFunc(func(e *core.ServeEvent) error { // <<< ИЗМЕНЕНИЕ: Bind -> BindFunc
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

		// ВАЖНО: В хуке OnServe нужно вызывать e.Next(), чтобы разрешить
		// выполнение следующих хуков в цепочке.
		return e.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
