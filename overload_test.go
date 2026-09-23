package main

// Exercised against a real router with handlers held open on demand: from outside, PB answers most
// malformed requests before reading them, so a slow client never occupies a slot.
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

const settle = 3 * time.Second

type guardFixture struct {
	srv     *httptest.Server
	entered chan string
	release func()
}

func (f *guardFixture) get(t *testing.T, path string) *http.Response {
	t.Helper()
	resp, err := http.Get(f.srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	return resp
}

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

	// Close() waits for in-flight handlers, so the gate must open first. t.Cleanup is LIFO, so Close
	// is registered first.
	t.Cleanup(f.srv.Close)
	t.Cleanup(f.release)

	return f
}

func TestOverloadGuardShedsAboveLimit(t *testing.T) {
	f := newGuardFixture(t, "2")
	f.occupy(t, 2)

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
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want \"no-store\"", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "heavy load") {
		t.Errorf("body = %q, want the user-facing overload message", body)
	}
}

func TestOverloadGuardReleasesSlots(t *testing.T) {
	f := newGuardFixture(t, "2")
	f.occupy(t, 2)
	f.release()

	resp := f.get(t, "/api/slow")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 once slots are free", resp.StatusCode)
	}
}

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
		"/api/realtime":                  false,
		"/api/health":                    false,
		"/":                              false,
		"/game/some-slug":                false,
		"/7552836/index.html":            false,
	}
	for path, want := range cases {
		if got := guardedPath(path); got != want {
			t.Errorf("guardedPath(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestOverloadGuardDisabled(t *testing.T) {
	f := newGuardFixture(t, "0")
	f.occupy(t, 5)
}
