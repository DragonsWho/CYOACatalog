package main

import (
	"regexp"
	"strings"
)

var (
	illegalPathChars = regexp.MustCompile(`[<>:"|?*\x00-\x1f]`)
	windowsReserved  = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$`)
)

// sanitizeRelPath makes a URL path usable as a relative file path on Windows, macOS and Linux:
// no characters NTFS rejects, no reserved device names, no trailing dots/spaces, no "..".
func sanitizeRelPath(p string) string {
	parts := strings.Split(strings.ReplaceAll(p, "\\", "/"), "/")
	out := parts[:0]
	for _, seg := range parts {
		if seg == "" || seg == "." || seg == ".." {
			continue
		}
		seg = illegalPathChars.ReplaceAllString(seg, "_")
		seg = strings.TrimRight(seg, ". ")
		if seg == "" {
			seg = "_"
		}
		if windowsReserved.MatchString(seg) {
			seg = "_" + seg
		}
		if len(seg) > 150 {
			seg = seg[:150]
		}
		out = append(out, seg)
	}
	return strings.Join(out, "/")
}
