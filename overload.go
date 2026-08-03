package main

// In-flight limiter for the API surface — the guard that turns an overload into
// a few honest 503s instead of an hour-long collapse.
//
// Why this exists (incident 2026-07-26, 05:50–06:50 UTC): nothing here ever
// leaked. The box died on arithmetic. Memory in flight = (requests in flight) ×
// (cost of one), and "requests in flight" = rps × latency. Once SQLite slowed
// down, every request lived 30s instead of 30ms, so a perfectly ordinary ~7 rps
// parked ~200 handlers in memory at once. A list request that pulls 500 full
// `games` rows costs 15–20 MB while it marshals, so those 200 handlers were
// worth well over a gigabyte on a 961 MB droplet → swap thrash → slower still →
// more handlers. The loop feeds itself and only ends when the traffic ebbs.
//
// Capping concurrency breaks the loop at its root: latency can spike all it
// wants, memory stays bounded at (limit × cost). Requests over the cap wait a
// beat for a free slot and then get a 503 with Retry-After — the frontend turns
// that into a "site is busy" notice, which is a far better outcome than a
// spinner that hangs for 30s and then fails anyway.
//
// Scope is deliberately narrow — only /api/* (the DB-bound path):
//   - /api/realtime is EXCLUDED: SSE streams are long-lived by design and would
//     eat every slot within seconds.
//   - /api/health is EXCLUDED so monitoring still answers under load.
//   - hosted-game traffic (<slug>.cyoa.cafe/...) never starts with /api/, so it
//     is untouched: those are R2 streams, not DB work, and mostly edge-cached.

import (
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	// Concurrent /api/* handlers allowed at once. Sized for 1 vCPU + SQLite:
	// past a few dozen in-flight queries the box is already the bottleneck, so
	// admitting more only buys memory pressure. Override with
	// OVERLOAD_MAX_INFLIGHT (0 disables the guard entirely).
	defaultMaxInflight = 48

	// How long a request waits for a slot before giving up. Long enough to ride
	// out a normal micro-burst, short enough that a queued user is not left
	// staring at a spinner.
	admitGrace = 400 * time.Millisecond

	// Message the frontend shows verbatim (see pocketbase.ts → cyoa:overload).
	overloadMessage = "The site is under heavy load right now. Please try again in a minute."
)

var (
	inflightSem  chan struct{}
	overloadHits atomic.Int64 // total rejections since boot
	lastLogUnix  atomic.Int64 // rate-limit for the journal line
)

func maxInflight() int {
	if raw := strings.TrimSpace(os.Getenv("OVERLOAD_MAX_INFLIGHT")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			return n
		}
	}
	return defaultMaxInflight
}

// guardedPath reports whether the limiter applies to this request.
func guardedPath(p string) bool {
	if !strings.HasPrefix(p, "/api/") {
		return false
	}
	if strings.HasPrefix(p, "/api/realtime") || strings.HasPrefix(p, "/api/health") {
		return false
	}
	return true
}

// registerOverloadGuard installs the limiter. Bind it FIRST in OnServe so a
// rejected request costs nothing but the check itself.
func registerOverloadGuard(log *slog.Logger, e *core.ServeEvent) {
	limit := maxInflight()
	if limit <= 0 {
		log.Info("overload guard disabled (OVERLOAD_MAX_INFLIGHT=0)")
		return
	}
	inflightSem = make(chan struct{}, limit)
	log.Info("overload guard active", "max_inflight", limit)

	e.Router.BindFunc(func(c *core.RequestEvent) error {
		if !guardedPath(c.Request.URL.Path) {
			return c.Next()
		}

		select {
		case inflightSem <- struct{}{}:
			// Free slot, common case — no timer allocated.
		default:
			timer := time.NewTimer(admitGrace)
			defer timer.Stop()
			select {
			case inflightSem <- struct{}{}:
				// Slot freed while we waited.
			case <-timer.C:
				return rejectOverloaded(log, c, limit)
			case <-c.Request.Context().Done():
				// Client hung up while queued — nothing to answer.
				return c.Request.Context().Err()
			}
		}
		defer func() { <-inflightSem }()

		return c.Next()
	})
}

// rejectOverloaded answers 503 in PocketBase's error shape, so the JS SDK
// surfaces `message` unchanged.
func rejectOverloaded(log *slog.Logger, c *core.RequestEvent, limit int) error {
	total := overloadHits.Add(1)

	// One journal line per 10s: a real overload would otherwise write thousands
	// of them at the exact moment the disk is the scarce resource.
	now := time.Now().Unix()
	if prev := lastLogUnix.Load(); now-prev >= 10 && lastLogUnix.CompareAndSwap(prev, now) {
		log.Warn("overload: shedding requests",
			"max_inflight", limit, "rejected_total", total, "path", c.Request.URL.Path)
	}

	c.Response.Header().Set("Retry-After", "30")
	// Never let an edge or browser cache a shed response — it must vanish the
	// moment the pressure does.
	c.Response.Header().Set("Cache-Control", "no-store")
	return apis.NewApiError(http.StatusServiceUnavailable, overloadMessage, nil)
}
