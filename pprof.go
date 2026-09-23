// Heap/goroutine pprof on a LOOPBACK-only port. After the 2026-07-26 outage we knew HOW MUCH memory
// (744 MB RSS + 653 MB swap) but not WHERE; Go keeps no heap history, so pprof must already be
// listening when the spike happens. Idle cost: one socket + a parked goroutine (block/mutex
// profiler stays off). Bound to 127.0.0.1 only: pprof leaks internals and can stall the process; CF
// Tunnel forwards only :8090. Access: ssh -L 6060:127.0.0.1:6060 <droplet>, then go tool pprof
// -http=: http://127.0.0.1:6060/debug/pprof/heap (cyoa-watch grabs snapshots automatically).
// PPROF_ADDR moves it, PPROF_ADDR=off disables.
package main

import (
	"net/http"
	"net/http/pprof"
	"os"
	"strings"
	"time"
)

func startPprof(logf func(string, ...any)) {
	addr := strings.TrimSpace(os.Getenv("PPROF_ADDR"))
	if addr == "" {
		addr = "127.0.0.1:6060"
	}
	if strings.EqualFold(addr, "off") {
		return
	}
	// Refuse non-loopback even if env says so — a typo would be a real hole.
	if !strings.HasPrefix(addr, "127.0.0.1:") && !strings.HasPrefix(addr, "localhost:") {
		logf("pprof: refusing non-loopback address %q, using 127.0.0.1:6060", addr)
		addr = "127.0.0.1:6060"
	}

	// Own mux: net/http/pprof registers on DefaultServeMux by import side effect; never serve
	// DefaultServeMux.
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      120 * time.Second,
	}

	go func() {
		logf("pprof listening on %s (loopback only)", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			// Never fatal.
			logf("pprof: %v", err)
		}
	}()
}
