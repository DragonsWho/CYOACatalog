# --- Config ---
# Deploy target. Override in .env or on the command line:
#   make ship SSH_HOST=root@your-server
SSH_HOST ?= root@your-server.example.com
SERVICE_NAME := cyoa-cafe
REMOTE_DIR := /root/cyoa-cafe

# Загружаем переменные из .env
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

# ┌─── ДОБАВЛЕНО: Обновление форка плагина ───┐
.PHONY: update-oauth
update-oauth:
	@echo "=> Скачиваем свежий коммит pocketbase-ext-oauth2 с GitHub (в обход кэша)..."
	GOPROXY=direct go get github.com/DragonsWho/pocketbase-ext-oauth2@main
	@echo "=> Прибираемся в зависимостях (go mod tidy)..."
	go mod tidy
	@echo "=> Готово! Форк обновлен. Теперь можно запускать 'make build' или 'make dev'."
# └───────────────────────────────────────────┘

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
		--data '{"prefixes":["cyoa.cafe/assets/","cyoa.cafe/api/pipeline/","www.cyoa.cafe/api/pipeline/","cyoa.cafe/game/","cyoa.cafe/search","cyoa.cafe/hosting","cyoa.cafe/create","cyoa.cafe/recovery","cyoa.cafe/verification","cyoa.cafe/privacy-policy","cyoa.cafe/terms-of-service","cyoa.cafe/moderator","cyoa.cafe/vector-search"]}'

.PHONY: open-incognito
open-incognito:
	google-chrome --incognito "https://cyoa.cafe" >/dev/null 2>&1 &

# --- Remote Operations ---

# Переименовали deploy-remote в ship (s + Tab работает идеально)
.PHONY: ship
ship: update-oauth
ship:
	# 1. Локальная сборка под Linux
	rm -f ./dist/serve
	./node_modules/.bin/tsc -b
	./node_modules/.bin/vite build
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -o dist/serve-linux .

	# 2. Заливка на сервер
	ssh $(SSH_HOST) 'mkdir -p $(REMOTE_DIR)/dist'
	cat dist/serve-linux | ssh $(SSH_HOST) 'cat > $(REMOTE_DIR)/dist/serve.new && chmod +x $(REMOTE_DIR)/dist/serve.new'
	# JS-хуки PocketBase читаются с диска (НЕ вшиты в бинарь) — копируем перед рестартом
	ssh $(SSH_HOST) 'mkdir -p $(REMOTE_DIR)/pb_hooks'
	scp pb_hooks/*.pb.js $(SSH_HOST):$(REMOTE_DIR)/pb_hooks/
	ssh $(SSH_HOST) 'mv $(REMOTE_DIR)/dist/serve.new $(REMOTE_DIR)/dist/serve && systemctl restart $(SERVICE_NAME)'
	
	rm -f dist/serve-linux

	# 3. Очистка кэша и проверка
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