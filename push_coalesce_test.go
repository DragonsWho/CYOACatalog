package main

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// running: true — collector not started; tests call flush by hand (else every test leaves a ticking
// goroutine).
func newCoalescer() *pushCoalescer {
	return &pushCoalescer{
		pend:    map[string]*pushPending{},
		sent:    map[string]time.Time{},
		running: true,
	}
}

func testSub(endpoint string) *core.Record {
	coll := core.NewBaseCollection(pushSubsCol)
	coll.Fields.Add(&core.TextField{Name: "endpoint"})
	rec := core.NewRecord(coll)
	rec.Set("endpoint", endpoint)
	return rec
}

// First message goes immediately, the rest accumulate. The old fuse sent the first and DROPPED the
// rest.
func TestCoalesceFirstOutRestAccumulate(t *testing.T) {
	c := newCoalescer()
	sub := testSub("https://fcm.example/1")
	for i := 0; i < 5; i++ {
		c.queue(nil, sub, "chan1", "General", "Alice", "hi")
	}
	if len(c.pend) != 1 {
		t.Fatalf("pending: %d entries, want 1", len(c.pend))
	}
	for _, p := range c.pend {
		if p.n != 4 {
			t.Errorf("accumulated %d, want 4 (the first was sent immediately)", p.n)
		}
		if p.author != "Alice" || p.body != "hi" {
			t.Errorf("pending must hold the latest message, got %q/%q", p.author, p.body)
		}
	}
}

func TestCoalesceFlushWaitsForWindow(t *testing.T) {
	c := newCoalescer()
	sub := testSub("https://fcm.example/2")
	c.queue(nil, sub, "chan1", "General", "Alice", "one")
	c.queue(nil, sub, "chan1", "General", "Alice", "two")

	c.flush(nil)
	if len(c.pend) != 1 {
		t.Fatalf("window not over, but pending was already sent")
	}

	for k := range c.sent {
		c.sent[k] = time.Now().Add(-pushCoalesceWindow - time.Second)
	}
	c.flush(nil)
	if len(c.pend) != 0 {
		t.Fatalf("window over, but pending remains: %d", len(c.pend))
	}
}

func TestCoalesceRoomsStaySeparate(t *testing.T) {
	c := newCoalescer()
	sub := testSub("https://fcm.example/3")
	for i := 0; i < 3; i++ {
		c.queue(nil, sub, "chan1", "General", "Alice", "hi")
		c.queue(nil, sub, "chan2", "Secret", "Bob", "yo")
	}
	if len(c.pend) != 2 {
		t.Fatalf("pending: %d entries, want 2 (one per room)", len(c.pend))
	}
}

func TestCoalesceForgetDropsEverything(t *testing.T) {
	c := newCoalescer()
	sub := testSub("https://fcm.example/4")
	other := testSub("https://fcm.example/5")
	c.queue(nil, sub, "chan1", "General", "Alice", "hi")
	c.queue(nil, sub, "chan1", "General", "Alice", "hi again")
	c.queue(nil, other, "chan1", "General", "Alice", "hi")
	c.queue(nil, other, "chan1", "General", "Alice", "hi again")

	c.forget(pushDeviceKey(sub.GetString("endpoint")))
	if len(c.pend) != 1 || len(c.sent) != 1 {
		t.Fatalf("forgot the wrong device: pend=%d sent=%d", len(c.pend), len(c.sent))
	}
	c.queue(nil, sub, "chan1", "General", "Alice", "third")
	if len(c.pend) != 1 {
		t.Fatalf("after a read the first message must be sent immediately")
	}
}

func TestPushRoomTitleAndTag(t *testing.T) {
	if got := pushRoomTitle(""); got != "CYOA.CAFE chat" {
		t.Errorf("unnamed room: %q", got)
	}
	if got := pushRoomTitle("General"); got != "General" {
		t.Errorf("named room: %q", got)
	}
	if pushRoomTag("") == pushRoomTag("chan1") {
		t.Error("an unnamed room must not merge with a named one")
	}
}
