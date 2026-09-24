// Local preview: serves workspace games at http://127.0.0.1:<port>/items/<id>/ so the moderator can
// play a downloaded game before uploading it. Loopback only.
package main

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

const previewPortDefault = 17645

type Preview struct {
	ws   *Workspace
	port int
}

func startPreview(ws *Workspace) (*Preview, error) {
	var ln net.Listener
	var err error
	for _, port := range []int{previewPortDefault, previewPortDefault + 1, previewPortDefault + 2, 0} {
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	p := &Preview{ws: ws, port: ln.Addr().(*net.TCPAddr).Port}
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return p, nil
}

func (p *Preview) URL(itemID string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/items/%s/", p.port, itemID)
}

func (p *Preview) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// DNS-rebinding guard: only answer to loopback host names.
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host != "127.0.0.1" && host != "localhost" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/items/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	id, sub, _ := strings.Cut(rest, "/")
	it, err := p.ws.Get(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if !strings.Contains(rest, "/") {
		http.Redirect(w, r, "/items/"+id+"/", http.StatusFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/" + sub
	http.FileServer(http.Dir(it.GameDir())).ServeHTTP(w, r2)
}
