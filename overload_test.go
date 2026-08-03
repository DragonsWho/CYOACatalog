package main

// Tests for the in-flight limiter. The behaviour is hard to observe from
// outside a running server — PocketBase answers most malformed requests before
// it finishes reading them, so a slow client never actually occupies a slot —
// so the guard is exercised here against a real router with a handler we can
// hold open on demand.

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// settle is how long a test waits for something that should already have
// happened — long enough not to flake on a loaded machine, short enough that a
// real hang fails the test instead of the suite timeout.
const settle = 3 * time.Second

type guardFixture struct {
	srv *httptest.Server
	// entered receives the path of every handler that got past the guard.
	entered chan string
	// release unblocks all parked handlers. Idempotent.
	release func()
}

// get issues a request and returns the response, failing the test on a
// transport error.
func (f *guardFixture) get(t *testing.T, path string) *http.Response {
	t.Helper()
	resp, err := http.Get(f.srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	return resp
}

// occupy fires n requests that block inside their handler, and returns once all
// n are confirmed to be holding a slot.
func (f *guardFixture) occupy(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		go func() {
			resp, err := http.Get(f.srv.URL + "/api/slow")
			if err == nil {
				resp.Body.Close()
			}
		}()
	}
	for i := 0; i < n; i++ {
		select {
		case <-f.entered:
		case <-time.After(settle):
			t.Fatalf("only %d of %d requests reached their handler", i, n)
		}
	}
}

// newGuardFixture wires the real registerOverloadGuard onto a router with three
// routes: one to block on, one excluded from the guard, and one outside /api/.
func newGuardFixture(t *testing.T, limit string) *guardFixture {
	t.Helper()
	t.Setenv("OVERLOAD_MAX_INFLIGHT", limit)

	r := router.NewRouter(func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		e := new(core.RequestEvent)
		e.Response = w
		e.Request = req
		return e, nil
	})

	gate := make(chan struct{})
	f := &guardFixture{
		entered: make(chan string, 64),
		release: sync.OnceFunc(func() { close(gate) }),
	}

	block := func(e *core.RequestEvent) error {
		f.entered <- e.Request.URL.Path
		<-gate
		return e.String(http.StatusOK, "ok")
	}
	r.GET("/api/slow", block)
	r.GET("/api/health", block)
	r.GET("/static/slow", block)

	registerOverloadGuard(slog.New(slog.NewTextHandler(io.Discard, nil)), &core.ServeEvent{Router: r})

	mux, err := r.BuildMux()
	if err != nil {
		t.Fatalf("BuildMux: %v", err)
	}
	f.srv = httptest.NewServer(mux)

	// Order matters: Close() waits for in-flight handlers, so the gate must be
	// opened first. t.Cleanup is LIFO, so this pair registers Close first.
	t.Cleanup(f.srv.Close)
	t.Cleanup(f.release)

	return f
}

// The core promise: past the cap, requests are shed instead of piling up in
// memory. This is the whole reason the file exists.
func TestOverloadGuardShedsAboveLimit(t *testing.T) {
	f := newGuardFixture(t, "2")
	f.occupy(t, 2)

	// A third request has nowhere to go. It should wait out admitGrace and then
	// be shed — not queue indefinitely.
	start := time.Now()
	resp := f.get(t, "/api/slow")
	defer resp.Body.Close()
	waited := time.Since(start)

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if waited < admitGrace {
		t.Errorf("shed after %v, expected to wait out the %v grace first", waited, admitGrace)
	}
	if waited > admitGrace+settle {
		t.Errorf("shed after %v, far beyond the %v grace", waited, admitGrace)
	}
	if got := resp.Header.Get("Retry-After"); got != "30" {
		t.Errorf("Retry-After = %q, want \"30\"", got)
	}
	// A cached 503 would outlive the overload that caused it.
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want \"no-store\"", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "heavy load") {
		t.Errorf("body = %q, want the user-facing overload message", body)
	}
}

// A freed slot must be reusable — the limiter caps concurrency, it does not
// permanently consume capacity.
func TestOverloadGuardReleasesSlots(t *testing.T) {
	f := newGuardFixture(t, "2")
	f.occupy(t, 2)
	f.release() // both in-flight handlers finish and hand their slots back

	resp := f.get(t, "/api/slow")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 once slots are free", resp.StatusCode)
	}
}

// /api/health and everything outside /api/ must answer even while the guard is
// saturated: monitoring has to work precisely when the site is in trouble, and
// hosted-game files are R2 streams that never touch the database.
func TestOverloadGuardExemptions(t *testing.T) {
	f := newGuardFixture(t, "1")
	f.occupy(t, 1)

	for _, path := range []string{"/api/health", "/static/slow"} {
		go func() {
			resp, err := http.Get(f.srv.URL + path)
			if err == nil {
				resp.Body.Close()
			}
		}()
		select {
		case got := <-f.entered:
			if got != path {
				t.Errorf("entered handler %q, want %q", got, path)
			}
		case <-time.After(admitGrace + settle):
			t.Errorf("%s never reached its handler — the guard caught an exempt path", path)
		}
	}
}

func TestGuardedPath(t *testing.T) {
	cases := map[string]bool{
		"/api/collections/games/records": true,
		"/api/hosting/my-games":          true,
		"/api/realtime":                  false, // SSE lives for minutes; would eat every slot
		"/api/health":                    false, // monitoring must answer under load
		"/":                              false,
		"/game/some-slug":                false,
		"/7552836/index.html":            false, // hosted game file
	}
	for path, want := range cases {
		if got := guardedPath(path); got != want {
			t.Errorf("guardedPath(%q) = %v, want %v", path, got, want)
		}
	}
}

// OVERLOAD_MAX_INFLIGHT=0 is the documented escape hatch — it must actually
// disable the guard, not fall back to the default.
func TestOverloadGuardDisabled(t *testing.T) {
	f := newGuardFixture(t, "0")
	// Well past any plausible cap; with the guard off all of them get through.
	f.occupy(t, 5)
}
