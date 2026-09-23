package main

import (
	"fmt"
	"testing"
)

// Visibility default is where chat diverged from the author three times: "a registered user is
// listed until they hide themselves". This pins that rule and its stickiness.
func newPresenceState() *shoutState {
	return &shoutState{presence: map[string]presenceEntry{}}
}

func card(id string) shoutWho { return shoutWho{ID: id, Name: id} }

func TestPingShowsSignedInByDefault(t *testing.T) {
	s := newPresenceState()
	s.ping("ip|u1", card("u1"))

	who, guests, hidden, _ := s.whoList()
	if len(who) != 1 || who[0].ID != "u1" {
		t.Fatalf("a signed-in user must be listed by default, got %v", who)
	}
	if guests != 0 || hidden != 0 {
		t.Fatalf("unexpected counts: guests=%d hidden=%d", guests, hidden)
	}
}

func TestPingCountsGuestsSeparately(t *testing.T) {
	s := newPresenceState()
	s.ping("ip-a|", shoutWho{})
	s.ping("ip-b|", shoutWho{})
	s.ping("ip|u1", card("u1"))

	who, guests, hidden, _ := s.whoList()
	if len(who) != 1 || guests != 2 || hidden != 0 {
		t.Fatalf("want 1 listed and 2 guests, got who=%d guests=%d hidden=%d",
			len(who), guests, hidden)
	}
}

func TestHiddenCountsButIsNotListed(t *testing.T) {
	s := newPresenceState()
	s.pingHidden("ip|u1")

	who, guests, hidden, _ := s.whoList()
	if len(who) != 0 {
		t.Fatalf("a hidden user appeared in the list: %v", who)
	}
	if hidden != 1 || guests != 0 {
		t.Fatalf("a hidden user must count as hidden, got guests=%d hidden=%d", guests, hidden)
	}

	// Unchecking chat_hidden in the profile brings the user back on the very next ping (no waiting for
	// presence expiry).
	s.ping("ip|u1", card("u1"))
	who, _, hidden, _ = s.whoList()
	if len(who) != 1 || hidden != 0 {
		t.Fatalf("clearing chat_hidden did not relist the user: who=%v hidden=%d", who, hidden)
	}
}

// The list cap must be AUDIBLE. The old one cut silently and alphabetically — in prod it looked
// like "chat doesn't see half the people".
func TestWhoListReportsCutTail(t *testing.T) {
	s := newPresenceState()
	for i := 0; i < shoutWhoLimit+5; i++ {
		id := fmt.Sprintf("u%04d", i)
		s.ping("ip|"+id, card(id))
	}

	who, guests, hidden, cut := s.whoList()
	if len(who) != shoutWhoLimit {
		t.Fatalf("the list must hit the cap, got %d", len(who))
	}
	if cut != 5 {
		t.Fatalf("want 5 cut, got %d", cut)
	}
	if guests != 0 || hidden != 0 {
		t.Fatalf("cut users are neither guests nor hidden: guests=%d hidden=%d", guests, hidden)
	}
}

func TestWhoListDedupsSameAccount(t *testing.T) {
	s := newPresenceState()
	s.ping("ip-a|u1", card("u1"))
	s.ping("ip-b|u1", card("u1"))

	who, guests, hidden, _ := s.whoList()
	if len(who) != 1 || guests != 0 || hidden != 0 {
		t.Fatalf("one account on two devices must be one row: who=%d guests=%d hidden=%d",
			len(who), guests, hidden)
	}
}

// "Who's in this topic" slice: foreign rooms excluded, anonymous counted as a number,
// on-site-but-not-in-chat nowhere.
func TestWhoHereFiltersByChannel(t *testing.T) {
	s := newPresenceState()
	s.ping("ip|u1", card("u1"))
	s.noteWhere("ip|u1", "th1")
	s.ping("ip|u2", card("u2"))
	s.noteWhere("ip|u2", "th2")
	s.ping("ip-g|", shoutWho{})
	s.noteWhere("ip-g|", "th1")
	s.ping("ip|u3", card("u3"))

	here, more := s.whoHere("th1")
	if len(here) != 1 || here[0].ID != "u1" {
		t.Fatalf("want only u1 in th1, got %v", here)
	}
	if more != 1 {
		t.Fatalf("an anonymous viewer in th1 must be counted, got more=%d", more)
	}
	if h, m := s.whoHere(""); len(h) != 0 || m != 0 {
		t.Fatalf("no channel → empty list, got who=%v more=%d", h, m)
	}
}

// A header ping must not erase "I'm in this topic": noteWhere is only called from chat, presence is
// refreshed from anywhere.
func TestWhoHereSurvivesPlainPing(t *testing.T) {
	s := newPresenceState()
	s.ping("ip|u1", card("u1"))
	s.noteWhere("ip|u1", "th1")
	s.ping("ip|u1", card("u1"))

	if here, _ := s.whoHere("th1"); len(here) != 1 {
		t.Fatalf("a plain ping must not drop the user from the thread, got %v", here)
	}
}
