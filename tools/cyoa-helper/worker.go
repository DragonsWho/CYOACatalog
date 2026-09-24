// Job runner. Jobs come from the Mod Tools page (long-poll) or from the helper's own menu; both go
// through runJob, which streams log lines and progress back to the site.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type App struct {
	cfg     *Config
	ws      *Workspace
	preview *Preview

	mu     sync.Mutex
	client *Client // nil when not paired
	busy   string  // description of the running job, "" when idle
	out    func(string)
}

func (a *App) Client() *Client {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client
}

func (a *App) setClient(c *Client) {
	a.mu.Lock()
	a.client = c
	a.mu.Unlock()
}

func (a *App) setBusy(s string) {
	a.mu.Lock()
	a.busy = s
	a.mu.Unlock()
}

func (a *App) Busy() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.busy
}

// jobRun streams a job's log/progress to the site (when it has a server-side id) and the terminal.
type jobRun struct {
	app    *App
	client *Client
	id     string
	label  string
	cancel context.CancelFunc

	mu        sync.Mutex
	pending   strings.Builder
	progress  map[string]any
	lastFlush time.Time
	cancelled bool
}

func (r *jobRun) logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	r.app.out(fmt.Sprintf("  [%s] %s", r.label, line))
	r.mu.Lock()
	r.pending.WriteString(time.Now().Format("15:04:05 ") + line + "\n")
	r.mu.Unlock()
	r.maybeFlush(false)
}

func (r *jobRun) setProgress(p map[string]any) {
	r.mu.Lock()
	r.progress = p
	r.mu.Unlock()
	r.maybeFlush(false)
}

func (r *jobRun) maybeFlush(force bool) {
	if r.client == nil || r.id == "" {
		return
	}
	r.mu.Lock()
	if !force && time.Since(r.lastFlush) < 2*time.Second {
		r.mu.Unlock()
		return
	}
	u := ProgressUpdate{Log: r.pending.String(), Progress: r.progress}
	r.pending.Reset()
	r.lastFlush = time.Now()
	r.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if c, err := r.client.Progress(ctx, r.id, u); err == nil && c {
		r.mu.Lock()
		r.cancelled = true
		r.mu.Unlock()
		if r.cancel != nil {
			r.cancel()
		}
	}
}

func (r *jobRun) finish(result any, err error) {
	if r.client == nil || r.id == "" {
		return
	}
	r.mu.Lock()
	u := ProgressUpdate{Log: r.pending.String(), Progress: r.progress}
	r.pending.Reset()
	r.mu.Unlock()
	if err != nil {
		u.Status, u.Error = "failed", err.Error()
		if r.cancelled {
			u.Error = "cancelled"
		}
	} else {
		u.Status, u.Result = "done", result
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for i := 0; i < 3; i++ {
		if _, e := r.client.Progress(ctx, r.id, u); e == nil {
			return
		} else if ae := (*APIError)(nil); errors.As(e, &ae) {
			return // job no longer running (cancelled or finished server-side)
		}
		time.Sleep(2 * time.Second)
	}
}

func (a *App) runJob(job *Job, client *Client) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &jobRun{app: a, client: client, id: job.ID, label: job.Kind, cancel: cancel}
	a.setBusy(job.Kind)
	defer a.setBusy("")

	var result any
	var err error
	func() {
		defer func() {
			if p := recover(); p != nil {
				err = fmt.Errorf("helper crashed: %v", p)
			}
		}()
		switch job.Kind {
		case "download":
			result, err = a.doDownload(ctx, r, job.In("url"))
		case "check":
			result, err = a.doCheck(r, job.In("item"))
		case "upload":
			err = a.doUpload(ctx, r, job)
			if err == nil {
				r.logf("upload finished")
				return // the server already marked the job done
			}
		case "import":
			err = errors.New("importing a folder is done from the helper's own menu (option 3)")
		default:
			err = fmt.Errorf("this helper version doesn't know job type %q — update the helper", job.Kind)
		}
	}()
	if err != nil {
		if ctx.Err() != nil {
			err = errors.New("cancelled")
		}
		r.logf("FAILED: %v", err)
	}
	if job.Kind == "upload" && err == nil {
		r.maybeFlush(true)
		return
	}
	r.finish(result, err)
}

// ---- job kinds ----

func (a *App) doDownload(ctx context.Context, r *jobRun, rawURL string) (*CheckReport, error) {
	if _, err := checkPublicURL(rawURL); err != nil {
		return nil, err
	}
	_, game := guessFromURL(rawURL)
	it, err := a.ws.NewItem(game, rawURL)
	if err != nil {
		return nil, err
	}
	r.setProgress(map[string]any{"phase": "download", "message": "starting"})
	cr, err := NewCrawler(ctx, rawURL, it.GameDir(), r.logf, func(done, queued int, b int64, msg string) {
		p := map[string]any{"phase": "download", "done": done, "total": done + queued, "bytes": b,
			"message": fmt.Sprintf("%d files, %.1f MB", done, float64(b)/(1<<20))}
		if msg != "" {
			p["message"] = msg + " — " + p["message"].(string)
		}
		r.setProgress(p)
	})
	if err != nil {
		_ = a.ws.Delete(it.ID)
		return nil, err
	}
	stats, err := cr.Run()
	if err != nil {
		_ = a.ws.Delete(it.ID)
		return nil, err
	}
	r.logf("downloaded %d files (%.1f MB), %d from other sites", stats.Files, float64(stats.Bytes)/(1<<20), stats.External)
	r.setProgress(map[string]any{"phase": "check", "message": "checking"})
	rep := checkGame(it, stats)
	return a.saveReport(r, it, rep)
}

func (a *App) doCheck(r *jobRun, itemID string) (*CheckReport, error) {
	it, err := a.ws.Get(itemID)
	if err != nil {
		return nil, err
	}
	r.setProgress(map[string]any{"phase": "check", "message": "checking"})
	var prevCrawl *CrawlStats
	if it.Report != nil && len(it.Report.FailedDownloads) > 0 {
		prevCrawl = &CrawlStats{Failed: it.Report.FailedDownloads}
	}
	rep := checkGame(it, prevCrawl)
	return a.saveReport(r, it, rep)
}

func (a *App) saveReport(r *jobRun, it *Item, rep *CheckReport) (*CheckReport, error) {
	if a.preview != nil {
		rep.PreviewURL = a.preview.URL(it.ID)
	}
	if rep.Title != "" && (it.Name == "" || it.Name == "game") {
		it.Name = rep.Title
	}
	it.Report = rep
	if err := it.Save(); err != nil {
		return nil, err
	}
	r.logf("check: %s — %d files, %d missing, %d from other sites", strings.ToUpper(rep.Verdict), rep.Files, rep.MissingCount, rep.HotlinkCount)
	for _, w := range rep.Warnings {
		r.logf("  ! %s", w)
	}
	if rep.PreviewURL != "" {
		r.logf("preview: %s", rep.PreviewURL)
	}
	return rep, nil
}

func (a *App) doUpload(ctx context.Context, r *jobRun, job *Job) error {
	if r.client == nil {
		return errUnpaired
	}
	it, err := a.ws.Get(job.In("item"))
	if err != nil {
		return err
	}
	rep := checkGame(it, nil)
	if !rep.HasIndex {
		return errors.New("the game folder has no index.html — nothing to upload")
	}
	if rep.Verdict == "bad" {
		return errors.New("the check says this game is broken: " + strings.Join(rep.Warnings, " "))
	}
	plan, err := planPack(it.GameDir())
	if err != nil {
		return err
	}
	if len(plan.Parts) == 0 {
		return errors.New("no files to upload")
	}
	for _, s := range capList(plan.Skipped, 10) {
		r.logf("left out (hosting doesn't accept this file type): %s", s)
	}
	target := job.In("user_slug") + ".cyoa.cafe/" + job.In("slug") + "/"
	r.logf("uploading %d files (%.1f MB) to %s in %d part(s)", plan.Files, float64(plan.Bytes)/(1<<20), target, len(plan.Parts))
	for i, files := range plan.Parts {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r.setProgress(map[string]any{"phase": "upload", "done": i, "total": len(plan.Parts),
			"message": fmt.Sprintf("part %d of %d", i+1, len(plan.Parts))})
		r.maybeFlush(true)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		data, err := buildZip(files)
		if err != nil {
			return err
		}
		final := i == len(plan.Parts)-1
		var reply *PartReply
		for attempt := 1; ; attempt++ {
			reply, err = r.client.UploadPart(ctx, job.ID, i, final, data)
			if err == nil {
				break
			}
			var ae *APIError
			if errors.As(err, &ae) || attempt >= 3 || ctx.Err() != nil {
				return fmt.Errorf("part %d: %w", i+1, err)
			}
			r.logf("part %d failed (%v), retrying", i+1, err)
			time.Sleep(time.Duration(attempt*5) * time.Second)
		}
		r.logf("part %d/%d sent (%.1f MB)", i+1, len(plan.Parts), float64(len(data))/(1<<20))
		if final && reply.URL != "" {
			r.logf("live at %s", reply.URL)
		}
	}
	return nil
}

// ---- server loop ----

// serveJobs claims jobs from the site until ctx ends. Returns errUnpaired when the site no longer
// accepts this helper's token.
func (a *App) serveJobs(ctx context.Context) error {
	backoff := time.Second
	for ctx.Err() == nil {
		c := a.Client()
		if c == nil {
			return nil
		}
		job, err := c.Next(ctx, 25)
		if err != nil {
			if errors.Is(err, errUnpaired) {
				return err
			}
			if ctx.Err() != nil {
				return nil
			}
			a.out(fmt.Sprintf("  (can't reach %s: %v — retrying)", c.Server, shortErr(err)))
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
			}
			backoff = min(backoff*2, 60*time.Second)
			continue
		}
		backoff = time.Second
		if job == nil {
			continue
		}
		a.out(fmt.Sprintf("\n>> Job from the site: %s %s", job.Kind, jobSummary(job)))
		a.runJob(job, c)
		a.out(">> Job finished. (Menu still works: type a number and press Enter.)")
	}
	return nil
}

func jobSummary(j *Job) string {
	switch j.Kind {
	case "download":
		return j.In("url")
	case "upload":
		return j.In("item") + " → " + j.In("user_slug") + ".cyoa.cafe/" + j.In("slug") + "/"
	}
	return j.In("item")
}

func shortErr(err error) string {
	s := err.Error()
	if len(s) > 160 {
		s = s[:160] + "…"
	}
	return s
}

// runLocal runs a job started from the menu, registering it on the site when paired so it shows up
// on the Mod Tools page.
func (a *App) runLocal(kind string, input map[string]any, fn func(r *jobRun) (any, error)) {
	c := a.Client()
	r := &jobRun{app: a, client: c, label: kind}
	if c != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		job, err := c.CreateJob(ctx, kind, "running", input, nil)
		cancel()
		if err == nil && job != nil {
			r.id = job.ID
		} else if err != nil {
			a.out("  (couldn't register the job on the site: " + shortErr(err) + ")")
		}
	}
	a.setBusy(kind)
	defer a.setBusy("")
	res, err := fn(r)
	if err != nil {
		r.logf("FAILED: %v", err)
	}
	r.finish(res, err)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
