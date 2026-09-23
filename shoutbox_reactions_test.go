package main

import (
	"fmt"
	"testing"
)

func TestShoutReactNameRe(t *testing.T) {
	for _, n := range []string{"fire", "thumbs_up", "cat2", "a1"} {
		if !shoutReactNameRe.MatchString(n) {
			t.Errorf("%q must be accepted", n)
		}
	}
	for _, n := range []string{"3", "d", "", "Fire", "cat-2", "кот", "a b"} {
		if shoutReactNameRe.MatchString(n) {
			t.Errorf("%q must be rejected", n)
		}
	}
}

func TestShoutReactToggleAddAndRemove(t *testing.T) {
	m := map[string][]string{}

	if err := shoutReactToggle(m, "fire", "u1"); err != nil {
		t.Fatalf("add: %v", err)
	}
	if got := m["fire"]; len(got) != 1 || got[0] != "u1" {
		t.Fatalf("after add: %v", m)
	}

	if err := shoutReactToggle(m, "fire", "u2"); err != nil {
		t.Fatalf("second add: %v", err)
	}
	if len(m["fire"]) != 2 {
		t.Fatalf("two users must be counted separately: %v", m)
	}

	if err := shoutReactToggle(m, "fire", "u1"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if got := m["fire"]; len(got) != 1 || got[0] != "u2" {
		t.Fatalf("after removal only u2 must remain: %v", m)
	}

	if err := shoutReactToggle(m, "fire", "u2"); err != nil {
		t.Fatalf("removing the last one: %v", err)
	}
	if _, ok := m["fire"]; ok {
		t.Fatalf("an empty emoji entry must disappear: %v", m)
	}
}

func TestShoutReactToggleKindsCap(t *testing.T) {
	m := map[string][]string{}
	for i := 0; i < shoutReactMaxKinds; i++ {
		if err := shoutReactToggle(m, fmt.Sprintf("e%d", i), "u1"); err != nil {
			t.Fatalf("emoji %d: %v", i, err)
		}
	}
	if err := shoutReactToggle(m, "onemore", "u1"); err == nil {
		t.Error("past the cap a new emoji must be rejected")
	}
	// Cap applies only to NEW names: joining an existing reaction or removing yours always works, else
	// a full message gets stuck.
	if err := shoutReactToggle(m, "e0", "u2"); err != nil {
		t.Errorf("joining an existing one: %v", err)
	}
	if err := shoutReactToggle(m, "e0", "u1"); err != nil {
		t.Errorf("removing own reaction on a full map: %v", err)
	}
}

func TestShoutReactTogglePerKindCap(t *testing.T) {
	m := map[string][]string{}
	for i := 0; i < shoutReactMaxPerKind; i++ {
		if err := shoutReactToggle(m, "fire", fmt.Sprintf("u%d", i)); err != nil {
			t.Fatalf("reaction %d: %v", i, err)
		}
	}
	if err := shoutReactToggle(m, "fire", "extra"); err == nil {
		t.Error("past the per-reaction cap a new vote must be rejected")
	}
}
