package main

// `serve seed`: build a local development database from scratch.
//
// Schema comes from pb_schema.json (a sanitized snapshot of production, refreshed by the
// maintainer with `make schema-snapshot`). Catalog data (tag categories, tags, authors, the newest
// games with their cover images) is pulled from the PUBLIC read API of the live site, so a fresh
// seed always looks like today's catalog. No real users are copied: the seed creates a local
// superuser and two test accounts instead (credentials below, also in AGENTS.md).
//
// Refuses to run on a data dir that already has games — `make seed` moves the old pb_data aside.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/spf13/cobra"
)

// Local-only credentials; pb_scripts/pblib.py uses the same superuser.
const (
	seedAdminEmail     = "admin@local.test"
	seedAdminPassword  = "localadmin123"
	seedUserEmail      = "user@local.test"
	seedUserPassword   = "localuser123"
	seedModerEmail     = "moder@local.test"
	seedModerPassword  = "localmoder123"
	seedFetchUserAgent = "cyoa-cafe-seed/1 (+https://github.com/DragonsWho/CYOACatalog)"
)

// Order matters: a record's relations are kept only if the target was seeded before it.
var seedCollections = []string{"tag_categories", "tags", "authors", "games", "game_relationships", "game_variants"}

type seedOpts struct {
	schema   string
	from     string
	games    int
	noImages bool
}

func registerSeedCmd(app *pocketbase.PocketBase) {
	o := seedOpts{}
	cmd := &cobra.Command{
		Use:   "seed",
		Short: "Build a local dev DB: schema from pb_schema.json, catalog from the public site API",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSeed(app, o)
		},
	}
	cmd.Flags().StringVar(&o.schema, "schema", "pb_schema.json", "collection schema snapshot")
	cmd.Flags().StringVar(&o.from, "from", "https://cyoa.cafe", "site to copy public catalog data from")
	cmd.Flags().IntVar(&o.games, "games", 300, "newest N games to copy (0 = all)")
	cmd.Flags().BoolVar(&o.noImages, "no-images", false, "skip downloading cover images")
	app.RootCmd.AddCommand(cmd)
}

func runSeed(app core.App, o seedOpts) error {
	if n, err := app.CountRecords("games"); err == nil && n > 0 {
		return fmt.Errorf("data dir already has %d games; seed needs an empty one (make seed moves it aside)", n)
	}

	raw, err := os.ReadFile(o.schema)
	if err != nil {
		return fmt.Errorf("read schema: %w", err)
	}
	if err := app.ImportCollectionsByMarshaledJSON(raw, false); err != nil {
		return fmt.Errorf("import schema: %w", err)
	}
	fmt.Println("schema imported from", o.schema)

	if err := seedAccounts(app); err != nil {
		return err
	}

	client := &http.Client{Timeout: 60 * time.Second}
	// Pass 1 saves records without relations (categories and tags point at each other, games at
	// both); pass 2 links them once every seeded id is known.
	seeded := map[string]map[string]bool{} // collection id → ids present locally
	var pending []seedPending
	for _, name := range seedCollections {
		col, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			continue // not in this schema snapshot
		}
		limit := 0
		if name == "games" {
			limit = o.games
		}
		// Newest first where the collection has a created date (some, e.g. game_variants, don't).
		sort := ""
		if col.Fields.GetByName("created") != nil {
			sort = "-created"
		}
		items, err := seedFetchAll(client, o.from, name, sort, limit)
		if err != nil {
			fmt.Printf("  %-18s skipped: %v\n", name, err)
			continue
		}
		ids := map[string]bool{}
		files := 0
		for _, item := range items {
			rec, rels, n := seedRecord(client, o, col, item)
			if err := app.SaveNoValidate(rec); err != nil {
				fmt.Printf("  %s/%v: %v\n", name, item["id"], err)
				continue
			}
			seedKeepTimestamps(app, name, item)
			ids[rec.Id] = true
			files += n
			if len(rels) > 0 {
				pending = append(pending, seedPending{col, rec.Id, rels, item})
			}
		}
		seeded[col.Id] = ids
		fmt.Printf("  %-18s %d records, %d files\n", name, len(ids), files)
	}
	seedLink(app, pending, seeded)

	fmt.Println("\nDone. Start with `make dev` and open http://localhost:8090")
	fmt.Printf("  superuser  %s / %s  (http://localhost:8090/_/)\n", seedAdminEmail, seedAdminPassword)
	fmt.Printf("  user       %s / %s\n", seedUserEmail, seedUserPassword)
	fmt.Printf("  moderator  %s / %s\n", seedModerEmail, seedModerPassword)
	return nil
}

func seedAccounts(app core.App) error {
	su, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		return err
	}
	admin := core.NewRecord(su)
	admin.SetEmail(seedAdminEmail)
	admin.SetPassword(seedAdminPassword)
	if err := app.Save(admin); err != nil {
		return fmt.Errorf("create superuser: %w", err)
	}

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return nil // schema without users: nothing more to create
	}
	for _, u := range []struct {
		email, password, username string
		moderator                 bool
	}{
		{seedUserEmail, seedUserPassword, "localuser", false},
		{seedModerEmail, seedModerPassword, "localmoder", true},
	} {
		r := core.NewRecord(users)
		r.SetEmail(u.email)
		r.SetPassword(u.password)
		r.SetVerified(true)
		r.Set("username", u.username)
		r.Set("name", u.username)
		r.Set("isModerator", u.moderator)
		if err := app.SaveNoValidate(r); err != nil {
			return fmt.Errorf("create %s: %w", u.email, err)
		}
	}
	return nil
}

type seedPending struct {
	col  *core.Collection
	id   string
	rels map[string][]string // relation field → source ids
	item map[string]any
}

// seedRecord maps one public API item onto a new local record, holding relations back for
// seedLink. Returns the number of files attached.
func seedRecord(client *http.Client, o seedOpts, col *core.Collection, item map[string]any) (*core.Record, map[string][]string, int) {
	rec := core.NewRecord(col)
	id, _ := item["id"].(string)
	rec.Id = id
	rels := map[string][]string{}
	files := 0
	for _, f := range col.Fields {
		name := f.GetName()
		if name == "id" || f.Type() == core.FieldTypeAutodate || f.Type() == core.FieldTypePassword {
			continue
		}
		v, present := item[name]
		if !present || v == nil {
			continue
		}
		switch f.(type) {
		case *core.RelationField:
			if ids := seedStrings(v); len(ids) > 0 {
				rels[name] = ids
			}
		case *core.FileField:
			if o.noImages || name != "image" {
				continue // only covers: static page scans are large and not needed to develop
			}
			var got []*filesystem.File
			for _, fn := range seedStrings(v) {
				if file := seedDownload(client, o.from, col.Name, id, fn); file != nil {
					got = append(got, file)
				}
			}
			if len(got) > 0 {
				rec.Set(name, got)
				files += len(got)
			}
		default:
			rec.Set(name, v)
		}
	}
	return rec, rels, files
}

// seedLink restores relations, dropping ids that were not seeded (users, comments, games past the
// limit). A record in a pure link collection (not a catalog entity) that lost a relation it had is
// deleted: a game_relationships row pointing at nothing is noise.
func seedLink(app core.App, pending []seedPending, seeded map[string]map[string]bool) {
	entity := map[string]bool{"tag_categories": true, "tags": true, "authors": true, "games": true}
	dropped := 0
	for _, p := range pending {
		rec, err := app.FindRecordById(p.col, p.id)
		if err != nil {
			continue
		}
		lost := false
		for name, ids := range p.rels {
			field, _ := p.col.Fields.GetByName(name).(*core.RelationField)
			if field == nil {
				continue
			}
			kept := []string{}
			for _, rid := range ids {
				if seeded[field.CollectionId][rid] {
					kept = append(kept, rid)
				}
			}
			if len(kept) == 0 {
				lost = true
			}
			rec.Set(name, kept)
		}
		if lost && !entity[p.col.Name] {
			_ = app.Delete(rec)
			dropped++
			continue
		}
		if err := app.SaveNoValidate(rec); err != nil {
			fmt.Printf("  link %s/%s: %v\n", p.col.Name, p.id, err)
			continue
		}
		seedKeepTimestamps(app, p.col.Name, p.item)
	}
	if dropped > 0 {
		fmt.Printf("  dropped %d link records pointing outside the seed\n", dropped)
	}
}

// Autodate fields are stamped with "now" on save; put the source dates back so feeds sorted by
// date look like production.
func seedKeepTimestamps(app core.App, table string, item map[string]any) {
	c, _ := item["created"].(string)
	u, _ := item["updated"].(string)
	if c == "" && u == "" {
		return
	}
	if u == "" {
		u = c
	}
	if c == "" {
		c = u
	}
	_, _ = app.DB().NewQuery("UPDATE {{" + table + "}} SET [[created]]={:c}, [[updated]]={:u} WHERE [[id]]={:id}").
		Bind(dbx.Params{"c": c, "u": u, "id": item["id"]}).Execute()
}

func seedStrings(v any) []string {
	switch t := v.(type) {
	case string:
		if t == "" {
			return nil
		}
		return []string{t}
	case []any:
		out := make([]string, 0, len(t))
		for _, x := range t {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func seedFetchAll(client *http.Client, from, collection, sort string, limit int) ([]map[string]any, error) {
	var out []map[string]any
	for page := 1; ; page++ {
		q := url.Values{"page": {fmt.Sprint(page)}, "perPage": {"200"}}
		if sort != "" {
			q.Set("sort", sort)
		}
		var body struct {
			Items      []map[string]any `json:"items"`
			TotalPages int              `json:"totalPages"`
		}
		if err := seedGetJSON(client, strings.TrimRight(from, "/")+"/api/collections/"+collection+"/records?"+q.Encode(), &body); err != nil {
			return nil, err
		}
		out = append(out, body.Items...)
		if limit > 0 && len(out) >= limit {
			return out[:limit], nil
		}
		if page >= body.TotalPages {
			return out, nil
		}
	}
}

func seedGetJSON(client *http.Client, u string, dst any) error {
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", seedFetchUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

func seedDownload(client *http.Client, from, collection, id, filename string) *filesystem.File {
	u := strings.TrimRight(from, "/") + "/api/files/" + collection + "/" + id + "/" + url.PathEscape(filename)
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", seedFetchUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil || len(b) == 0 {
		return nil
	}
	f, err := filesystem.NewFileFromBytes(b, path.Base(filename))
	if err != nil {
		return nil
	}
	return f
}
