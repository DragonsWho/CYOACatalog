// In-flight limiter for /api/* — turns overload into a few honest 503s instead of an hour-long
// collapse. Incident 2026-07-26 05:50–06:50 UTC: nothing leaked, the box died on arithmetic. Memory
// in flight = requests in flight × cost; requests in flight = rps × latency. When SQLite slowed,
// requests lived 30s instead of 30ms, so ~7 rps parked ~200 handlers; a 500-row games list costs
// 15–20 MB while marshalling → >1 GB on a 961 MB droplet → swap → slower → more handlers. Capping
// concurrency bounds memory at limit × cost. Over the cap: wait briefly for a slot, then 503 +
// Retry-After (frontend shows "site is busy").
// Scope only /api/*: /api/realtime EXCLUDED (long-lived SSE would eat every slot); /api/health
// EXCLUDED (monitoring must answer under load); hosted-game traffic (<slug>.cyoa.cafe) never hits
// /api/ (R2 streams).
package main

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
	// Sized for 1 vCPU + SQLite. OVERLOAD_MAX_INFLIGHT overrides (0 disables).
	defaultMaxInflight = 48

	admitGrace = 400 * time.Millisecond

	// Shown verbatim by the frontend (pocketbase.ts → cyoa:overload).
	overloadMessage = "The site is under heavy load right now. Please try again in a minute."
)

var (
	inflightSem  chan struct{}
	overloadHits atomic.Int64
	lastLogUnix  atomic.Int64
)

func maxInflight() int {
	if raw := strings.TrimSpace(os.Getenv("OVERLOAD_MAX_INFLIGHT")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			return n
		}
	}
	return defaultMaxInflight
}

func guardedPath(p string) bool {
	if !strings.HasPrefix(p, "/api/") {
		return false
	}
	if strings.HasPrefix(p, "/api/realtime") || strings.HasPrefix(p, "/api/health") {
		return false
	}
	return true
}

// Bind FIRST in OnServe so a rejection costs only the check.
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
		default:
			timer := time.NewTimer(admitGrace)
			defer timer.Stop()
			select {
			case inflightSem <- struct{}{}:
			case <-timer.C:
				return rejectOverloaded(log, c, limit)
			case <-c.Request.Context().Done():
				return c.Request.Context().Err()
			}
		}
		defer func() { <-inflightSem }()

		return c.Next()
	})
}

// PocketBase error shape so the JS SDK surfaces `message` unchanged.
func rejectOverloaded(log *slog.Logger, c *core.RequestEvent, limit int) error {
	total := overloadHits.Add(1)

	// One journal line per 10s: real overload would write thousands exactly when disk is scarce.
	now := time.Now().Unix()
	if prev := lastLogUnix.Load(); now-prev >= 10 && lastLogUnix.CompareAndSwap(prev, now) {
		log.Warn("overload: shedding requests",
			"max_inflight", limit, "rejected_total", total, "path", c.Request.URL.Path)
	}

	c.Response.Header().Set("Retry-After", "30")
	// Never cache a shed response.
	c.Response.Header().Set("Cache-Control", "no-store")
	return apis.NewApiError(http.StatusServiceUnavailable, overloadMessage, nil)
}
