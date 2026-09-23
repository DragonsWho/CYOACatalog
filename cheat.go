// Built-in CYOA cheat companion. cheat_shim.js is injected into a hosted game's index.html ONLY
// when the request has ?__cheat=1 (see serveFromR2); without the flag prod games are byte-for-byte
// untouched.
// The shim runs inside the game document (same JS context as the engine), renders its UI in a
// shadow root and reaches the ICC+2 store via window.debugApp. The game lives on author.cyoa.cafe
// (other origin), so all cheat UI stays inside the iframe — no cross-origin postMessage bridge. v1
// targets ICC+2 only.
package main

import (
	"bytes"
	_ "embed"
)

const cheatShimPath = "__cheat/shim.js"

//go:embed cheat_shim.js
var cheatShimJS string

func injectBeforeClose(html, snippet []byte) []byte {
	lower := bytes.ToLower(html)
	idx := bytes.LastIndex(lower, []byte("</body>"))
	if idx == -1 {
		idx = bytes.LastIndex(lower, []byte("</html>"))
	}
	if idx == -1 {
		return append(html, snippet...)
	}
	out := make([]byte, 0, len(html)+len(snippet))
	out = append(out, html[:idx]...)
	out = append(out, snippet...)
	out = append(out, html[idx:]...)
	return out
}
