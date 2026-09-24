// HTTP client for game downloads. Jobs come from the website, so a download URL is untrusted input:
// the dialer refuses loopback/private/link-local addresses, otherwise a hostile job could make the
// helper fetch pages from the moderator's own network and upload them to public hosting.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

var errPrivateAddr = errors.New("refusing to connect to a local/private network address")

// testAllowLoopback lets unit tests crawl an httptest server; never set outside tests.
var testAllowLoopback = false

func publicIP(ip net.IP) bool {
	if testAllowLoopback && ip.IsLoopback() {
		return true
	}
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast())
}

func guardedDialer() func(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			if !publicIP(ip.IP) {
				return nil, fmt.Errorf("%w (%s → %s)", errPrivateAddr, host, ip.IP)
			}
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("no address for %s", host)
		}
		// Dial the address we checked, not a second lookup (DNS rebinding).
		return d.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}
}

func newDownloadClient(timeout time.Duration) *http.Client {
	tr := &http.Transport{
		DialContext:           guardedDialer(),
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 45 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{
		Transport: tr,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("redirect to a non-web address")
			}
			return nil
		},
	}
}

// checkPublicURL: a quick pre-flight for jobs (the dialer is the real guard).
func checkPublicURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("not a web link (needs http:// or https://)")
	}
	h := strings.ToLower(u.Hostname())
	if !testAllowLoopback && h == "localhost" || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".localhost") {
		return nil, errPrivateAddr
	}
	if ip := net.ParseIP(h); ip != nil && !publicIP(ip) {
		return nil, errPrivateAddr
	}
	return u, nil
}
