// CYOA Helper: a small program moderators run on their own computer. The Mod Tools page on
// cyoa.cafe sends it jobs (download a game, check it, upload it to an author's hosting); it can
// also download/import games from its own numbered menu. It does nothing without a moderator
// account: pairing needs a moderator with the "mod_upload" permission to confirm a code on the site.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var version = "dev" // set by -ldflags "-X main.version=v1.2.3"

const defaultServer = "https://cyoa.cafe"

type Config struct {
	Server    string `json:"server"`
	Token     string `json:"token,omitempty"`
	DeviceID  string `json:"device_id,omitempty"`
	User      string `json:"user,omitempty"`
	Workspace string `json:"workspace"`
	path      string
}

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir, _ = os.UserHomeDir()
	}
	return filepath.Join(dir, "cyoa-helper", "config.json")
}

func loadConfig() *Config {
	c := &Config{path: configPath()}
	if b, err := os.ReadFile(c.path); err == nil {
		_ = json.Unmarshal(b, c)
	}
	if c.Server == "" {
		c.Server = defaultServer
	}
	if env := os.Getenv("CYOA_HELPER_SERVER"); env != "" {
		c.Server = strings.TrimRight(env, "/")
	}
	if c.Workspace == "" {
		home, _ := os.UserHomeDir()
		c.Workspace = filepath.Join(home, "CYOA Helper")
	}
	return c
}

// Save keeps the token readable only by this OS user.
func (c *Config) Save() error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

func openBrowser(u string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	case "darwin":
		cmd = exec.Command("open", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	return cmd.Start()
}

func openFolder(p string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer", p).Start()
	case "darwin":
		return exec.Command("open", p).Start()
	}
	return exec.Command("xdg-open", p).Start()
}

// ---- terminal UI ----

type UI struct {
	lines chan string
	outMu sync.Mutex
}

func newUI() *UI {
	u := &UI{lines: make(chan string)}
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			u.lines <- sc.Text()
		}
		close(u.lines)
	}()
	return u
}

func (u *UI) Print(s string) {
	u.outMu.Lock()
	fmt.Println(s)
	u.outMu.Unlock()
}

// Ask shows a prompt and waits for one line; ok=false when stdin closed.
func (u *UI) Ask(prompt string) (string, bool) {
	u.outMu.Lock()
	fmt.Print(prompt)
	u.outMu.Unlock()
	s, ok := <-u.lines
	return strings.TrimSpace(s), ok
}

// cleanPathInput undoes what terminals add when a file is dragged in: quotes and escaped spaces.
func cleanPathInput(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		s = s[1 : len(s)-1]
	}
	if runtime.GOOS != "windows" {
		s = strings.ReplaceAll(s, `\ `, " ")
	}
	if strings.HasPrefix(s, "file://") {
		s = strings.TrimPrefix(s, "file://")
	}
	if strings.HasPrefix(s, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			s = filepath.Join(home, s[1:])
		}
	}
	return s
}

func main() {
	workerOnly := flag.Bool("worker", false, "no menu: just take jobs from the site (for servers/autostart)")
	server := flag.String("server", "", "site address (default "+defaultServer+")")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("cyoa-helper", version)
		return
	}

	cfg := loadConfig()
	if *server != "" {
		cfg.Server = strings.TrimRight(*server, "/")
	}
	ui := newUI()
	app := &App{cfg: cfg, ws: &Workspace{Root: cfg.Workspace}, out: ui.Print}
	if err := os.MkdirAll(app.ws.itemsDir(), 0o755); err != nil {
		fmt.Println("Can't create the workspace folder", cfg.Workspace, "—", err)
		waitExit(ui)
		return
	}
	if p, err := startPreview(app.ws); err == nil {
		app.preview = p
	} else {
		ui.Print("(local preview is unavailable: " + err.Error() + ")")
	}
	if cfg.Token != "" {
		app.setClient(NewClient(cfg.Server, cfg.Token))
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var workerMu sync.Mutex
	var workerCancel context.CancelFunc
	startWorker := func() {
		workerMu.Lock()
		defer workerMu.Unlock()
		if workerCancel != nil {
			workerCancel()
		}
		wctx, cancel := context.WithCancel(ctx)
		workerCancel = cancel
		go func() {
			err := app.serveJobs(wctx)
			if errors.Is(err, errUnpaired) && wctx.Err() == nil {
				ui.Print("\n!! The site no longer accepts this helper (" + err.Error() + ").")
				ui.Print("!! Choose \"Connect\" in the menu to pair it again.")
				app.setClient(nil)
				cfg.Token = ""
				_ = cfg.Save()
			}
		}()
	}

	ui.Print(fmt.Sprintf("CYOA Helper %s — %s", version, cfg.Server))
	ui.Print("Games are kept in: " + cfg.Workspace)
	if c := app.Client(); c != nil {
		mctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		me, err := c.Me(mctx)
		cancel()
		switch {
		case err == nil:
			cfg.User = me.User
			_ = cfg.Save()
			ui.Print("Connected as " + me.User + ". Waiting for jobs from the Mod Tools page.")
		case errors.Is(err, errUnpaired):
			ui.Print("This helper was disconnected on the site. Choose 1 to connect again.")
			app.setClient(nil)
			cfg.Token = ""
			_ = cfg.Save()
		default:
			ui.Print("Can't reach the site right now (" + shortErr(err) + "); will keep trying.")
		}
		if app.Client() != nil {
			startWorker()
		}
	}

	if *workerOnly {
		if app.Client() == nil {
			fmt.Println("Not connected. Run without --worker once and choose Connect.")
			os.Exit(1)
		}
		<-ctx.Done()
		return
	}

	for ctx.Err() == nil {
		printMenu(app)
		choice, ok := ui.Ask("Choose a number and press Enter: ")
		if !ok {
			return
		}
		switch choice {
		case "1":
			if pairInteractive(ctx, app, ui) {
				startWorker()
			}
		case "2":
			menuDownload(app, ui)
		case "3":
			menuImport(app, ui)
		case "4":
			menuGames(app, ui)
		case "5":
			u := cfg.Server + "/moderator/mod-tools"
			ui.Print("Opening " + u)
			if err := openBrowser(u); err != nil {
				ui.Print("Couldn't open the browser; open this address yourself: " + u)
			}
		case "6":
			if menuSettings(app, ui) {
				if app.Client() != nil {
					startWorker()
				}
			}
		case "0", "q", "quit", "exit":
			if b := app.Busy(); b != "" {
				if a, _ := ui.Ask("A " + b + " job is still running. Quit anyway? (y/N): "); !strings.EqualFold(a, "y") {
					continue
				}
			}
			ui.Print("Bye.")
			return
		case "":
		default:
			ui.Print("Unknown choice " + strconv.Quote(choice) + ".")
		}
	}
}

func waitExit(ui *UI) { ui.Ask("Press Enter to close.") }

func printMenu(app *App) {
	status := "not connected"
	if app.Client() != nil {
		status = "connected"
		if app.cfg.User != "" {
			status += " as " + app.cfg.User
		}
	}
	busy := ""
	if b := app.Busy(); b != "" {
		busy = " — working: " + b
	}
	app.out(fmt.Sprintf(`
──────── CYOA Helper (%s%s) ────────
 1  Connect this computer to your cyoa.cafe moderator account
 2  Download a game from a link
 3  Import a game folder or .zip from this computer
 4  My downloaded games (preview, re-check, delete)
 5  Open the Mod Tools page in the browser (upload & publish from there)
 6  Settings
 0  Quit`, status, busy))
}

func pairInteractive(ctx context.Context, app *App, ui *UI) bool {
	if app.Client() != nil {
		if a, _ := ui.Ask("Already connected. Connect again (the old link stops working)? (y/N): "); !strings.EqualFold(a, "y") {
			return false
		}
	}
	host, _ := os.Hostname()
	c := NewClient(app.cfg.Server, "")
	pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	ps, err := c.PairStart(pctx, host)
	cancel()
	if err != nil {
		ui.Print("Couldn't start pairing: " + err.Error())
		return false
	}
	link := app.cfg.Server + ps.PairURL
	ui.Print("")
	ui.Print("  Your code:  " + ps.Code)
	ui.Print("")
	ui.Print("  Opening " + link)
	ui.Print("  Log in there with your moderator account and press \"Connect\".")
	ui.Print("  (If the browser didn't open, go to Mod Tools on cyoa.cafe and type the code.)")
	ui.Print("  Waiting… press Enter to cancel.")
	_ = openBrowser(link)

	deadline := time.Now().Add(time.Duration(ps.ExpiresIn) * time.Second)
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return false
		case <-ui.lines:
			ui.Print("Pairing cancelled.")
			return false
		case <-tick.C:
		}
		qctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		pp, err := c.PairPoll(qctx, ps.Secret)
		cancel()
		if err != nil {
			var ae *APIError
			if errors.As(err, &ae) && ae.Status == 404 {
				ui.Print("The code expired. Choose 1 to get a new one.")
				return false
			}
			continue
		}
		if pp.Status == "paired" && pp.Token != "" {
			app.cfg.Token, app.cfg.DeviceID, app.cfg.User = pp.Token, pp.DeviceID, pp.User
			if err := app.cfg.Save(); err != nil {
				ui.Print("Connected, but couldn't save settings: " + err.Error())
			}
			app.setClient(NewClient(app.cfg.Server, pp.Token))
			ui.Print("Connected as " + pp.User + ". Jobs from the Mod Tools page will run here.")
			return true
		}
	}
	ui.Print("The code expired. Choose 1 to get a new one.")
	return false
}

func menuDownload(app *App, ui *UI) {
	link, ok := ui.Ask("Paste the game's link (empty = back): ")
	if !ok || link == "" {
		return
	}
	if _, err := checkPublicURL(link); err != nil {
		ui.Print("That doesn't look like a web link: " + err.Error())
		return
	}
	ui.Print("Downloading in the background; progress shows below and on the Mod Tools page.")
	go app.runLocal("download", map[string]any{"url": link}, func(r *jobRun) (any, error) {
		ctx, cancel := context.WithCancel(context.Background())
		r.cancel = cancel
		defer cancel()
		rep, err := app.doDownload(ctx, r, link)
		if err != nil {
			return nil, err
		}
		return rep, nil
	})
}

func menuImport(app *App, ui *UI) {
	ui.Print("Drag the game's folder or .zip file into this window (or type its path), then press Enter.")
	ui.Print("The folder should contain the game's index.html.")
	p, ok := ui.Ask("Path (empty = back): ")
	if !ok || p == "" {
		return
	}
	p = cleanPathInput(p)
	if !fileExists(p) {
		ui.Print("Nothing found at " + p)
		return
	}
	src, _ := ui.Ask("Original link of the game, if you know it (Enter to skip): ")
	if src != "" {
		if _, err := checkPublicURL(src); err != nil {
			ui.Print("Ignoring the link: " + err.Error())
			src = ""
		}
	}
	it, err := app.ws.ImportPath(p, "", src, func(f string, a ...any) { ui.Print("  " + fmt.Sprintf(f, a...)) })
	if err != nil {
		ui.Print("Import failed: " + err.Error())
		return
	}
	if n := fixForHosting(it.GameDir(), func(f string, a ...any) { ui.Print("  " + fmt.Sprintf(f, a...)) }); len(n) > 0 {
		ui.Print(fmt.Sprintf("  %d link(s) point outside the game folder and couldn't be fixed", len(n)))
	}
	app.runLocal("import", map[string]any{"item": it.ID, "name": it.Name}, func(r *jobRun) (any, error) {
		rep := checkGame(it, nil)
		if src != "" {
			rep.SourceURL = src
		}
		return app.saveReport(r, it, rep)
	})
	ui.Print("Imported as " + it.ID + ". Continue on the Mod Tools page (option 5).")
}

func menuGames(app *App, ui *UI) {
	items := app.ws.List()
	if len(items) == 0 {
		ui.Print("No games yet. Use 2 or 3 first.")
		return
	}
	for i, it := range items {
		v := "not checked"
		if it.Report != nil {
			v = strings.ToUpper(it.Report.Verdict) + fmt.Sprintf(", %d files", it.Report.Files)
		}
		ui.Print(fmt.Sprintf(" %2d  %s  [%s]  %s", i+1, it.Name, v, it.ID))
		if i >= 29 {
			ui.Print(fmt.Sprintf("     … and %d older", len(items)-30))
			break
		}
	}
	s, _ := ui.Ask("Game number (empty = back): ")
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > len(items) || n > 30 {
		return
	}
	it := items[n-1]
	ui.Print(fmt.Sprintf("\n%s\n  folder: %s\n  source: %s", it.Name, it.GameDir(), it.SourceURL))
	ui.Print(" 1  Play the local copy in the browser\n 2  Check again (after you edited files)\n 3  Open the folder\n 4  Delete from this computer\n 0  Back")
	switch a, _ := ui.Ask("Choose: "); a {
	case "1":
		if app.preview == nil {
			ui.Print("Preview is unavailable.")
			return
		}
		_ = openBrowser(app.preview.URL(it.ID))
	case "2":
		app.runLocal("check", map[string]any{"item": it.ID, "name": it.Name}, func(r *jobRun) (any, error) {
			return app.doCheck(r, it.ID)
		})
	case "3":
		if err := openFolder(it.GameDir()); err != nil {
			ui.Print("Folder: " + it.GameDir())
		}
	case "4":
		if c, _ := ui.Ask("Delete " + it.Name + " from this computer? It stays on cyoa.cafe if uploaded. (y/N): "); strings.EqualFold(c, "y") {
			if err := app.ws.Delete(it.ID); err != nil {
				ui.Print("Couldn't delete: " + err.Error())
			} else {
				ui.Print("Deleted.")
			}
		}
	}
}

// menuSettings returns true when the server changed (the worker must restart).
func menuSettings(app *App, ui *UI) bool {
	cfg := app.cfg
	ui.Print(fmt.Sprintf(" 1  Games folder: %s\n 2  Site address: %s\n 3  Disconnect this computer\n 0  Back", cfg.Workspace, cfg.Server))
	switch a, _ := ui.Ask("Choose: "); a {
	case "1":
		p, _ := ui.Ask("New games folder (existing games stay in the old one): ")
		p = cleanPathInput(p)
		if p == "" {
			return false
		}
		if err := os.MkdirAll(filepath.Join(p, "items"), 0o755); err != nil {
			ui.Print("Can't use that folder: " + err.Error())
			return false
		}
		cfg.Workspace = p
		app.ws.Root = p
		_ = cfg.Save()
		ui.Print("Saved.")
	case "2":
		s, _ := ui.Ask("Site address (Enter = " + defaultServer + "): ")
		if s == "" {
			s = defaultServer
		}
		if !strings.HasPrefix(s, "https://") && !strings.HasPrefix(s, "http://") {
			ui.Print("The address must start with https://")
			return false
		}
		s = strings.TrimRight(s, "/")
		if s == cfg.Server {
			return false
		}
		cfg.Server, cfg.Token, cfg.User = s, "", ""
		app.setClient(nil)
		_ = cfg.Save()
		ui.Print("Saved. Choose 1 to connect to the new address.")
		return true
	case "3":
		cfg.Token, cfg.User, cfg.DeviceID = "", "", ""
		app.setClient(nil)
		_ = cfg.Save()
		ui.Print("Disconnected here. Also press Disconnect on the Mod Tools page to revoke it on the site.")
		return true
	}
	return false
}
