package main

// Route chunk preloads: a lazy route (GameDetails, HomePage) used to start downloading only after
// the main bundle had loaded, parsed and rendered once (~0.7 s later on a mid phone). The HTML now
// names the route's chunk and its imports up front as <link rel="modulepreload">, so they download
// in parallel with the main bundle. Chunk lists come from Vite's manifest (vite.config.ts
// build.manifest), so hashes never go stale.

import (
	"encoding/json"
	"io/fs"
	"log"
	"strings"
)

type viteManifestEntry struct {
	File    string   `json:"file"`
	Imports []string `json:"imports"`
	CSS     []string `json:"css"`
	IsEntry bool     `json:"isEntry"`
}

// Route source module → the <link> tags to inline for it.
var routeChunkSources = map[string]string{
	"game": "src/components/CyoaPage/GameDetails.tsx",
	"home": "src/components/Home/HomePage.tsx",
}

func buildRoutePreloads(distFS fs.FS) map[string]string {
	out := map[string]string{}
	data, err := fs.ReadFile(distFS, "route-manifest.json")
	if err != nil {
		log.Printf("Warn: route preloads disabled — no route-manifest.json: %v", err)
		return out
	}
	var man map[string]viteManifestEntry
	if err := json.Unmarshal(data, &man); err != nil {
		log.Printf("Warn: route preloads disabled — bad manifest: %v", err)
		return out
	}
	// The entry chunk and its static imports are already on the page.
	have := map[string]bool{}
	var markHave func(key string)
	markHave = func(key string) {
		e, ok := man[key]
		if !ok || have[e.File] {
			return
		}
		have[e.File] = true
		for _, imp := range e.Imports {
			markHave(imp)
		}
	}
	for key, e := range man {
		if e.IsEntry {
			markHave(key)
		}
	}
	for route, src := range routeChunkSources {
		seen := map[string]bool{}
		var b strings.Builder
		var walk func(key string)
		walk = func(key string) {
			e, ok := man[key]
			if !ok || seen[e.File] || have[e.File] {
				return
			}
			seen[e.File] = true
			b.WriteString(`<link rel="modulepreload" crossorigin href="/` + e.File + `">`)
			for _, css := range e.CSS {
				if !seen[css] {
					seen[css] = true
					// preload, not stylesheet: a stylesheet in <head> would block the pre-paint.
					b.WriteString(`<link rel="preload" as="style" crossorigin href="/` + css + `">`)
				}
			}
			for _, imp := range e.Imports {
				walk(imp)
			}
		}
		walk(src)
		if b.Len() > 0 {
			out[route] = b.String()
		}
	}
	return out
}
