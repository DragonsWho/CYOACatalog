# --- Config ---
# Maintainer-only settings live in the untracked deploy.mk: SSH_HOST (the origin IP must not be
# public), PB_PROD_ENV (.env with prod superuser creds for pb-prod/schema-snapshot), CODEX_DIR.
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

DEV_PORT ?= 8090
VITE_PORT ?= 8091

# Local development. Open http://localhost:8090 — the Go server answers /api from the LOCAL
# pb_data and proxies the page to Vite. (Vite's own :8091 proxies /api to PRODUCTION.)
.PHONY: dev
dev:
	@test -f pb_data/data.db || { echo "No local DB yet: run 'make seed' first."; exit 1; }
	NODE_ENV='development' DEV_VITE_URL=http://localhost:$(VITE_PORT) ./node_modules/.bin/concurrently -n "server,client" -c "bgBlue.bold,bgMagenta.bold" "CGO_ENABLED=0 go run . serve --http 127.0.0.1:$(DEV_PORT)" "./node_modules/.bin/vite --port $(VITE_PORT) --strictPort"

.PHONY: build build-app
build: update-oauth build-app

# Build without refreshing the OAuth plugin (no network, go.mod untouched).
build-app:
	rm -f ./dist/serve
	./node_modules/.bin/tsc -b
	./node_modules/.bin/vite build
	CGO_ENABLED=0 go build -buildvcs=false -o dist/serve .

.PHONY: run
run:
	./dist/serve serve --dir ./pb_data

# Fresh local DB: schema from pb_schema.json, newest games/tags/authors from the public site API,
# test accounts (see AGENTS.md). An existing pb_data is moved aside, never deleted.
# SEED_ARGS examples: --games 0 (all games), --no-images, --from http://127.0.0.1:8090
.PHONY: seed
seed:
	@if [ -d pb_data ]; then b=pb_data.bak-$$(date +%Y%m%d-%H%M%S); mv pb_data $$b; echo "old pb_data -> $$b"; fi
	CGO_ENABLED=0 go run . seed --dir pb_data $(SEED_ARGS)

# Fast checks that write nothing into dist/ (what agents should run before committing).
.PHONY: check
check:
	@# //go:embed dist needs the folder; a fresh clone gets a placeholder until the first vite build.
	@test -e dist/index.html || { mkdir -p dist; echo '<!-- placeholder: run vite build -->' > dist/index.html; }
	./node_modules/.bin/tsc -p tsconfig.app.json --noEmit --incremental false
	./node_modules/.bin/tsc -p tsconfig.node.json --noEmit --incremental false
	go vet ./...
	go test ./...

# --- PocketBase schema/data scripts (pb_scripts/, see pb_scripts/README.md) ---

# Run a script against the local dev server (make dev must be running). APPLY=1 writes.
.PHONY: pb-local
pb-local:
	@test -n "$(S)" || { echo "usage: make pb-local S=pb_scripts/<file>.py [APPLY=1]"; exit 1; }
	python3 $(S) $(if $(APPLY),--apply,)

# Maintainer: run a reviewed script against PRODUCTION. Dry-run unless APPLY=1 (asks to confirm).
.PHONY: pb-prod
pb-prod:
	@test -n "$(S)" || { echo "usage: make pb-prod S=pb_scripts/<file>.py [APPLY=1]"; exit 1; }
	@test -n "$(PB_PROD_ENV)" || { echo "PB_PROD_ENV is not set (deploy.mk)"; exit 1; }
	@if [ -n "$(APPLY)" ]; then read -p "APPLY $(S) to PRODUCTION? type yes: " a; [ "$$a" = yes ] || exit 1; fi
	PB_ENV_FILE="$(PB_PROD_ENV)" python3 $(S) $(if $(APPLY),--apply,)
	@if [ -n "$(APPLY)" ]; then $(MAKE) --no-print-directory schema-snapshot; fi

# Maintainer: refresh pb_schema.json from production (read-only). Runs after every ship and
# pb-prod APPLY so the seed never drifts from the live schema; commit the diff if there is one.
.PHONY: schema-snapshot
schema-snapshot:
	@if [ -z "$(PB_PROD_ENV)" ]; then echo "schema-snapshot: PB_PROD_ENV not set, skipped"; exit 0; fi; \
	PB_ENV_FILE="$(PB_PROD_ENV)" python3 pb_scripts/schema_snapshot.py && \
	{ git diff --quiet -- pb_schema.json || echo ">> pb_schema.json changed: commit it"; }

# --- Codex (a second agent working in its own clone, CODEX_DIR in deploy.mk) ---
# codex-sync: hand main to the clone. codex-pull: review + merge its `codex` branch.
.PHONY: codex-sync codex-pull ship-codex
codex-sync:
	@scripts/codex.sh sync "$(CODEX_DIR)"
codex-pull:
	@scripts/codex.sh pull "$(CODEX_DIR)"
ship-codex: codex-pull ship

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
	$(MAKE) --no-print-directory schema-snapshot
	sleep 10
	$(MAKE) open-incognito

.PHONY: logs
logs:
	ssh $(SSH_HOST) 'journalctl -u $(SERVICE_NAME) -f -n 100'
 
# --- E2E Tests (Playwright) ---

# Run all E2E tests headlessly against a dedicated test PocketBase instance.
# Requires the app to be built first: make build
.PHONY: test
test: build-app
	./node_modules/.bin/playwright test

# Run tests with the Playwright UI (trace viewer, re-run, watch mode).
.PHONY: test-ui
test-ui: build-app
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