package main

import (
	"context"
	"os"
	"testing"
)

// CYOA_LIVE_URL=https://… go test -run TestLive -v  — crawls a real game into a temp workspace.
func TestLive(t *testing.T) {
	u := os.Getenv("CYOA_LIVE_URL")
	if u == "" {
		t.Skip("CYOA_LIVE_URL not set")
	}
	ws := &Workspace{Root: t.TempDir()}
	it, _ := ws.NewItem("live", u)
	cr, err := NewCrawler(context.Background(), u, it.GameDir(), t.Logf, nil)
	if err != nil {
		t.Fatal(err)
	}
	st, err := cr.Run()
	if err != nil {
		t.Fatal(err)
	}
	rep := checkGame(it, st)
	t.Logf("%+v", rep)
}
