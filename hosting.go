// Game hosting on <hostingSlug>.cyoa.cafe: zip upload → R2 (games/{hostingSlug}/{gameSlug}/v{N}/…),
// serving from R2 with companion-shim injection, reserved/claim flow for archived author pages,
// moderator block/restore/purge. Version switching/reupload bodies live in hosting_versions.go.
package main

import (
	"archive/zip"
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	maxZipSize              = 200 << 20
	maxFiles                = 10000
	defaultMaxGames         = 20
	defaultDailyUploadBytes = 500 << 20
	r2PathPrefix            = "games/"
	baseDomain              = "cyoa.cafe"
	// Whole-game cap for chunked upload (sum of parts). Each part-request is still capped by
	// maxZipSize; chunking dodges the ~100MB edge limit per request. See
	// /api/hosting/admin/upload-part.
	maxChunkedGameSize = 512 << 20
	// Cap on HTML we inject the shim into (?__save=1 / ?__cheat=1 / banner): injection needs the whole
	// file in memory, twice at insert time, unlike normal streaming. Largest html in the bucket today
	// is 4.6 MB (of 248k objects), but uploads don't guarantee that. Above the cap the file is served
	// as-is, without shim — the game still loads.
	maxInjectSize = 32 << 20
)

var allowedExtensions = map[string]bool{
	".html": true, ".htm": true, ".css": true, ".js": true,
	".json": true, ".xml": true, ".svg": true, ".txt": true,
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".webp": true, ".ico": true, ".woff": true, ".woff2": true,
	".ttf": true, ".otf": true, ".eot": true, ".mp3": true,
	".ogg": true, ".wav": true, ".mp4": true, ".webm": true,
	".wasm": true, ".map": true, ".avif": true,
	// AAC/Opus/FLAC containers: authors ship background music beyond mp3/ogg. Without them the file
	// silently dropped out of the zip on upload and the game arrived mute ("Lewd Horizon", bg.m4a,
	// 2026-08-12).
	".m4a": true, ".aac": true, ".opus": true, ".flac": true,
}

func newR2Client() *s3.Client {
	accountID := os.Getenv("R2_ACCOUNT_ID")
	accessKey := os.Getenv("R2_ACCESS_KEY_ID")
	secretKey := os.Getenv("R2_SECRET_ACCESS_KEY")

	if accountID == "" || accessKey == "" || secretKey == "" {
		fmt.Println("[hosting] WARNING: R2 env vars not set, hosting disabled")
		return nil
	}

	cfg, err := awsconfig.LoadDefaultConfig(context.TODO(),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
		),
		awsconfig.WithRegion("auto"),
	)
	if err != nil {
		fmt.Printf("[hosting] ERROR: S3 config: %v\n", err)
		return nil
	}

	return s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(
			fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID),
		)
	})
}

func isValidSlug(s string) bool {
	if s == "_home" {
		return true
	}
	if len(s) < 3 || len(s) > 60 {
		return false
	}
	if s[0] == '-' || s[len(s)-1] == '-' {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

func deriveHostingSlug(username string) string {
	s := strings.ToLower(username)
	var buf strings.Builder
	for _, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			buf.WriteRune(c)
		} else {
			buf.WriteRune('-')
		}
	}
	s = buf.String()
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	s = strings.Trim(s, "-")
	if len(s) < 3 {
		s = s + "-cafe"
	}
	return s
}

var slugMu sync.Mutex

func ensureHostingSlug(app *pocketbase.PocketBase, user *core.Record) (string, error) {
	slug := user.GetString("hosting_slug")
	if slug != "" {
		return slug, nil
	}

	slugMu.Lock()
	defer slugMu.Unlock()

	// Re-read after taking the lock: another goroutine may have created the slug.
	fresh, err := app.FindRecordById("users", user.Id)
	if err == nil && fresh.GetString("hosting_slug") != "" {
		return fresh.GetString("hosting_slug"), nil
	}

	slug = deriveHostingSlug(user.GetString("username"))

	if reservedSubdomains[slug] {
		slug = slug + "-games"
	}

	for attempt := 0; attempt < 10; attempt++ {
		candidate := slug
		if attempt > 0 {
			candidate = fmt.Sprintf("%s-%d", slug, attempt)
		}
		existing, _ := app.FindFirstRecordByFilter(
			"users",
			"hosting_slug = {:slug} && id != {:id}",
			dbx.Params{"slug": candidate, "id": user.Id},
		)
		if existing == nil {
			slug = candidate
			break
		}
	}

	user.Set("hosting_slug", slug)
	if err := app.Save(user); err != nil {
		return "", err
	}
	fmt.Printf("[hosting] Generated slug '%s' for user '%s'\n", slug, user.GetString("username"))
	return slug, nil
}

func extractSubdomain(host string) string {
	if idx := strings.LastIndex(host, ":"); idx != -1 {
		host = host[:idx]
	}

	parts := strings.SplitN(host, ".", 2)
	if len(parts) < 2 || parts[1] != baseDomain {
		return ""
	}

	sub := parts[0]

	if reservedSubdomains[sub] {
		return ""
	}

	for _, c := range sub {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return ""
		}
	}

	return sub
}

type cacheEntry struct {
	exists  bool
	version int
	expires time.Time
}

type lruCache struct {
	mu    sync.RWMutex
	items map[string]cacheEntry
}

var lookupCache = &lruCache{items: make(map[string]cacheEntry)}

func (c *lruCache) get(key string) (exists bool, version int, ok bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, found := c.items[key]
	if !found || time.Now().After(e.expires) {
		return false, 0, false
	}
	return e.exists, e.version, true
}

func (c *lruCache) set(key string, exists bool, version int) {
	c.mu.Lock()
	c.items[key] = cacheEntry{exists, version, time.Now().Add(5 * time.Minute)}
	c.mu.Unlock()
}

func (c *lruCache) drop(key string) {
	c.mu.Lock()
	delete(c.items, key)
	c.mu.Unlock()
}

func (c *lruCache) cleanup() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, v := range c.items {
		if now.After(v.expires) {
			delete(c.items, k)
		}
	}
}

func r2GamePrefix(hostingSlug, gameSlug string) string {
	return fmt.Sprintf("%s%s/%s/", r2PathPrefix, hostingSlug, gameSlug)
}

func r2VersionPrefix(hostingSlug, gameSlug string, version int) string {
	if version <= 0 {
		version = 1
	}
	return fmt.Sprintf("%s%s/%s/v%d/", r2PathPrefix, hostingSlug, gameSlug, version)
}

func findCommonPrefix(files []*zip.File) string {
	prefix := ""
	initialized := false
	for _, f := range files {
		if f.FileInfo().IsDir() {
			continue
		}
		parts := strings.SplitN(f.Name, "/", 2)
		if len(parts) < 2 {
			return ""
		}
		if !initialized {
			prefix = parts[0]
			initialized = true
		} else if parts[0] != prefix {
			return ""
		}
	}
	if prefix != "" {
		return prefix + "/"
	}
	return ""
}

type uploadResult struct {
	totalSize int64
	fileCount int
	fileKeys  []string
}

func processZipToR2(zipData []byte, client *s3.Client, bucket, prefix string, sizeLimit int64) (*uploadResult, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return nil, fmt.Errorf("invalid zip archive")
	}

	cp := findCommonPrefix(zr.File)
	result := &uploadResult{}
	hasIndex := false

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := f.Name
		if cp != "" {
			name = strings.TrimPrefix(name, cp)
		}
		if name == "" {
			continue
		}

		name = filepath.ToSlash(filepath.Clean(name))
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			return nil, fmt.Errorf("invalid path: %s", name)
		}

		ext := strings.ToLower(filepath.Ext(name))
		if !allowedExtensions[ext] {
			return nil, fmt.Errorf("file type not allowed: %s (%s)", ext, name)
		}

		result.fileCount++
		if result.fileCount > maxFiles {
			return nil, fmt.Errorf("too many files (max %d)", maxFiles)
		}

		result.totalSize += int64(f.UncompressedSize64)
		if result.totalSize > sizeLimit {
			return nil, fmt.Errorf("total size exceeds %d MB", sizeLimit>>20)
		}

		if name == "index.html" {
			hasIndex = true
		}
	}

	if !hasIndex {
		return nil, fmt.Errorf("archive must contain index.html")
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	sem := make(chan struct{}, 25)
	errCh := make(chan error, 1)

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}

		name := f.Name
		if cp != "" {
			name = strings.TrimPrefix(name, cp)
		}
		if name == "" {
			continue
		}
		name = filepath.ToSlash(filepath.Clean(name))

		wg.Add(1)
		sem <- struct{}{}

		go func(file *zip.File, fileName string) {
			defer wg.Done()
			defer func() { <-sem }()

			// Another worker already failed → stop.
			select {
			case <-errCh:
				return
			default:
			}

			ext := strings.ToLower(filepath.Ext(fileName))
			ct := mime.TypeByExtension(ext)
			if ct == "" {
				switch ext {
				case ".css":
					ct = "text/css"
				case ".js", ".mjs":
					ct = "application/javascript"
				case ".json":
					ct = "application/json"
				case ".html", ".htm":
					ct = "text/html"
				case ".svg":
					ct = "image/svg+xml"
				case ".woff2":
					ct = "font/woff2"
				case ".wasm":
					ct = "application/wasm"
				case ".m4a", ".aac":
					ct = "audio/mp4"
				case ".opus":
					ct = "audio/ogg"
				case ".flac":
					ct = "audio/flac"
				default:
					ct = "application/octet-stream"
				}
			}

			cacheControl := "public, max-age=600, s-maxage=31536000"
			if ext == ".html" || ext == ".htm" || ext == ".json" {
				cacheControl = "public, max-age=0, s-maxage=31536000, must-revalidate"
			}

			rc, err := file.Open()
			if err != nil {
				select {
				case errCh <- fmt.Errorf("open %s: %v", fileName, err):
				default:
				}
				return
			}

			body, err := io.ReadAll(io.LimitReader(rc, sizeLimit))
			rc.Close()
			if err != nil {
				select {
				case errCh <- fmt.Errorf("read %s: %v", fileName, err):
				default:
				}
				return
			}

			_, err = client.PutObject(context.TODO(), &s3.PutObjectInput{
				Bucket:       aws.String(bucket),
				Key:          aws.String(prefix + fileName),
				Body:         bytes.NewReader(body),
				ContentType:  aws.String(ct),
				CacheControl: aws.String(cacheControl),
			})

			if err != nil {
				select {
				case errCh <- fmt.Errorf("upload %s: %v", fileName, err):
				default:
				}
				return
			}

			mu.Lock()
			result.fileKeys = append(result.fileKeys, fileName)
			mu.Unlock()

		}(f, name)
	}

	wg.Wait()

	select {
	case err := <-errCh:
		return nil, err
	default:
		return result, nil
	}
}

// processZipPartToR2 uploads a SUBSET of a game's files — one part of a chunked upload. Unlike
// processZipToR2: does NOT require index.html in this part (finalize checks the assembled prefix);
// does NOT strip a common prefix (client sends paths flat from the game root). Everything else as
// processZipToR2.
func processZipPartToR2(zipData []byte, client *s3.Client, bucket, prefix string, sizeLimit int64) (*uploadResult, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return nil, fmt.Errorf("invalid zip archive")
	}

	result := &uploadResult{}

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := filepath.ToSlash(filepath.Clean(f.Name))
		if name == "" || name == "." {
			continue
		}
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			return nil, fmt.Errorf("invalid path: %s", name)
		}
		ext := strings.ToLower(filepath.Ext(name))
		if !allowedExtensions[ext] {
			return nil, fmt.Errorf("file type not allowed: %s (%s)", ext, name)
		}
		result.fileCount++
		result.totalSize += int64(f.UncompressedSize64)
		if result.totalSize > sizeLimit {
			return nil, fmt.Errorf("part size exceeds %d MB", sizeLimit>>20)
		}
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	sem := make(chan struct{}, 25)
	errCh := make(chan error, 1)

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := filepath.ToSlash(filepath.Clean(f.Name))
		if name == "" || name == "." {
			continue
		}

		wg.Add(1)
		sem <- struct{}{}

		go func(file *zip.File, fileName string) {
			defer wg.Done()
			defer func() { <-sem }()

			select {
			case <-errCh:
				return
			default:
			}

			ext := strings.ToLower(filepath.Ext(fileName))
			ct := mime.TypeByExtension(ext)
			if ct == "" {
				switch ext {
				case ".css":
					ct = "text/css"
				case ".js", ".mjs":
					ct = "application/javascript"
				case ".json":
					ct = "application/json"
				case ".html", ".htm":
					ct = "text/html"
				case ".svg":
					ct = "image/svg+xml"
				case ".woff2":
					ct = "font/woff2"
				case ".wasm":
					ct = "application/wasm"
				case ".m4a", ".aac":
					ct = "audio/mp4"
				case ".opus":
					ct = "audio/ogg"
				case ".flac":
					ct = "audio/flac"
				default:
					ct = "application/octet-stream"
				}
			}

			cacheControl := "public, max-age=600, s-maxage=31536000"
			if ext == ".html" || ext == ".htm" || ext == ".json" {
				cacheControl = "public, max-age=0, s-maxage=31536000, must-revalidate"
			}

			rc, err := file.Open()
			if err != nil {
				select {
				case errCh <- fmt.Errorf("open %s: %v", fileName, err):
				default:
				}
				return
			}

			body, err := io.ReadAll(io.LimitReader(rc, sizeLimit))
			rc.Close()
			if err != nil {
				select {
				case errCh <- fmt.Errorf("read %s: %v", fileName, err):
				default:
				}
				return
			}

			_, err = client.PutObject(context.TODO(), &s3.PutObjectInput{
				Bucket:       aws.String(bucket),
				Key:          aws.String(prefix + fileName),
				Body:         bytes.NewReader(body),
				ContentType:  aws.String(ct),
				CacheControl: aws.String(cacheControl),
			})
			if err != nil {
				select {
				case errCh <- fmt.Errorf("upload %s: %v", fileName, err):
				default:
				}
				return
			}

			mu.Lock()
			result.fileKeys = append(result.fileKeys, fileName)
			mu.Unlock()
		}(f, name)
	}

	wg.Wait()

	select {
	case err := <-errCh:
		return nil, err
	default:
		return result, nil
	}
}

func cleanupR2(client *s3.Client, bucket, prefix string) {
	p := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket),
		Prefix: aws.String(prefix),
	})
	for p.HasMorePages() {
		page, err := p.NextPage(context.TODO())
		if err != nil {
			break
		}
		for _, obj := range page.Contents {
			client.DeleteObject(context.TODO(), &s3.DeleteObjectInput{
				Bucket: aws.String(bucket),
				Key:    obj.Key,
			})
		}
	}
}

func listR2RelativePaths(client *s3.Client, bucket, prefix string) []string {
	var paths []string
	p := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket),
		Prefix: aws.String(prefix),
	})
	for p.HasMorePages() {
		page, err := p.NextPage(context.TODO())
		if err != nil {
			break
		}
		for _, obj := range page.Contents {
			rel := strings.TrimPrefix(*obj.Key, prefix)
			if rel != "" {
				paths = append(paths, rel)
			}
		}
	}
	return paths
}

// r2PrefixStats audits an assembled version prefix: file count, total bytes, index.html at the
// root. Used by chunked finalize before creating the catalog record.
func r2PrefixStats(client *s3.Client, bucket, prefix string) (fileCount int, totalBytes int64, hasIndex bool, paths []string) {
	p := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket),
		Prefix: aws.String(prefix),
	})
	for p.HasMorePages() {
		page, err := p.NextPage(context.TODO())
		if err != nil {
			break
		}
		for _, obj := range page.Contents {
			rel := strings.TrimPrefix(*obj.Key, prefix)
			if rel == "" {
				continue
			}
			fileCount++
			if obj.Size != nil {
				totalBytes += *obj.Size
			}
			if rel == "index.html" {
				hasIndex = true
			}
			paths = append(paths, rel)
		}
	}
	return fileCount, totalBytes, hasIndex, paths
}

// withSaveFlagURLs adds the ?__save=1 twin of every HTML URL. The site never embeds a hosted game
// by its clean URL: the iframe always carries ?__save=1 (src/utils/cheat.ts), and a distinct URL is
// a distinct edge-cache entry. Purging only clean URLs left the iframe stale ("Infinite Travels"
// 2026-09-13, 32 days behind). ?__cheat=1 needs no twin (served no-store). Assets get no twin (only
// HTML receives the shim).
func withSaveFlagURLs(urls []string) []string {
	seen := make(map[string]bool, len(urls)*2)
	out := make([]string, 0, len(urls))
	add := func(u string) {
		if !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	for _, u := range urls {
		add(u)
		if strings.Contains(u, "?") {
			continue
		}
		if strings.HasSuffix(u, "/") || strings.HasSuffix(u, ".html") ||
			strings.HasSuffix(u, ".htm") {
			add(u + "?__save=1")
		}
	}
	return out
}

func purgeCloudflareCache(urls []string) {
	if len(urls) == 0 {
		return
	}
	urls = withSaveFlagURLs(urls)
	zoneID := os.Getenv("CLOUDFLARE_ZONE_ID")
	apiToken := os.Getenv("CLOUDFLARE_API_TOKEN")
	if zoneID == "" || apiToken == "" {
		fmt.Println("[hosting] CF purge skipped: env vars not set")
		return
	}

	for i := 0; i < len(urls); i += 30 {
		end := i + 30
		if end > len(urls) {
			end = len(urls)
		}
		body, _ := json.Marshal(map[string]interface{}{"files": urls[i:end]})

		req, err := http.NewRequest("POST",
			fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/purge_cache", zoneID),
			bytes.NewReader(body))
		if err != nil {
			continue
		}
		req.Header.Set("Authorization", "Bearer "+apiToken)
		req.Header.Set("Content-Type", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			continue
		}
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			fmt.Printf("[hosting] CF purge batch returned status %d\n", resp.StatusCode)
		}
	}
	fmt.Printf("[hosting] Purged %d URLs from CF cache\n", len(urls))
}

func buildPurgeURLs(hostingSlug, gameSlug string, filePaths []string) []string {
	seen := make(map[string]bool)
	var urls []string
	add := func(u string) {
		if !seen[u] {
			seen[u] = true
			urls = append(urls, u)
		}
	}

	var baseURL string
	if gameSlug == "_home" {
		baseURL = fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain)
	} else {
		baseURL = fmt.Sprintf("https://%s.%s/%s/", hostingSlug, baseDomain, gameSlug)
	}

	add(baseURL)
	add(baseURL + "index.html")
	for _, fp := range filePaths {
		add(baseURL + fp)
	}
	add(fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain))
	return urls
}

func purgeGameURLs(s3Client *s3.Client, bucket, hostingSlug, gameSlug string, version int, extraPaths []string) {
	go func() {
		var allPaths []string
		if version > 0 {
			prefix := r2VersionPrefix(hostingSlug, gameSlug, version)
			allPaths = append(allPaths, listR2RelativePaths(s3Client, bucket, prefix)...)
		}
		allPaths = append(allPaths, extraPaths...)
		urls := buildPurgeURLs(hostingSlug, gameSlug, allPaths)
		purgeCloudflareCache(urls)
	}()
}

func formatBytes(b int64) string {
	if b < 1024 {
		return fmt.Sprintf("%d B", b)
	}
	if b < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(b)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(b)/(1024*1024))
}

// isMod gates moderator hosting handlers (block/restore/reupload). Physical R2 deletion needs a
// separate permission, see permHostingPurge.
func isMod(info *core.RequestInfo) bool {
	return info != nil && authHasPerm(info.Auth, permHosting)
}

func makeGameURL(hostingSlug, gameSlug string) string {
	if os.Getenv("NODE_ENV") == "development" {
		if gameSlug == "_home" {
			return fmt.Sprintf("http://localhost:8090/?_host=%s.%s", hostingSlug, baseDomain)
		}
		return fmt.Sprintf("http://localhost:8090/%s/?_host=%s.%s", gameSlug, hostingSlug, baseDomain)
	}
	if gameSlug == "_home" {
		return fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain)
	}
	return fmt.Sprintf("https://%s.%s/%s/", hostingSlug, baseDomain, gameSlug)
}

func makeHomeURL(hostingSlug string) string {
	if os.Getenv("NODE_ENV") == "development" {
		return fmt.Sprintf("http://localhost:8090/?_host=%s.%s", hostingSlug, baseDomain)
	}
	return fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain)
}

func getUserGameLimit(user *core.Record) int {
	if custom := user.GetInt("hosting_max_games"); custom > 0 {
		return custom
	}
	return defaultMaxGames
}

func getUserMaxZipSize(user *core.Record) int64 {
	if custom := user.GetInt("hosting_max_upload_mb"); custom > 0 {
		return int64(custom) << 20
	}
	return maxZipSize
}

func checkDailyUploadLimit(user *core.Record, estimatedBytes int64) error {
	today := time.Now().UTC().Format("2006-01-02")
	current := int64(0)
	if user.GetString("hosting_daily_reset") == today {
		current = int64(user.GetInt("hosting_daily_uploaded"))
	}
	if current+estimatedBytes > defaultDailyUploadBytes {
		remaining := defaultDailyUploadBytes - current
		if remaining < 0 {
			remaining = 0
		}
		return fmt.Errorf("daily upload limit reached (%d MB/day, %s remaining) — try again tomorrow",
			defaultDailyUploadBytes>>20, formatBytes(remaining))
	}
	return nil
}

func trackDailyUpload(app *pocketbase.PocketBase, user *core.Record, uploadedBytes int64) {
	today := time.Now().UTC().Format("2006-01-02")
	if user.GetString("hosting_daily_reset") != today {
		user.Set("hosting_daily_uploaded", uploadedBytes)
	} else {
		current := int64(user.GetInt("hosting_daily_uploaded"))
		user.Set("hosting_daily_uploaded", current+uploadedBytes)
	}
	user.Set("hosting_daily_reset", today)
	if err := app.Save(user); err != nil {
		fmt.Printf("[hosting] warning: failed to track daily upload: %v\n", err)
	}
}

func generateRandomPassword() string {
	b := make([]byte, 24)
	crand.Read(b)
	return hex.EncodeToString(b)
}

type claimInfo struct {
	Token   string
	Expires time.Time
}

var claimTokens sync.Map

func generateSecureToken() string {
	b := make([]byte, 16)
	crand.Read(b)
	return hex.EncodeToString(b)
}

var claimRateLimiter sync.Map

func checkClaimRateLimit(r *http.Request) bool {
	ip := r.Header.Get("CF-Connecting-IP")
	if ip == "" {
		ip = r.Header.Get("X-Forwarded-For")
		if idx := strings.Index(ip, ","); idx != -1 {
			ip = strings.TrimSpace(ip[:idx])
		}
	}
	if ip == "" {
		ip = r.RemoteAddr
	}

	now := time.Now()
	if val, ok := claimRateLimiter.Load(ip); ok {
		lastTime := val.(time.Time)
		if now.Sub(lastTime) < 30*time.Second {
			return false
		}
	}
	claimRateLimiter.Store(ip, now)
	return true
}

func serveFromR2(
	app *pocketbase.PocketBase,
	s3Client *s3.Client,
	bucket string,
	e *core.RequestEvent,
	hostingSlug, gameSlug, filePath string,
	extraInject ...[]byte,
) error {
	filePath = filepath.ToSlash(filepath.Clean(filePath))
	if strings.Contains(filePath, "..") || strings.HasPrefix(filePath, "/") {
		return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid path"})
	}

	cacheKey := hostingSlug + "/" + gameSlug
	exists, version, cached := lookupCache.get(cacheKey)
	if !cached {
		owner, err := app.FindFirstRecordByFilter("users",
			"hosting_slug = {:slug}",
			dbx.Params{"slug": hostingSlug})
		if err != nil || owner == nil {
			lookupCache.set(cacheKey, false, 0)
			return e.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
		}
		rec, err := app.FindFirstRecordByFilter("hosted_games",
			"owner = {:owner} && slug = {:slug} && status = 'active'",
			dbx.Params{"owner": owner.Id, "slug": gameSlug})
		exists = (err == nil && rec != nil)
		if exists {
			version = rec.GetInt("version")
			if version <= 0 {
				version = 1
			}
		}
		lookupCache.set(cacheKey, exists, version)
	}
	if !exists {
		return e.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
	}

	r2Key := r2VersionPrefix(hostingSlug, gameSlug, version) + filePath

	obj, err := s3Client.GetObject(context.TODO(), &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(r2Key),
	})
	if err != nil {
		fmt.Printf("[hosting] 404 ERROR - R2 file not found: %s\n", r2Key)
		return e.String(http.StatusNotFound, "404 - File Not Found")
	}
	defer obj.Body.Close()

	ct := "application/octet-stream"
	if obj.ContentType != nil {
		ct = *obj.ContentType
	}

	// Badly-scraped archives: if the browser explicitly asks for a script/style, serve that type even
	// if the file is misnamed index.html.
	dest := e.Request.Header.Get("Sec-Fetch-Dest")
	if dest == "script" {
		ct = "application/javascript"
	} else if dest == "style" {
		ct = "text/css"
	}

	e.Response.Header().Set("Content-Type", ct)

	// No `immutable`: hosted URLs don't contain content hashes.
	if strings.HasSuffix(filePath, ".html") || strings.HasSuffix(filePath, ".htm") || strings.HasSuffix(filePath, ".json") {
		e.Response.Header().Set("Cache-Control", "public, max-age=0, s-maxage=31536000, must-revalidate")
	} else {
		e.Response.Header().Set("Cache-Control", "public, max-age=600, s-maxage=31536000")
	}

	e.Response.Header().Set("X-Content-Type-Options", "nosniff")
	e.Response.Header().Set("Content-Security-Policy",
		fmt.Sprintf(
			// http:/https: allowed so games can load external images, styles and scripts.
			"default-src 'self' https: http: 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors https://%s",
			baseDomain,
		))

	if obj.ContentLength != nil && *obj.ContentLength > 0 {
		e.Response.Header().Set("Content-Length", fmt.Sprintf("%d", *obj.ContentLength))
	}

	// Companion shim injection, only for index.html requested with a flag. ?__save=1 = saver mode (the
	// site adds it to every hosted-game iframe); keeps normal cache headers — distinct URL = distinct
	// edge-cache entry, so direct visits (no flag) stay byte-for-byte untouched and cached. ?__cheat=1
	// = full cheat mode from load; no-store. The shim reads the flag from location.search to pick its
	// mode.
	isHTMLFile := strings.HasSuffix(filePath, ".html") || strings.HasSuffix(filePath, ".htm")
	cheatInject := e.Request.URL.Query().Get("__cheat") == "1" && isHTMLFile
	saveInject := e.Request.URL.Query().Get("__save") == "1" && isHTMLFile
	bannerInject := isHTMLFile && len(extraInject) > 0 && len(extraInject[0]) > 0
	// Inject only when size is known and within the cap. Unknown size → don't: better serve without
	// shim than read unbounded data into memory.
	if cheatInject || saveInject || bannerInject {
		if obj.ContentLength == nil || *obj.ContentLength > maxInjectSize {
			size := int64(-1)
			if obj.ContentLength != nil {
				size = *obj.ContentLength
			}
			fmt.Printf("[hosting] inject skipped for %s: size %d, cap %d\n", r2Key, size, int64(maxInjectSize))
			cheatInject, saveInject, bannerInject = false, false, false
		}
	}
	if cheatInject || saveInject || bannerInject {
		// LimitReader in case ContentLength lied: read one byte past the cap to tell "exactly cap" from
		// "more".
		body, rerr := io.ReadAll(io.LimitReader(obj.Body, maxInjectSize+1))
		if rerr != nil {
			fmt.Printf("[hosting] inject read error for %s: %v\n", r2Key, rerr)
			return e.String(http.StatusInternalServerError, "read error")
		}
		if len(body) > maxInjectSize {
			// Truncated html can't be served and there's nothing left to stream — body consumed.
			fmt.Printf("[hosting] inject abort for %s: ContentLength lied, >%d\n", r2Key, int64(maxInjectSize))
			return e.String(http.StatusInternalServerError, "file too large")
		}
		if cheatInject || saveInject {
			tag := []byte(`<script src="/` + cheatShimPath + `" data-cyoa-cheat></script>`)
			body = injectBeforeClose(body, tag)
		}
		if bannerInject {
			body = injectBeforeClose(body, extraInject[0])
		}
		e.Response.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
		if cheatInject || bannerInject {
			// Reserved banner depends on is_reserved — keep CDN from caching it long, or the bannered
			// version sticks at the edge after a claim.
			e.Response.Header().Set("Cache-Control", "no-store")
		}
		e.Response.WriteHeader(http.StatusOK)
		_, _ = e.Response.Write(body)
		return nil
	}

	e.Response.WriteHeader(http.StatusOK)
	if _, err := io.Copy(e.Response, obj.Body); err != nil {
		fmt.Printf("[hosting] stream error for %s: %v\n", r2Key, err)
	}
	return nil
}

// claimBannerHTML: compact self-contained floating banner injected into a reserved account's
// archived home page, linking to the clean claim page /reserved (full wizard: buildClaimBlockHTML).
// All styles inline and specific to survive arbitrary archived-site CSS.
func claimBannerHTML() string {
	return `<div id="cyoa-claim-banner" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;` +
		`background:#1e1e1e;border-top:2px solid #fc3447;color:#dcdcdc;` +
		`font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
		`font-size:14px;line-height:1.4;padding:10px 14px;display:flex;align-items:center;` +
		`justify-content:center;flex-wrap:wrap;gap:8px 14px;box-shadow:0 -4px 16px rgba(0,0,0,.5);">` +
		`<span style="color:#dcdcdc;">📌 This page is <b style="color:#fc3447;">reserved</b> for its author.</span>` +
		`<a href="/reserved" style="background:#fc3447;color:#fff;text-decoration:none;padding:6px 14px;` +
		`border-radius:4px;font-weight:700;white-space:nowrap;">Are you the author? Claim it →</a>` +
		`<span onclick="document.getElementById('cyoa-claim-banner').remove()" ` +
		`style="cursor:pointer;color:#888;font-size:20px;line-height:1;padding:0 4px;" title="Dismiss">&times;</span>` +
		`</div>`
}

func buildClaimBlockHTML(hostingSlug string) string {
	turnstileSiteKey := os.Getenv("TURNSTILE_SITE_KEY")

	turnstileScript := ""
	turnstileWidget := ""
	btnDisabled := ""

	if turnstileSiteKey != "" {
		turnstileScript = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
		turnstileWidget = fmt.Sprintf(`<div class="cf-turnstile" data-sitekey="%s" data-callback="onTurnstileDone" style="margin-top:12px;"></div>`, turnstileSiteKey)
		btnDisabled = "disabled"
	}

	return fmt.Sprintf(`%s
<div class="claim-box" id="claim-ui">
	<div class="claim-header" onclick="toggleClaim()">
		<b style="color:#fc3447;">Are you the author?</b>
		<span class="claim-arrow" id="claim-arrow">▸</span>
	</div>
	<div class="claim-body" id="claim-body" style="display:none;">
		<p class="claim-sub">
			Your Neocities games have been archived here to reserve this page for you.<br>
			Prove account ownership to claim it, manage your games, and upload new ones.
		</p>

		<div id="step-1">
			<div class="claim-step">
				<b>Step 1: Generate Auth File</b>
				<p>Generate a unique text file that you will need to upload to the root folder of your Neocities site.</p>
				%s
				<button id="btn-gen" %s onclick="generateToken()">Generate File</button>
				<div id="err-gen" class="error"></div>
			</div>
		</div>

		<div id="step-2" class="hidden">
			<div class="claim-step">
				<b>Step 2: Upload &amp; Verify</b>
				<p>1. Create a file on Neocities named exactly:</p>
				<div class="code-block" id="file-name">cyoa-auth-xxx.txt</div>
				<p style="margin-top:12px;">2. Put this exact text inside the file:</p>
				<div class="code-block" id="file-content">xxx</div>

				<div style="margin-top:24px;border-top:1px solid #333;padding-top:20px;">
					<b>Step 3: Setup your CYOA.CAFE account</b>
					<input type="email" id="claim-email" placeholder="New Email Address" required>
					<input type="password" id="claim-password" placeholder="New Password (min 8 characters)" required>
					<button id="btn-verify" onclick="verifyToken()">Verify &amp; Claim Account</button>
					<div id="err-verify" class="error"></div>
					<div id="ok-verify" class="success"></div>
				</div>
			</div>
		</div>

		<div class="claim-manual">
			Lost access to your Neocities account?<br>
			Message <b>Dragon&#39;s Whore</b> in the <a href="https://`+baseDomain+`/chat" target="_blank">site chat</a> to claim manually.
		</div>
	</div>
</div>

<script>
let turnstileToken = "dummy";
function onTurnstileDone(token) {
	turnstileToken = token;
	document.getElementById("btn-gen").disabled = false;
}
function toggleClaim() {
	const body = document.getElementById("claim-body");
	const arrow = document.getElementById("claim-arrow");
	if (body.style.display === "none") {
		body.style.display = "block";
		arrow.textContent = "▾";
	} else {
		body.style.display = "none";
		arrow.textContent = "▸";
	}
}
async function generateToken() {
	const btn = document.getElementById("btn-gen");
	btn.disabled = true;
	btn.innerText = "GENERATING...";
	try {
		const res = await fetch('/api/hosting/claim/generate', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({ slug: "%s", turnstile: turnstileToken })
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Failed to generate");
		document.getElementById("file-name").innerText = data.filename;
		document.getElementById("file-content").innerText = data.content;
		document.getElementById("step-1").classList.add("hidden");
		document.getElementById("step-2").classList.remove("hidden");
	} catch(e) {
		document.getElementById("err-gen").innerText = e.message;
		btn.disabled = false;
		btn.innerText = "GENERATE FILE";
	}
}
async function verifyToken() {
	const email = document.getElementById("claim-email").value;
	const password = document.getElementById("claim-password").value;
	const btn = document.getElementById("btn-verify");
	if(!email || password.length < 8) {
		document.getElementById("err-verify").innerText = "Valid email and password (min 8) required.";
		return;
	}
	btn.disabled = true;
	btn.innerText = "CHECKING NEOCITIES...";
	document.getElementById("err-verify").innerText = "";
	try {
		const res = await fetch('/api/hosting/claim/verify', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({ slug: "%s", email, password })
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Verification failed");
		document.getElementById("ok-verify").innerText = "Success! Account claimed. You can now log in. Redirecting...";
		setTimeout(() => { window.location.href = "https://%s.%s/"; }, 3000);
	} catch(e) {
		document.getElementById("err-verify").innerText = e.message;
		btn.disabled = false;
		btn.innerText = "VERIFY & CLAIM ACCOUNT";
	}
}
</script>`,
		turnstileScript,
		turnstileWidget,
		btnDisabled,
		hostingSlug,
		hostingSlug,
		hostingSlug,
		baseDomain,
	)
}

func claimCSS() string {
	return `
.reserved-chip{
	display:inline-block;position:relative;
	background:rgba(252,52,71,0.1);color:#fc3447;
	border:1px solid rgba(252,52,71,0.3);
	padding:3px 10px;border-radius:4px;
	font-size:.7em;font-weight:bold;text-transform:uppercase;
	cursor:default;margin-bottom:12px;
}
.reserved-chip .chip-tooltip{
	display:none;position:absolute;left:50%;top:calc(100% + 8px);
	transform:translateX(-50%);
	background:#1e1e1e;border:1px solid #444;border-radius:4px;
	padding:10px 14px;white-space:nowrap;
	font-size:11px;font-weight:normal;text-transform:none;
	color:#aaa;z-index:10;box-shadow:0 4px 12px rgba(0,0,0,0.6);
}
.reserved-chip .chip-tooltip a{color:#fc3447;text-decoration:none;}
.reserved-chip:hover .chip-tooltip{display:block;}
.claim-box{
	background:#1e1e1e;border:1px solid rgba(252,52,71,0.3);border-radius:4px;
	margin-bottom:20px;overflow:hidden;
}
.claim-header{
	display:flex;justify-content:space-between;align-items:center;
	padding:14px 18px;cursor:pointer;user-select:none;
}
.claim-header:hover{background:#252525;}
.claim-arrow{color:#888;font-size:1.1em;transition:transform 0.2s;}
.claim-body{padding:0 18px 18px 18px;}
.claim-sub{color:#aaa;font-size:.88em;line-height:1.5;margin-bottom:16px;}
.claim-sub a{color:#fc3447;text-decoration:none;}
.claim-sub a:hover{text-decoration:underline;}
.claim-step{background:#151515;border:1px solid #2a2a2a;border-radius:4px;padding:16px;margin-bottom:12px;}
.claim-step b{color:#dcdcdc;display:block;margin-bottom:6px;font-size:.95em;}
.claim-step p{color:#888;font-size:.85em;line-height:1.5;}
.code-block{background:#0a0a0a;padding:10px;border:1px solid #333;border-radius:4px;font-family:monospace;color:#aaa;word-break:break-all;margin-top:6px;font-size:.85em;}
.claim-box input{width:100%;padding:10px;margin-top:10px;background:#101010;border:1px solid #333;color:#fff;border-radius:4px;font-family:inherit;transition:border-color 0.2s;font-size:.9em;}
.claim-box input:focus{outline:none;border-color:#fc3447;}
.claim-box button{background:#fc3447;color:#fff;border:none;padding:10px 14px;border-radius:4px;cursor:pointer;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;width:100%;margin-top:12px;transition:background 0.2s;font-size:.85em;}
.claim-box button:hover:not(:disabled){background:#e02f40;}
.claim-box button:disabled{background:#333;color:#777;cursor:not-allowed;}
.claim-manual{margin-top:16px;text-align:center;font-size:.82em;color:#666;border-top:1px solid #333;padding-top:14px;line-height:1.5;}
.claim-manual a{color:#fc3447;text-decoration:none;}
.claim-manual a:hover{text-decoration:underline;}
.hidden{display:none;}
.error{color:#f44336;font-size:0.85em;margin-top:8px;}
.success{color:#4caf50;font-size:0.85em;margin-top:8px;}
`
}

func handleLanding(
	app *pocketbase.PocketBase,
	s3Client *s3.Client,
	bucket string,
	e *core.RequestEvent,
	hostingSlug string,
) error {
	owner, err := app.FindFirstRecordByFilter("users",
		"hosting_slug = {:slug}",
		dbx.Params{"slug": hostingSlug})
	if err != nil || owner == nil {
		e.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
		e.Response.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(e.Response,
			`<h1>Not Found</h1><p><a href="https://%s">← CYOA Cafe</a></p>`, baseDomain)
		return nil
	}

	isReserved := owner.GetBool("is_reserved")

	hp, _ := app.FindFirstRecordByFilter("hosted_games",
		"owner = {:owner} && slug = '_home' && status = 'active'",
		dbx.Params{"owner": owner.Id})
	if hp != nil {
		// Reserved account: the archived home page is served as-is, plus an unobtrusive banner, otherwise
		// the author never learns the page can be claimed.
		if isReserved {
			return serveFromR2(app, s3Client, bucket, e, hostingSlug, "_home", "index.html",
				[]byte(claimBannerHTML()))
		}
		return serveFromR2(app, s3Client, bucket, e, hostingSlug, "_home", "index.html")
	}

	games, _ := app.FindRecordsByFilter("hosted_games",
		"owner = {:owner} && status = 'active' && slug != '_home'",
		"-created", 100, 0,
		dbx.Params{"owner": owner.Id})

	name := owner.GetString("name")
	if name == "" || strings.Contains(name, "[RESERVED]") {
		name = owner.GetString("username")
	}

	safeName := html.EscapeString(name)

	reservedChipHTML := ""
	if isReserved {
		neocitiesURL := fmt.Sprintf("https://%s.neocities.org", hostingSlug)
		reservedChipHTML = fmt.Sprintf(`<div class="reserved-chip">
	Reserved
	<div class="chip-tooltip">
		Reserved for the author of<br><a href="%s" target="_blank" rel="noopener">%s</a>
	</div>
</div>`, neocitiesURL, neocitiesURL)
	}

	claimBlockHTML := ""
	if isReserved {
		claimBlockHTML = buildClaimBlockHTML(hostingSlug)
	}

	var list strings.Builder
	for _, g := range games {
		list.WriteString(fmt.Sprintf(
			`<a href="/%s/" class="g"><b>%s</b><span>%s · %d files · v%d</span></a>`,
			html.EscapeString(g.GetString("slug")),
			html.EscapeString(g.GetString("title")),
			formatBytes(int64(g.GetInt("size_bytes"))),
			g.GetInt("file_count"),
			g.GetInt("version"),
		))
	}
	if len(games) == 0 && !isReserved {
		list.WriteString(`<p class="empty">No games published yet.</p>`)
	}
	if len(games) == 0 && isReserved {
		list.WriteString(`<p class="empty">No games archived yet.</p>`)
	}

	pageHTML := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en" style="color-scheme:dark;background:#101010"><head>
<meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Games by %s — CYOA Cafe</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
	font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
	background-color:#101010;
	background-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='noise' x='0' y='0'><feTurbulence type='turbulence' baseFrequency='0.322' numOctaves='3' stitchTiles='stitch'/><feBlend mode='darken'/></filter><rect width='100%%' height='100%%' filter='url(%%23noise)' opacity='0.07'/></svg>");
	color:#dcdcdc;
	min-height:100vh;
	overflow-y:scroll;
	display:flex;flex-direction:column;align-items:center;padding:40px 20px;
}
.hd{text-align:center;margin-bottom:32px;width:550px;max-width:100%%;}
.hd h1{font-size:1.8em;font-weight:700;color:#dcdcdc;margin:0 0 8px 0;}
.wrap{width:550px;max-width:100%%;}
.g{
	display:block;padding:16px 20px;margin-bottom:12px;
	background:#1e1e1e;border:1px solid #333;border-radius:4px;
	text-decoration:none;color:inherit;transition:background 0.2s, border-color 0.2s;
}
.g:hover{background:#252525;border-color:#555;}
.g b{display:block;color:#fff;font-size:1.05em;margin-bottom:4px;}
.g span{font-size:.85em;color:#888;display:block}
.empty{text-align:center;color:#666;padding:40px}
.ft{margin-top:60px;color:#555;font-size:.8em}
.ft a{color:#fc3447;text-decoration:none}
.ft a:hover{text-decoration:underline}
%s
</style></head><body>
<div class="hd">
	<h1>Games by %s</h1>
	%s
</div>
<div class="wrap">%s%s</div>
<div class="ft"><a href="https://%s">Return to CYOA.CAFE</a></div>
</body></html>`,
		safeName,
		claimCSS(),
		safeName,
		reservedChipHTML,
		claimBlockHTML,
		list.String(),
		baseDomain,
	)

	e.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
	if isReserved {
		e.Response.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	} else {
		e.Response.Header().Set("Cache-Control", "public, max-age=300")
	}
	e.Response.WriteHeader(http.StatusOK)
	e.Response.Write([]byte(pageHTML))
	return nil
}

func handleReservedLanding(e *core.RequestEvent, hostingSlug string) error {
	claimBlockHTML := buildClaimBlockHTML(hostingSlug)
	neocitiesURL := fmt.Sprintf("https://%s.neocities.org", hostingSlug)

	pageHTML := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en" style="color-scheme:dark;background:#101010"><head>
<meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s — CYOA.CAFE</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
	font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
	background-color:#101010;
	background-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='noise' x='0' y='0'><feTurbulence type='turbulence' baseFrequency='0.322' numOctaves='3' stitchTiles='stitch'/><feBlend mode='darken'/></filter><rect width='100%%' height='100%%' filter='url(%%23noise)' opacity='0.07'/></svg>");
	color:#dcdcdc;
	min-height:100vh;
	overflow-y:scroll;
	display:flex;flex-direction:column;align-items:center;padding:40px 20px;
}
.hd{text-align:center;margin-bottom:24px;width:550px;max-width:100%%;}
.hd h1{font-size:1.8em;margin-bottom:8px;color:#fff;font-weight:700;}
.hd .sub{color:#888;font-size:.9em;line-height:1.5;margin-top:12px;}
.wrap{width:550px;max-width:100%%;margin-top:12px;}
.ft{margin-top:40px;color:#555;font-size:.8em}
.ft a{color:#fc3447;text-decoration:none}
.ft a:hover{text-decoration:underline}
%s
</style></head><body>

<div class="hd">
	<h1>%s</h1>
	<div class="reserved-chip">
		Reserved
		<div class="chip-tooltip">
			Reserved for the author of<br><a href="%s" target="_blank" rel="noopener">%s</a>
		</div>
	</div>
	<div class="sub">
		Your Neocities games have been archived here to reserve this page for you.<br>
		Prove account ownership to claim it, manage your games, and upload new ones.
	</div>
</div>

<div class="wrap">%s</div>

<div class="ft"><a href="https://%s">Return to CYOA.CAFE</a></div>
</body></html>`,
		html.EscapeString(hostingSlug),
		claimCSS(),
		html.EscapeString(hostingSlug),
		neocitiesURL, neocitiesURL,
		claimBlockHTML,
		baseDomain,
	)

	e.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
	e.Response.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	e.Response.WriteHeader(http.StatusOK)
	e.Response.Write([]byte(pageHTML))
	return nil
}

func registerHostingRoutes(app *pocketbase.PocketBase) {
	s3Client := newR2Client()
	bucket := os.Getenv("R2_BUCKET_NAME")

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		if s3Client == nil {
			fmt.Println("[hosting] R2 not configured, all hosting routes disabled")
			return se.Next()
		}
		fmt.Println("[hosting] Registering routes...")

		go func() {
			ticker := time.NewTicker(10 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				lookupCache.cleanup()

				now := time.Now()
				claimTokens.Range(func(key, value any) bool {
					if info, ok := value.(claimInfo); ok && now.After(info.Expires) {
						claimTokens.Delete(key)
					}
					return true
				})
				claimRateLimiter.Range(func(key, value any) bool {
					if t, ok := value.(time.Time); ok && now.Sub(t) > 5*time.Minute {
						claimRateLimiter.Delete(key)
					}
					return true
				})
			}
		}()

		se.Router.BindFunc(func(e *core.RequestEvent) error {
			host := e.Request.Host
			if os.Getenv("NODE_ENV") == "development" {
				if th := e.Request.URL.Query().Get("_host"); th != "" {
					host = th
				}
			}
			sub := extractSubdomain(host)
			if sub == "" {
				return e.Next()
			}

			if strings.HasPrefix(e.Request.URL.Path, "/api/") || strings.HasPrefix(e.Request.URL.Path, "/_/") {
				return e.Next()
			}

			path := strings.TrimPrefix(e.Request.URL.Path, "/")

			if path == cheatShimPath {
				e.Response.Header().Set("Content-Type", "application/javascript; charset=utf-8")
				e.Response.Header().Set("Cache-Control", "public, max-age=300")
				e.Response.WriteHeader(http.StatusOK)
				_, _ = e.Response.Write([]byte(cheatShimJS))
				return nil
			}

			if path == "itsme" || path == "itsme/" || path == "reserved" || path == "reserved/" {
				owner, err := app.FindFirstRecordByFilter("users",
					"hosting_slug = {:slug}",
					dbx.Params{"slug": sub})
				if err == nil && owner != nil && owner.GetBool("is_reserved") {
					return handleReservedLanding(e, sub)
				}
				return e.Redirect(http.StatusFound, "/")
			}
			if path == "" {
				return handleLanding(app, s3Client, bucket, e, sub)
			}

			parts := strings.SplitN(path, "/", 2)
			potentialGameSlug := parts[0]

			isGame := false
			cacheKey := sub + "/" + potentialGameSlug
			exists, _, cached := lookupCache.get(cacheKey)

			if cached {
				isGame = exists
			} else {
				owner, err := app.FindFirstRecordByFilter("users",
					"hosting_slug = {:slug}",
					dbx.Params{"slug": sub})
				if err == nil && owner != nil {
					rec, _ := app.FindFirstRecordByFilter("hosted_games",
						"owner = {:owner} && slug = {:slug} && status = 'active'",
						dbx.Params{"owner": owner.Id, "slug": potentialGameSlug})
					if rec != nil {
						isGame = true
						v := rec.GetInt("version")
						if v <= 0 {
							v = 1
						}
						lookupCache.set(cacheKey, true, v)
					} else {
						lookupCache.set(cacheKey, false, 0)
					}
				}
			}

			if isGame {
				filePath := ""
				if len(parts) > 1 {
					filePath = parts[1]
				}
				if filePath == "" && !strings.Contains(potentialGameSlug, ".") && !strings.HasSuffix(e.Request.URL.Path, "/") {
					return e.Redirect(http.StatusMovedPermanently, "/"+potentialGameSlug+"/")
				}
				if filePath == "" {
					filePath = "index.html"
				}
				return serveFromR2(app, s3Client, bucket, e, sub, potentialGameSlug, filePath)
			}

			return serveFromR2(app, s3Client, bucket, e, sub, "_home", path)
		})

		se.Router.POST("/api/hosting/claim/generate", func(e *core.RequestEvent) error {
			if !checkClaimRateLimit(e.Request) {
				return e.JSON(http.StatusTooManyRequests, map[string]string{"error": "Too many requests. Please wait 30 seconds."})
			}

			var body struct {
				Slug      string `json:"slug"`
				Turnstile string `json:"turnstile"`
			}

			if err := e.BindBody(&body); err != nil {
				fmt.Printf("[hosting] Error binding body: %v\n", err)
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request"})
			}

			if !isValidSlug(body.Slug) {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid slug"})
			}

			fmt.Printf("[hosting] Received Turnstile token. Length: %d\n", len(body.Turnstile))

			if os.Getenv("TURNSTILE_SECRET_KEY") != "" {
				ok, err := verifyTurnstile(body.Turnstile)
				if err != nil {
					fmt.Printf("[hosting] Turnstile request error: %v\n", err)
					return e.JSON(http.StatusForbidden, map[string]string{"error": "Captcha API error."})
				}
				if !ok {
					fmt.Printf("[hosting] Turnstile REJECTED the token. Check TURNSTILE_SECRET_KEY in .env!\n")
					return e.JSON(http.StatusForbidden, map[string]string{"error": "Captcha rejected. Incorrect Secret Key or expired token."})
				}
			}

			user, err := app.FindFirstRecordByFilter("users",
				"hosting_slug = {:slug} && is_reserved = true",
				dbx.Params{"slug": body.Slug})
			if err != nil || user == nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "Reserved account not found or already claimed"})
			}

			token := generateSecureToken()
			claimTokens.Store(body.Slug, claimInfo{
				Token:   token,
				Expires: time.Now().Add(1 * time.Hour),
			})

			return e.JSON(http.StatusOK, map[string]string{
				"filename": fmt.Sprintf("cyoa-auth-%s.txt", body.Slug),
				"content":  token,
			})
		})

		se.Router.POST("/api/hosting/claim/verify", func(e *core.RequestEvent) error {
			var body struct {
				Slug     string `json:"slug"`
				Email    string `json:"email"`
				Password string `json:"password"`
			}
			if err := json.NewDecoder(e.Request.Body).Decode(&body); err != nil {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request"})
			}

			if !isValidSlug(body.Slug) {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid slug"})
			}

			if len(body.Password) < 8 {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "password must be at least 8 characters"})
			}

			val, ok := claimTokens.Load(body.Slug)
			if !ok {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "No active claim session. Generate file again."})
			}
			info := val.(claimInfo)

			if time.Now().After(info.Expires) {
				claimTokens.Delete(body.Slug)
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "Claim session expired. Generate file again."})
			}

			targetURL := fmt.Sprintf("https://%s.neocities.org/cyoa-auth-%s.txt", body.Slug, body.Slug)

			client := &http.Client{Timeout: 10 * time.Second}
			resp, err := client.Get(targetURL)
			if err != nil || resp.StatusCode != http.StatusOK {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "Could not find the auth file on Neocities. Check filename and location."})
			}
			defer resp.Body.Close()

			fileContent, err := io.ReadAll(io.LimitReader(resp.Body, 1024))
			if err != nil || strings.TrimSpace(string(fileContent)) != info.Token {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "File content does not match the generated token."})
			}

			user, err := app.FindFirstRecordByFilter("users",
				"hosting_slug = {:slug} && is_reserved = true",
				dbx.Params{"slug": body.Slug})
			if err != nil || user == nil {
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": "Account error."})
			}

			existingEmail, _ := app.FindFirstRecordByFilter("users",
				"email = {:email}",
				dbx.Params{"email": body.Email})
			if existingEmail != nil {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "This email is already registered to another account."})
			}

			user.Set("email", body.Email)
			user.SetPassword(body.Password)
			user.Set("is_reserved", false)

			if err := app.Save(user); err != nil {
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": "Failed to update user profile."})
			}

			claimTokens.Delete(body.Slug)

			return e.JSON(http.StatusOK, map[string]string{"message": "Success"})
		})

		se.Router.POST("/api/hosting/upload", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if info.Auth == nil {
				return e.JSON(http.StatusUnauthorized, map[string]string{"error": "login required"})
			}
			userID := info.Auth.Id
			gameLimit := getUserGameLimit(info.Auth)
			userMaxZip := getUserMaxZipSize(info.Auth)
			hostingSlug, err := ensureHostingSlug(app, info.Auth)
			if err != nil {
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to generate hosting slug"})
			}

			existing, _ := app.FindRecordsByFilter("hosted_games",
				"owner = {:owner} && status = 'active'",
				"", 0, 0,
				dbx.Params{"owner": userID})
			if len(existing) >= gameLimit {
				return e.JSON(http.StatusTooManyRequests, map[string]string{
					"error": fmt.Sprintf("max %d active games per account", gameLimit),
				})
			}
			slug := strings.ToLower(strings.TrimSpace(e.Request.FormValue("slug")))
			title := strings.TrimSpace(e.Request.FormValue("title"))
			if title == "" {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "title required"})
			}
			if !isValidSlug(slug) {
				return e.JSON(http.StatusBadRequest, map[string]string{
					"error": "slug: 3-60 chars, a-z 0-9 hyphens, no leading/trailing hyphens",
				})
			}
			dup, _ := app.FindFirstRecordByFilter("hosted_games",
				"owner = {:owner} && slug = {:slug}",
				dbx.Params{"owner": userID, "slug": slug})
			if dup != nil {
				return e.JSON(http.StatusConflict, map[string]string{"error": "you already have a game with this slug"})
			}
			file, header, err := e.Request.FormFile("archive")
			if err != nil {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "missing 'archive' file"})
			}
			defer file.Close()
			if header.Size > userMaxZip {
				return e.JSON(http.StatusRequestEntityTooLarge, map[string]string{
					"error": fmt.Sprintf("zip too large, max %d MB", userMaxZip>>20),
				})
			}

			if err := checkDailyUploadLimit(info.Auth, header.Size); err != nil {
				return e.JSON(http.StatusTooManyRequests, map[string]string{"error": err.Error()})
			}

			zipData, err := io.ReadAll(io.LimitReader(file, userMaxZip+1))
			if err != nil || int64(len(zipData)) > userMaxZip {
				return e.JSON(http.StatusRequestEntityTooLarge, map[string]string{"error": "zip too large"})
			}
			prefix := r2VersionPrefix(hostingSlug, slug, 1)
			result, err := processZipToR2(zipData, s3Client, bucket, prefix, userMaxZip)
			if err != nil {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
			}

			if err := checkDailyUploadLimit(info.Auth, result.totalSize); err != nil {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusTooManyRequests, map[string]string{"error": err.Error()})
			}

			col, err := app.FindCollectionByNameOrId("hosted_games")
			if err != nil {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": "internal error"})
			}
			now := time.Now().UTC().Format(time.RFC3339)
			desc := strings.TrimSpace(e.Request.FormValue("description"))
			rec := core.NewRecord(col)
			rec.Set("owner", userID)
			rec.Set("slug", slug)
			rec.Set("title", title)
			rec.Set("description", desc)
			rec.Set("version", 1)
			rec.Set("size_bytes", result.totalSize)
			rec.Set("file_count", result.fileCount)
			rec.Set("status", "active")
			rec.Set("entry_point", "index.html")
			rec.Set("versions_meta", []map[string]interface{}{
				{"v": 1, "uploaded_at": now, "size_bytes": result.totalSize, "file_count": result.fileCount, "note": desc},
			})
			if err := app.Save(rec); err != nil {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}

			trackDailyUpload(app, info.Auth, result.totalSize)

			lookupCache.drop(hostingSlug + "/" + slug)

			go purgeCloudflareCache([]string{fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain)})
			return e.JSON(http.StatusOK, map[string]interface{}{
				"id": rec.Id, "slug": slug, "url": makeGameURL(hostingSlug, slug),
				"version": 1, "size": result.totalSize, "files": result.fileCount,
			})
		}).Bind(apis.RequireAuth(), apis.BodyLimit(maxZipSize))

		// God Mode: upload a game on behalf of any user by hosting_slug. Superusers only; game and daily
		// limits ignored.
		se.Router.POST("/api/hosting/admin/upload", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if info.Auth == nil {
				return e.JSON(http.StatusUnauthorized, map[string]string{"error": "login required"})
			}
			if info.Auth.Collection().Name != "_superusers" {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "superadmin only"})
			}

			userSlug := strings.ToLower(strings.TrimSpace(e.Request.FormValue("user_slug")))
			if !isValidSlug(userSlug) {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid user_slug"})
			}

			targetUser, err := app.FindFirstRecordByFilter("users",
				"hosting_slug = {:slug}",
				dbx.Params{"slug": userSlug})
			if err != nil || targetUser == nil {
				return e.JSON(http.StatusNotFound, map[string]string{
					"error": fmt.Sprintf("user with hosting_slug '%s' not found", userSlug),
				})
			}

			hostingSlug := targetUser.GetString("hosting_slug")
			userID := targetUser.Id

			slug := strings.ToLower(strings.TrimSpace(e.Request.FormValue("slug")))
			title := strings.TrimSpace(e.Request.FormValue("title"))
			if title == "" {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "title required"})
			}
			if !isValidSlug(slug) {
				return e.JSON(http.StatusBadRequest, map[string]string{
					"error": "slug: 3-60 chars, a-z 0-9 hyphens, no leading/trailing hyphens",
				})
			}

			force := strings.ToLower(strings.TrimSpace(e.Request.FormValue("force"))) == "true"

			dup, _ := app.FindFirstRecordByFilter("hosted_games",
				"owner = {:owner} && slug = {:slug}",
				dbx.Params{"owner": userID, "slug": slug})
			if dup != nil && !force {
				existingURL := makeGameURL(hostingSlug, slug)
				return e.JSON(http.StatusOK, map[string]interface{}{
					"id": dup.Id, "slug": slug, "url": existingURL,
					"version": dup.GetInt("version"), "skipped": true,
					"message": "game with this slug already exists",
				})
			}

			file, header, err := e.Request.FormFile("archive")
			if err != nil {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "missing 'archive' file"})
			}
			defer file.Close()

			if header.Size > maxZipSize {
				return e.JSON(http.StatusRequestEntityTooLarge, map[string]string{
					"error": fmt.Sprintf("zip too large, max %d MB", maxZipSize>>20),
				})
			}

			zipData, err := io.ReadAll(io.LimitReader(file, maxZipSize+1))
			if err != nil || int64(len(zipData)) > maxZipSize {
				return e.JSON(http.StatusRequestEntityTooLarge, map[string]string{"error": "zip too large"})
			}

			newVersion := 1
			oldVersion := 0
			if dup != nil {
				oldVersion = dup.GetInt("version")
				if oldVersion <= 0 {
					oldVersion = 1
				}
				newVersion = oldVersion + 1
			}

			prefix := r2VersionPrefix(hostingSlug, slug, newVersion)
			result, err := processZipToR2(zipData, s3Client, bucket, prefix, maxZipSize)
			if err != nil {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
			}

			now := time.Now().UTC().Format(time.RFC3339)
			desc := strings.TrimSpace(e.Request.FormValue("description"))

			var rec *core.Record
			if dup != nil {
				rec = dup
				rec.Set("version", newVersion)
				rec.Set("size_bytes", result.totalSize)
				rec.Set("file_count", result.fileCount)
				if desc != "" {
					rec.Set("description", desc)
				}
				var meta []map[string]interface{}
				if raw := rec.GetString("versions_meta"); raw != "" && raw != "null" {
					json.Unmarshal([]byte(raw), &meta)
				}
				meta = append(meta, map[string]interface{}{
					"v": newVersion, "uploaded_at": now,
					"size_bytes": result.totalSize, "file_count": result.fileCount,
					"note": "admin force update",
				})
				rec.Set("versions_meta", meta)
			} else {
				col, err := app.FindCollectionByNameOrId("hosted_games")
				if err != nil {
					cleanupR2(s3Client, bucket, prefix)
					return e.JSON(http.StatusInternalServerError, map[string]string{"error": "internal error"})
				}
				rec = core.NewRecord(col)
				rec.Set("owner", userID)
				rec.Set("slug", slug)
				rec.Set("title", title)
				rec.Set("description", desc)
				rec.Set("version", 1)
				rec.Set("size_bytes", result.totalSize)
				rec.Set("file_count", result.fileCount)
				rec.Set("status", "active")
				rec.Set("entry_point", "index.html")
				rec.Set("versions_meta", []map[string]interface{}{
					{"v": 1, "uploaded_at": now, "size_bytes": result.totalSize, "file_count": result.fileCount, "note": desc},
				})
			}

			if err := app.Save(rec); err != nil {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}

			lookupCache.drop(hostingSlug + "/" + slug)
			if oldVersion > 0 {
				purgeGameURLs(s3Client, bucket, hostingSlug, slug, oldVersion, result.fileKeys)
			} else {
				go purgeCloudflareCache([]string{fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain)})
			}

			fmt.Printf("[hosting] admin/upload: '%s/%s' v%d uploaded by superadmin for user '%s' (force=%v)\n",
				hostingSlug, slug, newVersion, targetUser.GetString("username"), force)

			return e.JSON(http.StatusOK, map[string]interface{}{
				"id": rec.Id, "slug": slug, "url": makeGameURL(hostingSlug, slug),
				"version": newVersion, "size": result.totalSize, "files": result.fileCount,
			})
		}).Bind(apis.BodyLimit(maxZipSize))

		// God Mode chunked upload: the game arrives in PARTS (each a valid zip of a file subset) to get
		// under the edge proxy's ~100MB request limit. All parts write into ONE version prefix; the
		// catalog record is created/updated only on the final part (final=true) after auditing the whole
		// assembly (index.html present, size/count within limits). Superusers only. Protocol (client:
		// tools/big_upload_chunked/chunked_upload.py): part 0 — server computes version and returns it
		// (client puts index.html in part 0); parts 1..N-1 — client sends that version back (form
		// "version"); final=true — server audits the prefix and finalizes. Parts are idempotent (same
		// keys overwritten). Limits: part ≤ maxZipSize, game ≤ maxChunkedGameSize.
		se.Router.POST("/api/hosting/admin/upload-part", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if info.Auth == nil {
				return e.JSON(http.StatusUnauthorized, map[string]string{"error": "login required"})
			}
			if info.Auth.Collection().Name != "_superusers" {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "superadmin only"})
			}

			userSlug := strings.ToLower(strings.TrimSpace(e.Request.FormValue("user_slug")))
			if !isValidSlug(userSlug) {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid user_slug"})
			}
			targetUser, err := app.FindFirstRecordByFilter("users",
				"hosting_slug = {:slug}", dbx.Params{"slug": userSlug})
			if err != nil || targetUser == nil {
				return e.JSON(http.StatusNotFound, map[string]string{
					"error": fmt.Sprintf("user with hosting_slug '%s' not found", userSlug),
				})
			}
			hostingSlug := targetUser.GetString("hosting_slug")
			userID := targetUser.Id

			slug := strings.ToLower(strings.TrimSpace(e.Request.FormValue("slug")))
			if !isValidSlug(slug) {
				return e.JSON(http.StatusBadRequest, map[string]string{
					"error": "slug: 3-60 chars, a-z 0-9 hyphens, no leading/trailing hyphens",
				})
			}

			force := strings.ToLower(strings.TrimSpace(e.Request.FormValue("force"))) == "true"
			partIndex, _ := strconv.Atoi(e.Request.FormValue("part_index"))
			final := strings.ToLower(strings.TrimSpace(e.Request.FormValue("final"))) == "true"

			dup, _ := app.FindFirstRecordByFilter("hosted_games",
				"owner = {:owner} && slug = {:slug}",
				dbx.Params{"owner": userID, "slug": slug})

			oldVersion := 0
			if dup != nil {
				oldVersion = dup.GetInt("version")
				if oldVersion <= 0 {
					oldVersion = 1
				}
			}
			var newVersion int
			if partIndex == 0 {
				if dup != nil && !force {
					return e.JSON(http.StatusOK, map[string]interface{}{
						"id": dup.Id, "slug": slug, "url": makeGameURL(hostingSlug, slug),
						"version": dup.GetInt("version"), "skipped": true,
						"message": "game with this slug already exists",
					})
				}
				if dup != nil {
					newVersion = oldVersion + 1
				} else {
					newVersion = 1
				}
			} else {
				newVersion, _ = strconv.Atoi(e.Request.FormValue("version"))
				if newVersion <= 0 {
					return e.JSON(http.StatusBadRequest, map[string]string{
						"error": "version (returned by part 0) required for part_index > 0",
					})
				}
			}
			prefix := r2VersionPrefix(hostingSlug, slug, newVersion)

			file, header, err := e.Request.FormFile("archive")
			if err != nil {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "missing 'archive' file"})
			}
			defer file.Close()
			if header.Size > maxZipSize {
				return e.JSON(http.StatusRequestEntityTooLarge, map[string]string{
					"error": fmt.Sprintf("part too large, max %d MB", maxZipSize>>20),
				})
			}
			zipData, err := io.ReadAll(io.LimitReader(file, maxZipSize+1))
			if err != nil || int64(len(zipData)) > maxZipSize {
				return e.JSON(http.StatusRequestEntityTooLarge, map[string]string{"error": "part too large"})
			}
			if _, err := processZipPartToR2(zipData, s3Client, bucket, prefix, maxChunkedGameSize); err != nil {
				// Do NOT clear the prefix: the client may resend this part (idempotent).
				return e.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
			}

			if !final {
				return e.JSON(http.StatusOK, map[string]interface{}{
					"slug": slug, "version": newVersion, "part_index": partIndex, "done": false,
				})
			}

			fileCount, totalBytes, hasIndex, relPaths := r2PrefixStats(s3Client, bucket, prefix)
			if !hasIndex {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "archive must contain index.html"})
			}
			if fileCount > maxFiles {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("too many files (max %d)", maxFiles)})
			}
			if totalBytes > maxChunkedGameSize {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusRequestEntityTooLarge, map[string]string{
					"error": fmt.Sprintf("game too large, max %d MB", maxChunkedGameSize>>20),
				})
			}

			now := time.Now().UTC().Format(time.RFC3339)
			desc := strings.TrimSpace(e.Request.FormValue("description"))
			title := strings.TrimSpace(e.Request.FormValue("title"))

			var rec *core.Record
			if dup != nil {
				rec = dup
				rec.Set("version", newVersion)
				rec.Set("size_bytes", totalBytes)
				rec.Set("file_count", fileCount)
				if desc != "" {
					rec.Set("description", desc)
				}
				var meta []map[string]interface{}
				if raw := rec.GetString("versions_meta"); raw != "" && raw != "null" {
					json.Unmarshal([]byte(raw), &meta)
				}
				meta = append(meta, map[string]interface{}{
					"v": newVersion, "uploaded_at": now,
					"size_bytes": totalBytes, "file_count": fileCount,
					"note": "admin chunked update",
				})
				rec.Set("versions_meta", meta)
			} else {
				if title == "" {
					cleanupR2(s3Client, bucket, prefix)
					return e.JSON(http.StatusBadRequest, map[string]string{"error": "title required for new game"})
				}
				col, err := app.FindCollectionByNameOrId("hosted_games")
				if err != nil {
					cleanupR2(s3Client, bucket, prefix)
					return e.JSON(http.StatusInternalServerError, map[string]string{"error": "internal error"})
				}
				rec = core.NewRecord(col)
				rec.Set("owner", userID)
				rec.Set("slug", slug)
				rec.Set("title", title)
				rec.Set("description", desc)
				rec.Set("version", newVersion)
				rec.Set("size_bytes", totalBytes)
				rec.Set("file_count", fileCount)
				rec.Set("status", "active")
				rec.Set("entry_point", "index.html")
				rec.Set("versions_meta", []map[string]interface{}{
					{"v": newVersion, "uploaded_at": now, "size_bytes": totalBytes, "file_count": fileCount, "note": desc},
				})
			}

			if err := app.Save(rec); err != nil {
				cleanupR2(s3Client, bucket, prefix)
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}

			lookupCache.drop(hostingSlug + "/" + slug)
			if oldVersion > 0 {
				purgeGameURLs(s3Client, bucket, hostingSlug, slug, oldVersion, relPaths)
			} else {
				go purgeCloudflareCache([]string{fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain)})
			}

			fmt.Printf("[hosting] admin/upload-part: '%s/%s' v%d finalized by superadmin for user '%s' (%d files, %s, force=%v)\n",
				hostingSlug, slug, newVersion, targetUser.GetString("username"), fileCount, formatBytes(totalBytes), force)

			return e.JSON(http.StatusOK, map[string]interface{}{
				"id": rec.Id, "slug": slug, "url": makeGameURL(hostingSlug, slug),
				"version": newVersion, "size": totalBytes, "files": fileCount, "done": true,
			})
		}).Bind(apis.BodyLimit(maxZipSize))

		se.Router.POST("/api/hosting/update/{id}", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if info.Auth == nil {
				return e.JSON(http.StatusUnauthorized, map[string]string{"error": "login required"})
			}
			rec, err := app.FindRecordById("hosted_games", e.Request.PathValue("id"))
			if err != nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
			}
			if rec.GetString("owner") != info.Auth.Id {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "not yours"})
			}
			// Body shared with the moderator reupload, see hosting_versions.go.
			hostingSlug, _ := ensureHostingSlug(app, info.Auth)
			zipData, err := hostingReadArchive(e, getUserMaxZipSize(info.Auth), info.Auth)
			if err != nil {
				return hostingFail(e, err)
			}
			res, err := hostingApplyNewVersion(app, s3Client, bucket, rec, info.Auth, hostingSlug, zipData,
				e.Request.FormValue("title"), e.Request.FormValue("description"),
				strings.TrimSpace(e.Request.FormValue("version_note")), true)
			if err != nil {
				return hostingFail(e, err)
			}
			return e.JSON(http.StatusOK, map[string]interface{}{
				"id": rec.Id, "version": res.Version, "size": res.SizeBytes, "files": res.FileCount,
			})
		}).Bind(apis.RequireAuth(), apis.BodyLimit(maxZipSize))

		se.Router.DELETE("/api/hosting/games/{id}", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if info.Auth == nil {
				return e.JSON(http.StatusUnauthorized, map[string]string{"error": "login required"})
			}
			rec, err := app.FindRecordById("hosted_games", e.Request.PathValue("id"))
			if err != nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
			}
			if rec.GetString("owner") != info.Auth.Id {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "not yours"})
			}
			hostingSlug, _ := ensureHostingSlug(app, info.Auth)
			slug := rec.GetString("slug")
			rec.Set("status", "hidden")
			rec.Set("hidden_at", time.Now().UTC().Format("2006-01-02 15:04:05"))
			rec.Set("mod_note", "Hidden by owner")
			if err := app.Save(rec); err != nil {
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to hide game"})
			}
			lookupCache.drop(hostingSlug + "/" + slug)
			go purgeCloudflareCache([]string{
				fmt.Sprintf("https://%s.%s/%s/", hostingSlug, baseDomain, slug),
				fmt.Sprintf("https://%s.%s/%s/index.html", hostingSlug, baseDomain, slug),
				fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain),
			})
			return e.JSON(http.StatusOK, map[string]string{"status": "hidden", "message": "Game hidden"})
		}).Bind(apis.RequireAuth())

		se.Router.POST("/api/hosting/restore/{id}", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if info.Auth == nil {
				return e.JSON(http.StatusUnauthorized, map[string]string{"error": "login required"})
			}
			rec, err := app.FindRecordById("hosted_games", e.Request.PathValue("id"))
			if err != nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
			}
			if rec.GetString("owner") != info.Auth.Id {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "not yours"})
			}
			status := rec.GetString("status")
			if status == "blocked" {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "blocked by moderator"})
			}
			if status == "active" {
				return e.JSON(http.StatusOK, map[string]string{"status": "active", "message": "Already active"})
			}
			gameLimit := getUserGameLimit(info.Auth)
			existingActive, _ := app.FindRecordsByFilter("hosted_games",
				"owner = {:owner} && status = 'active'",
				"", 0, 0,
				dbx.Params{"owner": info.Auth.Id})
			if len(existingActive) >= gameLimit {
				return e.JSON(http.StatusTooManyRequests, map[string]string{
					"error": fmt.Sprintf("max %d active games — hide another game first", gameLimit),
				})
			}
			rec.Set("status", "active")
			rec.Set("mod_note", "")
			rec.Set("hidden_at", "")
			if err := app.Save(rec); err != nil {
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
			}
			hostingSlug, _ := ensureHostingSlug(app, info.Auth)
			lookupCache.drop(hostingSlug + "/" + rec.GetString("slug"))
			go purgeCloudflareCache([]string{fmt.Sprintf("https://%s.%s/", hostingSlug, baseDomain)})
			return e.JSON(http.StatusOK, map[string]string{"status": "active", "message": "Game restored"})
		}).Bind(apis.RequireAuth())

		se.Router.POST("/api/hosting/version/{id}", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if info.Auth == nil {
				return e.JSON(http.StatusUnauthorized, map[string]string{"error": "login required"})
			}
			rec, err := app.FindRecordById("hosted_games", e.Request.PathValue("id"))
			if err != nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "game not found"})
			}
			if rec.GetString("owner") != info.Auth.Id {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "not yours"})
			}
			var body struct {
				Version int `json:"version"`
			}
			if err := json.NewDecoder(e.Request.Body).Decode(&body); err != nil {
				return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid version number"})
			}
			// Body shared with the moderator rollback, see hosting_versions.go.
			hostingSlug, _ := ensureHostingSlug(app, info.Auth)
			if err := hostingSwitchVersion(app, s3Client, bucket, rec, hostingSlug, body.Version); err != nil {
				return hostingFail(e, err)
			}
			return e.JSON(http.StatusOK, map[string]interface{}{
				"version": body.Version, "message": fmt.Sprintf("Switched to v%d", body.Version),
			})
		}).Bind(apis.RequireAuth())

		se.Router.GET("/api/hosting/my-games", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if info.Auth == nil {
				return e.JSON(http.StatusUnauthorized, map[string]string{"error": "login required"})
			}
			hostingSlug, _ := ensureHostingSlug(app, info.Auth)
			records, err := app.FindRecordsByFilter("hosted_games",
				"owner = {:owner}",
				"-created", 0, 0,
				dbx.Params{"owner": info.Auth.Id})
			if err != nil {
				records = nil
			}
			var games []map[string]interface{}
			for _, r := range records {
				var versions []map[string]interface{}
				if raw := r.GetString("versions_meta"); raw != "" && raw != "null" {
					json.Unmarshal([]byte(raw), &versions)
				}
				if versions == nil {
					versions = []map[string]interface{}{}
				}
				games = append(games, map[string]interface{}{
					"id": r.Id, "slug": r.GetString("slug"), "title": r.GetString("title"),
					"description": r.GetString("description"), "version": r.GetInt("version"),
					"size_bytes": r.GetInt("size_bytes"), "file_count": r.GetInt("file_count"),
					"status": r.GetString("status"), "url": makeGameURL(hostingSlug, r.GetString("slug")),
					"created": r.GetString("created"), "updated": r.GetString("updated"), "versions": versions,
				})
			}
			if games == nil {
				games = []map[string]interface{}{}
			}
			dailyUploaded := int64(0)
			today := time.Now().UTC().Format("2006-01-02")
			if info.Auth.GetString("hosting_daily_reset") == today {
				dailyUploaded = int64(info.Auth.GetInt("hosting_daily_uploaded"))
			}
			return e.JSON(http.StatusOK, map[string]interface{}{
				"hosting_slug": hostingSlug, "homepage": makeHomeURL(hostingSlug), "games": games,
				"limits": map[string]interface{}{
					"max_games": getUserGameLimit(info.Auth), "max_upload_mb": int(getUserMaxZipSize(info.Auth) >> 20),
					"daily_limit_mb": defaultDailyUploadBytes >> 20,
					"daily_used_mb":  float64(dailyUploaded) / (1024 * 1024),
				},
			})
		}).Bind(apis.RequireAuth())

		se.Router.GET("/api/hosting/mod/queue", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if !isMod(info) {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "moderators only"})
			}
			records, err := app.FindRecordsByFilter("hosted_games", "status != 'active'", "-updated", 100, 0)
			if err != nil {
				return e.JSON(http.StatusOK, []interface{}{})
			}
			var result []map[string]interface{}
			for _, r := range records {
				ownerName, ownerSlug := "", ""
				if owner, err := app.FindRecordById("users", r.GetString("owner")); err == nil {
					ownerName = owner.GetString("username")
					ownerSlug = owner.GetString("hosting_slug")
				}
				result = append(result, map[string]interface{}{
					"id": r.Id, "slug": r.GetString("slug"), "title": r.GetString("title"),
					"status": r.GetString("status"), "mod_note": r.GetString("mod_note"),
					"hidden_at": r.GetString("hidden_at"), "owner_name": ownerName,
					"size_bytes": r.GetInt("size_bytes"), "file_count": r.GetInt("file_count"),
					"url": makeGameURL(ownerSlug, r.GetString("slug")), "created": r.GetString("created"),
				})
			}
			if result == nil {
				result = []map[string]interface{}{}
			}
			return e.JSON(http.StatusOK, result)
		}).Bind(apis.RequireAuth())

		se.Router.POST("/api/hosting/mod/block/{id}", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if !isMod(info) {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "moderators only"})
			}
			rec, err := app.FindRecordById("hosted_games", e.Request.PathValue("id"))
			if err != nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
			}
			reason := e.Request.URL.Query().Get("reason")
			if reason == "" {
				reason = "Blocked by moderator"
			}
			blockBefore := modSnapshot(rec, "status", "mod_note", "hidden_at")
			rec.Set("status", "blocked")
			rec.Set("mod_note", reason)
			rec.Set("hidden_at", time.Now().UTC().Format("2006-01-02 15:04:05"))
			if err := app.Save(rec); err != nil {
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to block game"})
			}
			if owner, err := app.FindRecordById("users", rec.GetString("owner")); err == nil {
				hs := owner.GetString("hosting_slug")
				slug := rec.GetString("slug")
				lookupCache.drop(hs + "/" + slug)
				go purgeCloudflareCache([]string{
					fmt.Sprintf("https://%s.%s/%s/", hs, baseDomain, slug),
					fmt.Sprintf("https://%s.%s/%s/index.html", hs, baseDomain, slug),
					fmt.Sprintf("https://%s.%s/", hs, baseDomain),
				})
			}
			logModAction(app, e, modAction{
				Action:     "hosting.block",
				Target:     rec.Id + " " + rec.GetString("slug"),
				Before:     blockBefore,
				After:      modSnapshot(rec, "status", "mod_note", "hidden_at"),
				Reversible: true,
				Note:       reason,
			})
			return e.JSON(http.StatusOK, map[string]string{"status": "blocked"})
		}).Bind(apis.RequireAuth())

		se.Router.POST("/api/hosting/mod/restore/{id}", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			if !isMod(info) {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "moderators only"})
			}
			rec, err := app.FindRecordById("hosted_games", e.Request.PathValue("id"))
			if err != nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
			}
			restoreBefore := modSnapshot(rec, "status", "mod_note", "hidden_at")
			rec.Set("status", "active")
			rec.Set("mod_note", "")
			rec.Set("hidden_at", "")
			if err := app.Save(rec); err != nil {
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to restore game"})
			}
			logModAction(app, e, modAction{
				Action:     "hosting.restore",
				Target:     rec.Id + " " + rec.GetString("slug"),
				Before:     restoreBefore,
				After:      modSnapshot(rec, "status", "mod_note", "hidden_at"),
				Reversible: true,
			})
			if owner, err := app.FindRecordById("users", rec.GetString("owner")); err == nil {
				hs := owner.GetString("hosting_slug")
				lookupCache.drop(hs + "/" + rec.GetString("slug"))
				go purgeCloudflareCache([]string{fmt.Sprintf("https://%s.%s/", hs, baseDomain)})
			}
			return e.JSON(http.StatusOK, map[string]string{"status": "active"})
		}).Bind(apis.RequireAuth())

		se.Router.DELETE("/api/hosting/mod/purge/{id}", func(e *core.RequestEvent) error {
			info, _ := e.RequestInfo()
			// Separate permission: physical deletion of R2 files, no undo. Plain "hosting" isn't enough.
			if info == nil || !authHasPerm(info.Auth, permHostingPurge) {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "moderators only"})
			}
			rec, err := app.FindRecordById("hosted_games", e.Request.PathValue("id"))
			if err != nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "not found"})
			}
			if owner, err := app.FindRecordById("users", rec.GetString("owner")); err == nil {
				slug := rec.GetString("slug")
				hs := owner.GetString("hosting_slug")
				gamePrefix := r2GamePrefix(hs, slug)
				allR2Paths := listR2RelativePaths(s3Client, bucket, gamePrefix)
				var publicPaths []string
				for _, p := range allR2Paths {
					if idx := strings.Index(p, "/"); idx != -1 {
						publicPaths = append(publicPaths, p[idx+1:])
					}
				}
				purgeURLs := buildPurgeURLs(hs, slug, publicPaths)
				cleanupR2(s3Client, bucket, gamePrefix)
				lookupCache.drop(hs + "/" + slug)
				go purgeCloudflareCache(purgeURLs)
			}
			purgeBefore := modSnapshot(rec, "owner", "slug", "title", "status", "entry_point", "version", "file_count", "size_bytes")
			if err := app.Delete(rec); err != nil {
				return e.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to delete record"})
			}
			logModAction(app, e, modAction{
				Action: "hosting.purge",
				Target: rec.Id + " " + rec.GetString("slug"),
				Before: purgeBefore,
				// R2 files are physically gone — only a re-upload of a snapshot can bring it back.
				Reversible: false,
				Note:       "R2 objects deleted and CF cache purged; restoring requires a re-upload",
			})
			return e.JSON(http.StatusOK, map[string]string{"status": "purged"})
		}).Bind(apis.RequireAuth())

		registerHostingModVersionRoutes(app, se, s3Client, bucket)

		se.Router.GET("/play/{username}/{slug}/{path...}", func(e *core.RequestEvent) error {
			username := e.Request.PathValue("username")
			slug := e.Request.PathValue("slug")
			filePath := e.Request.PathValue("path")
			user, err := app.FindFirstRecordByFilter("users",
				"username = {:username}",
				dbx.Params{"username": username})
			if err != nil || user == nil {
				user, err = app.FindFirstRecordByFilter("users",
					"hosting_slug = {:slug}",
					dbx.Params{"slug": strings.ToLower(username)})
			}
			if err != nil || user == nil {
				return e.JSON(http.StatusNotFound, map[string]string{"error": "user not found"})
			}
			hs, _ := ensureHostingSlug(app, user)
			target := fmt.Sprintf("https://%s.%s/%s/%s", hs, baseDomain, slug, filePath)
			// Edge-cached like the SPA shell (CF rule R6 respects origin TTLs).
			e.Response.Header().Set("Cache-Control", "public, max-age=3600")
			return e.Redirect(http.StatusMovedPermanently, target)
		})

		return se.Next()
	})
}
