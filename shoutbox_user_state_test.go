package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestShoutMergeReadsOnlyGrows(t *testing.T) {
	cur := map[string]int64{"aaaaaaaaaaaaaaa": 200, "bbbbbbbbbbbbbbb": 100}
	// A phone idle for a week must not roll back what was read on the laptop.
	got, changed := shoutMergeReads(cur, map[string]int64{"aaaaaaaaaaaaaaa": 150})
	if changed {
		t.Error("a stale mark must not count as a change")
	}
	if got["aaaaaaaaaaaaaaa"] != 200 {
		t.Errorf("mark rolled back: %d", got["aaaaaaaaaaaaaaa"])
	}

	got, changed = shoutMergeReads(cur, map[string]int64{"aaaaaaaaaaaaaaa": 300})
	if !changed {
		t.Error("a newer mark must count as a change")
	}
	if got["aaaaaaaaaaaaaaa"] != 300 {
		t.Errorf("mark did not advance: %d", got["aaaaaaaaaaaaaaa"])
	}
	if got["bbbbbbbbbbbbbbb"] != 100 {
		t.Errorf("another channel's mark moved: %d", got["bbbbbbbbbbbbbbb"])
	}
}

func TestShoutMergeReadsRejectsJunk(t *testing.T) {
	junk := map[string]int64{
		"":                      10,
		strings.Repeat("x", 40): 10,
		"ccccccccccccccc":       -5,
		"ddddddddddddddd":       1 << 41,
	}
	got, changed := shoutMergeReads(nil, junk)
	if changed || len(got) != 0 {
		t.Errorf("garbage leaked through: %v", got)
	}
}

func TestShoutMergeReadsCap(t *testing.T) {
	in := map[string]int64{}
	for i := 0; i < shoutReadsMax+50; i++ {
		in[shoutTestID(i)] = int64(i + 1)
	}
	got, changed := shoutMergeReads(nil, in)
	if !changed {
		t.Fatal("expected a change")
	}
	if len(got) != shoutReadsMax {
		t.Fatalf("after trimming %d entries, want %d", len(got), shoutReadsMax)
	}
	if _, ok := got[shoutTestID(shoutReadsMax+49)]; !ok {
		t.Error("the newest mark was trimmed")
	}
	if _, ok := got[shoutTestID(0)]; ok {
		t.Error("the oldest mark was not trimmed")
	}
}

func shoutTestID(i int) string {
	return fmt.Sprintf("%015d", i)
}

func TestShoutCleanLine(t *testing.T) {
	if got := shoutCleanLine("Рыжая\nзануда", shoutAliasMax); got != "Рыжая зануда" {
		t.Errorf("newline not removed: %q", got)
	}
	if got := shoutCleanLine("  пробелы  ", shoutAliasMax); got != "пробелы" {
		t.Errorf("edges not trimmed: %q", got)
	}
	// Cut by runes, not bytes, or Cyrillic gets cut at half length and mid-character.
	long := strings.Repeat("я", shoutAliasMax+10)
	got := shoutCleanLine(long, shoutAliasMax)
	if n := len([]rune(got)); n != shoutAliasMax {
		t.Errorf("length %d runes, want %d", n, shoutAliasMax)
	}
	if !isValidUTF8(got) {
		t.Error("truncation split a character")
	}
}

func TestShoutCleanNoteKeepsNewlines(t *testing.T) {
	if got := shoutCleanNote("раз\nдва\nтри", shoutNoteMax); got != "раз\nдва\nтри" {
		t.Errorf("newlines destroyed: %q", got)
	}
	if got := shoutCleanNote("раз\r\nдва", shoutNoteMax); got != "раз\nдва" {
		t.Errorf("\\r not removed: %q", got)
	}
	if strings.ContainsRune(shoutCleanNote("а\x00б", shoutNoteMax), 0) {
		t.Error("NUL byte leaked through")
	}
}

func isValidUTF8(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}
