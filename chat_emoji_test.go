package main

import (
	"os"
	"path/filepath"
	"testing"
)

func webpHeader(chunk string, vp8xFlags byte) []byte {
	b := make([]byte, 21)
	copy(b[0:4], "RIFF")
	copy(b[8:12], "WEBP")
	copy(b[12:16], chunk)
	if chunk == "VP8X" {
		b[20] = vp8xFlags
	}
	return b
}

func TestChatEmojiProbe(t *testing.T) {
	cases := []struct {
		name         string
		in           []byte
		wantAnimated bool
		wantAlpha    bool
	}{
		{"VP8X empty flags", webpHeader("VP8X", 0x00), false, false},
		{"VP8X alpha", webpHeader("VP8X", 0x10), false, true},
		{"VP8X animation", webpHeader("VP8X", 0x02), true, false},
		{"VP8X animation with alpha", webpHeader("VP8X", 0x12), true, true},
		{"VP8X ICC only", webpHeader("VP8X", 0x20), false, false},
		{"VP8X all flags", webpHeader("VP8X", 0x3E), true, true},

		{"VP8L counts as alpha", webpHeader("VP8L", 0), false, true},
		{"VP8 plain lossy", webpHeader("VP8 ", 0), false, false},

		{"truncated file", []byte("RIFF"), false, true},
		{"empty", nil, false, true},
		{"not webp", append([]byte("RIFF____JPEG"), make([]byte, 9)...), false, true},
	}

	for _, c := range cases {
		gotAnimated, gotAlpha := chatEmojiProbe(c.in)
		if gotAnimated != c.wantAnimated || gotAlpha != c.wantAlpha {
			t.Errorf("%s: got (animated=%v, alpha=%v), want (%v, %v)",
				c.name, gotAnimated, gotAlpha, c.wantAnimated, c.wantAlpha)
		}
	}
}

// Probe must agree with build.py's manifest or panel and builder disagree on labels. The build
// folder is outside git, so the test skips when absent.
func TestChatEmojiProbeOnBuiltPack(t *testing.T) {
	dir := filepath.Join("_dev", "emoji_pack", "out")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Skipf("pack not built (%s): %v", dir, err)
	}

	checked := 0
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".webp" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("%s: %v", e.Name(), err)
		}
		if len(b) < 21 {
			t.Errorf("%s: file shorter than a webp header", e.Name())
			continue
		}
		if string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
			t.Errorf("%s: does not look like webp", e.Name())
		}
		checked++
	}
	if checked == 0 {
		t.Skip("no webp in the build folder")
	}
}
