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
	"path"
	"strings"
)

type viteManifestEntry struct {
	File           string   `json:"file"`
	Name           string   `json:"name"`
	Imports        []string `json:"imports"`
	CSS            []string `json:"css"`
	IsEntry        bool     `json:"isEntry"`
	IsDynamicEntry bool     `json:"isDynamicEntry"`
}

// Manifest key of a route module. Usually its source path; when other lazy chunks import modules
// that Rollup placed in the route's chunk, Vite keys it as a shared chunk ("_GameDetails-<hash>.js")
// — then match the dynamic entry by chunk name (the file's base name).
func routeManifestKey(man map[string]viteManifestEntry, src string) string {
	if _, ok := man[src]; ok {
		return src
	}
	name := path.Base(src)
	name = strings.TrimSuffix(name, path.Ext(name))
	for key, e := range man {
		if e.IsDynamicEntry && e.Name == name {
			return key
		}
	}
	return ""
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
		key := routeManifestKey(man, src)
		walk(key)
		if b.Len() > 0 {
			out[route] = b.String()
		} else {
			log.Printf("Warn: no route preload for %s (%s not in manifest)", route, src)
		}
	}
	return out
}
