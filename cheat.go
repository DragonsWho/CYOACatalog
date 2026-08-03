package main

import (
	"bytes"
	_ "embed"
)

// ---------------------------------------------------------------------------
// Built-in CYOA "cheat" companion.
//
// The shim (cheat_shim.js) is injected into a hosted game's index.html ONLY
// when the request carries ?__cheat=1 (see serveFromR2). Prod games served
// without that flag are byte-for-byte untouched. The shim runs inside the game
// document (same context as the engine) and renders its whole UI in a shadow
// root; it reaches the ICC+2 store via window.debugApp. Since the game lives on
// author.cyoa.cafe (a different origin), all the cheat UI lives inside the
// iframe — no cross-origin postMessage bridge is needed.
//
// v1 targets ICC+2 (Wahaha's Svelte engine). Legacy ICC / DW come later.
// ---------------------------------------------------------------------------

const cheatShimPath = "__cheat/shim.js"

//go:embed cheat_shim.js
var cheatShimJS string

// injectBeforeClose inserts snippet right before the closing </body> (or
// </html>) tag, falling back to append if neither exists.
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
