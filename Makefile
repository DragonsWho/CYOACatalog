# --- Config ---
# SSH_HOST (deploy target) lives in the untracked deploy.mk: the origin IP must not be public.
-include deploy.mk
SERVICE_NAME := cyoa-cafe
REMOTE_DIR := /root/cyoa-cafe

# Load variables from .env
ifneq (,$(wildcard .env))
  include .env
  export $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*$$/\1/p' .env)
endif

.PHONY: install
install:
	bun i

.PHONY: dev
dev:
	NODE_ENV='development' ./node_modules/.bin/concurrently -n "server,client" -c "bgBlue.bold,bgMagenta.bold" "CGO_ENABLED=0 go run . serve" "./node_modules/.bin/vite --port 8091"

.PHONY: build
build: update-oauth
	rm -f ./dist/serve
	./node_modules/.bin/tsc -b
	./node_modules/.bin/vite build
	CGO_ENABLED=0 go build -buildvcs=false -o dist/serve .

.PHONY: run
run:
	./dist/serve serve --dir ./pb_data

# Refresh the forked OAuth2 plugin.
.PHONY: update-oauth
update-oauth:
	@echo "=> Fetching latest pocketbase-ext-oauth2 commit from GitHub (bypassing proxy cache)..."
	GOPROXY=direct go get github.com/DragonsWho/pocketbase-ext-oauth2@main
	@echo "=> go mod tidy..."
	go mod tidy
	@echo "=> Done. Fork updated; run 'make build' or 'make dev'."

.PHONY: cf-purge
cf-purge:
	@curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$(CLOUDFLARE_ZONE_ID)/purge_cache" \
		-H "Authorization: Bearer $(CLOUDFLARE_API_TOKEN)" \
		-H "Content-Type: application/json" \
		--data '{"files":["https://cyoa.cafe","https://cyoa.cafe/","https://cyoa.cafe/semantic-search","https://cyoa.cafe/login","https://cyoa.cafe/profile"]}'
	@echo
	@curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$(CLOUDFLARE_ZONE_ID)/purge_cache" \
		-H "Authorization: Bearer $(CLOUDFLARE_API_TOKEN)" \
		-H "Content-Type: application/json" \
		--data '{"prefixes":["cyoa.cafe/assets/","cyoa.cafe/chat","cyoa.cafe/feed-lab3","cyoa.cafe/api/pipeline/","www.cyoa.cafe/api/pipeline/","cyoa.cafe/game/","cyoa.cafe/search","cyoa.cafe/hosting","cyoa.cafe/create","cyoa.cafe/recovery","cyoa.cafe/verification","cyoa.cafe/privacy-policy","cyoa.cafe/terms-of-service","cyoa.cafe/moderator","cyoa.cafe/vector-search"]}'

.PHONY: open-incognito
open-incognito:
	google-chrome --incognito "https://cyoa.cafe" >/dev/null 2>&1 &

# --- Remote Operations ---

# Build, upload, restart, purge CF cache.
.PHONY: ship
ship: update-oauth
ship:
	# 1. Local linux build
	rm -f ./dist/serve
	./node_modules/.bin/tsc -b
	./node_modules/.bin/vite build
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -o dist/serve-linux .

	# 2. Upload
	ssh $(SSH_HOST) 'mkdir -p $(REMOTE_DIR)/dist'
	cat dist/serve-linux | ssh $(SSH_HOST) 'cat > $(REMOTE_DIR)/dist/serve.new && chmod +x $(REMOTE_DIR)/dist/serve.new'
	# PocketBase JS hooks are read from disk (NOT embedded in the binary) — copy before restart
	ssh $(SSH_HOST) 'mkdir -p $(REMOTE_DIR)/pb_hooks'
	scp pb_hooks/*.pb.js $(SSH_HOST):$(REMOTE_DIR)/pb_hooks/
	# This build's assets go into a cumulative store that is NEVER cleaned on deploy:
	# an open tab holds the old index.html and its lazy chunks must survive the restart,
	# or it dies with a white screen. Lifetime: initAssetsStore (main.go).
	# --ignore-existing is safe: asset names are content hashes.
	ssh $(SSH_HOST) 'mkdir -p $(REMOTE_DIR)/assets_store'
	rsync -a --ignore-existing dist/assets/ $(SSH_HOST):$(REMOTE_DIR)/assets_store/

	ssh $(SSH_HOST) 'mv $(REMOTE_DIR)/dist/serve.new $(REMOTE_DIR)/dist/serve && systemctl restart $(SERVICE_NAME)'
	
	rm -f dist/serve-linux

	# 3. Purge cache and check
	$(MAKE) cf-purge
	sleep 10
	$(MAKE) open-incognito

.PHONY: logs
logs:
	ssh $(SSH_HOST) 'journalctl -u $(SERVICE_NAME) -f -n 100'
 
# --- E2E Tests (Playwright) ---

# Run all E2E tests headlessly against a dedicated test PocketBase instance.
# Requires the app to be built first: make build
.PHONY: test
test: build
	./node_modules/.bin/playwright test

# Run tests with the Playwright UI (trace viewer, re-run, watch mode).
.PHONY: test-ui
test-ui: build
	./node_modules/.bin/playwright test --ui

# Show the last HTML test report without re-running tests.
.PHONY: test-report
test-report:
	./node_modules/.bin/playwright show-report e2e/playwright-report

.PHONY: update-local
update-local:
	git pull
	bun i --frozen-lockfile
	make build
	sudo systemctl restart $(SERVICE_NAME)