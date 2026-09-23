package main

import (
	"strconv"
	"testing"
	"time"
)

func TestShoutPrefValid(t *testing.T) {
	for _, m := range []string{"", "all", "mentions", "mute", "mute1h", "mute24h"} {
		if !shoutPrefValid(m) {
			t.Errorf("%q must be accepted", m)
		}
	}
	// Raw "mute:<unix>" from a client must be rejected — the server sets the expiry, else "mute until
	// 2099" arrives from outside.
	for _, m := range []string{"mute:1785000000", "MUTE", "mute2h", "all "} {
		if shoutPrefValid(m) {
			t.Errorf("%q must be rejected", m)
		}
	}
}

func TestShoutPrefStoreFitsField(t *testing.T) {
	for _, m := range []string{"mute1h", "mute24h"} {
		got := shoutPrefStore(m)
		if len(got) > 16 {
			t.Errorf("%q → %q: %d chars, but the mode field holds 16", m, got, len(got))
		}
		rest := got[len("mute:"):]
		until, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			t.Fatalf("%q → %q: does not parse", m, got)
		}
		if until <= time.Now().Unix() {
			t.Errorf("%q → %q: already expired", m, got)
		}
	}
	for _, m := range []string{"", "all", "mentions", "mute"} {
		if got := shoutPrefStore(m); got != m {
			t.Errorf("%q → %q, want unchanged", m, got)
		}
	}
}

func TestShoutModeTimedMute(t *testing.T) {
	live := "mute:" + strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	if got := shoutMode(live); got != "mute" {
		t.Errorf("live mute = %q, want \"mute\"", got)
	}
	// Expired = follow the device, not "silent forever".
	past := "mute:" + strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10)
	if got := shoutMode(past); got != "" {
		t.Errorf("expired mute = %q, want empty string", got)
	}
	if got := shoutMode("mute:garbage"); got != "" {
		t.Errorf("garbage expiry = %q, want empty string", got)
	}
	// Rows from before timed mutes keep working as permanent mute.
	for _, m := range []string{"", "all", "mentions", "mute"} {
		if got := shoutMode(m); got != m {
			t.Errorf("shoutMode(%q) = %q", m, got)
		}
	}
}

func TestShoutPrefRoundTrip(t *testing.T) {
	// What the handler returns must equal what the push sender sees.
	if got := shoutMode(shoutPrefStore("mute1h")); got != "mute" {
		t.Errorf("mute1h → %q, want \"mute\"", got)
	}
	if got := shoutMode(shoutPrefStore("mute24h")); got != "mute" {
		t.Errorf("mute24h → %q, want \"mute\"", got)
	}
}
