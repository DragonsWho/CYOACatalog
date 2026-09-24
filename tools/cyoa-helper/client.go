// cyoa.cafe API client (routes in the site repo's modkit.go). The helper token is sent in
// X-Helper-Token; it is useless without a moderator account that has the mod_upload permission.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var errUnpaired = errors.New("this helper is not connected (or was disconnected on the site)")

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status) }

type Client struct {
	Server string
	Token  string
	http   *http.Client
}

func NewClient(server, token string) *Client {
	return &Client{Server: strings.TrimRight(server, "/"), Token: token,
		http: &http.Client{Timeout: 5 * time.Minute}}
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, contentType string, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.Server+"/api/modkit"+path, body)
	if err != nil {
		return 0, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("User-Agent", "cyoa-helper/"+version+" ("+runtime.GOOS+")")
	req.Header.Set("X-Helper-Version", version)
	if c.Token != "" {
		req.Header.Set("X-Helper-Token", c.Token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode == http.StatusNoContent {
		return resp.StatusCode, nil
	}
	if resp.StatusCode >= 400 {
		var e struct{ Error, Message string }
		_ = json.Unmarshal(data, &e)
		msg := e.Message
		if msg == "" {
			msg = e.Error
		}
		if msg == "" {
			msg = strings.TrimSpace(string(data))
			if len(msg) > 200 {
				msg = msg[:200]
			}
		}
		if (resp.StatusCode == 401 || resp.StatusCode == 403) && c.Token != "" && strings.Contains(path, "/helper/") {
			return resp.StatusCode, fmt.Errorf("%w: %s", errUnpaired, msg)
		}
		return resp.StatusCode, &APIError{resp.StatusCode, msg}
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("unexpected server reply: %w", err)
		}
	}
	return resp.StatusCode, nil
}

func (c *Client) postJSON(ctx context.Context, path string, in, out any) error {
	b, _ := json.Marshal(in)
	_, err := c.do(ctx, "POST", path, bytes.NewReader(b), "application/json", out)
	return err
}

// ---- pairing ----

type PairStart struct {
	Code      string `json:"code"`
	Secret    string `json:"secret"`
	ExpiresIn int    `json:"expires_in"`
	PairURL   string `json:"pair_url"`
}

type PairPoll struct {
	Status   string `json:"status"`
	Token    string `json:"token"`
	DeviceID string `json:"device_id"`
	User     string `json:"user"`
}

func (c *Client) PairStart(ctx context.Context, name string) (*PairStart, error) {
	var out PairStart
	err := c.postJSON(ctx, "/pair/start", map[string]string{
		"name": name, "platform": runtime.GOOS + "/" + runtime.GOARCH, "version": version,
	}, &out)
	return &out, err
}

func (c *Client) PairPoll(ctx context.Context, secret string) (*PairPoll, error) {
	var out PairPoll
	err := c.postJSON(ctx, "/pair/poll", map[string]string{"secret": secret}, &out)
	return &out, err
}

// ---- helper ----

type Me struct {
	User   string `json:"user"`
	Device struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"device"`
}

func (c *Client) Me(ctx context.Context) (*Me, error) {
	var out Me
	_, err := c.do(ctx, "GET", "/helper/me", nil, "", &out)
	return &out, err
}

type Job struct {
	ID     string         `json:"id"`
	Kind   string         `json:"kind"`
	Status string         `json:"status"`
	Input  map[string]any `json:"input"`
}

func (j *Job) In(k string) string {
	if v, ok := j.Input[k].(string); ok {
		return v
	}
	return ""
}

// Next long-polls for a queued job; nil when none arrived.
func (c *Client) Next(ctx context.Context, wait int) (*Job, error) {
	var out struct {
		Job *Job `json:"job"`
	}
	_, err := c.do(ctx, "GET", "/helper/next?wait="+strconv.Itoa(wait), nil, "", &out)
	return out.Job, err
}

// CreateJob records a job started from the helper's own menu so it shows on the site.
func (c *Client) CreateJob(ctx context.Context, kind, status string, input, result map[string]any) (*Job, error) {
	var out struct {
		Job *Job `json:"job"`
	}
	body := map[string]any{"kind": kind, "status": status, "input": input}
	if result != nil {
		body["result"] = result
	}
	err := c.postJSON(ctx, "/helper/jobs", body, &out)
	return out.Job, err
}

type ProgressUpdate struct {
	Status   string         `json:"status,omitempty"`
	Progress map[string]any `json:"progress,omitempty"`
	Log      string         `json:"log,omitempty"`
	Result   any            `json:"result,omitempty"`
	Error    string         `json:"error,omitempty"`
}

// Progress returns cancelled=true when the moderator cancelled the job on the site.
func (c *Client) Progress(ctx context.Context, jobID string, u ProgressUpdate) (bool, error) {
	var out struct {
		Cancelled bool `json:"cancelled"`
	}
	err := c.postJSON(ctx, "/helper/jobs/"+jobID+"/progress", u, &out)
	return out.Cancelled, err
}

type PartReply struct {
	Final   bool   `json:"-"`
	URL     string `json:"url"`
	Version int    `json:"version"`
}

func (c *Client) UploadPart(ctx context.Context, jobID string, index int, final bool, zipData []byte) (*PartReply, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("job", jobID)
	_ = mw.WriteField("part_index", strconv.Itoa(index))
	_ = mw.WriteField("version", "1")
	_ = mw.WriteField("final", strconv.FormatBool(final))
	fw, _ := mw.CreateFormFile("archive", fmt.Sprintf("part%03d.zip", index))
	_, _ = fw.Write(zipData)
	_ = mw.Close()
	var out PartReply
	_, err := c.do(ctx, "POST", "/helper/upload-part", &buf, mw.FormDataContentType(), &out)
	out.Final = final
	return &out, err
}
