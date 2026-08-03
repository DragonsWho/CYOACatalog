package main

// Heap/goroutine introspection on a loopback-only port.
//
// Why: after the 2026-07-26 outage we could say exactly HOW MUCH memory the
// process ate (744 MB RSS + 653 MB swap) and not one word about WHERE it went.
// Go keeps no history of its own heap — once a spike passes there is nothing
// left to inspect. pprof is the only thing that answers "which allocation site",
// and it has to already be listening when the spike happens.
//
// Cost when nobody asks: a listening socket and a goroutine parked in Accept.
// The profiles themselves are computed on demand from data the runtime already
// maintains for the GC, so there is no ongoing bookkeeping and no sampling
// daemon. (The one exception is the block/mutex profiler, which does cost
// something continuously — it stays off, and this file never enables it.)
//
// Safety: bound to 127.0.0.1 only, never 0.0.0.0. pprof endpoints leak internals
// and can be used to stall a process, so they must not be reachable from the
// internet. Cloudflare Tunnel only forwards :8090, and this is a separate
// listener on :6060 — nothing routes to it from outside. Reach it over SSH:
//
//	ssh -L 6060:127.0.0.1:6060 <your-server>
//	go tool pprof -http=: http://127.0.0.1:6060/debug/pprof/heap
//
// Or grab a raw snapshot to keep (this is what cyoa-watch does automatically
// when memory climbs):
//
//	curl -s http://127.0.0.1:6060/debug/pprof/heap > heap.pb.gz
//
// Set PPROF_ADDR to move the port, or PPROF_ADDR=off to not listen at all.

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
	// Refuse to expose profiles to the world even if the env var says so — a
	// typo here would be a real hole, and there is no legitimate reason to bind
	// this anywhere but loopback.
	if !strings.HasPrefix(addr, "127.0.0.1:") && !strings.HasPrefix(addr, "localhost:") {
		logf("pprof: refusing non-loopback address %q, using 127.0.0.1:6060", addr)
		addr = "127.0.0.1:6060"
	}

	// Own mux: the pprof package registers onto http.DefaultServeMux by import
	// side effect, and DefaultServeMux must never be what we serve.
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	srv := &http.Server{
		Addr:    addr,
		Handler: mux,
		// A heap dump on a swapping box can genuinely take a while; a CPU profile
		// defaults to 30s. Generous, but not unbounded.
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      120 * time.Second,
	}

	go func() {
		logf("pprof listening on %s (loopback only)", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			// Never fatal: diagnostics failing to start must not take the site down.
			logf("pprof: %v", err)
		}
	}()
}
