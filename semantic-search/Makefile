# Semantic search v2 — deploy to the same box as the old system.
# Author runs deploys; Claude does not.

SERVER_USER ?= root
# Override on the command line: make deploy SERVER_IP=your-server
SERVER_IP ?= your-server.example.com
REMOTE_DIR = /root/semantic-search-v2/
SERVICE = semantic-search-v2.service
OLD_SERVICE = semantic-search.service

.PHONY: help
help:
	@echo "make reindex       - пересобрать индекс по живому каталогу (локально)"
	@echo "make serve-local   - поднять сервер локально на :8100"
	@echo "make deploy-setup  - ПЕРВЫЙ раз: создать venv и systemd-юнит на сервере"
	@echo "make deploy        - залить код+индекс, перезапустить сервис"
	@echo "make switchover    - выключить старый сервис, включить v2 (порт 8100)"
	@echo "make logs / status - журнал / статус сервиса"

.PHONY: reindex
reindex:
	python3 build_catalog_index.py

.PHONY: serve-local
serve-local:
	EMBED_MIN_INTERVAL=0.5 python3 -m uvicorn server:app --port 8100

.PHONY: deploy-setup
deploy-setup:
	ssh $(SERVER_USER)@$(SERVER_IP) "mkdir -p $(REMOTE_DIR)index && python3 -m venv $(REMOTE_DIR)venv && $(REMOTE_DIR)venv/bin/pip install fastapi uvicorn numpy"
	scp semantic-search-v2.service $(SERVER_USER)@$(SERVER_IP):/etc/systemd/system/
	@echo "⚠️  Положи .env с GOOGLE_API_KEY в $(REMOTE_DIR) (можно скопировать из /root/semantic-search/.env)"
	ssh $(SERVER_USER)@$(SERVER_IP) "systemctl daemon-reload"

.PHONY: deploy
deploy:
	rsync -avz server.py lib_embed.py $(SERVER_USER)@$(SERVER_IP):$(REMOTE_DIR)
	rsync -avz index/catalog_vecs.npy index/catalog_meta.json $(SERVER_USER)@$(SERVER_IP):$(REMOTE_DIR)index/
	scp semantic-search-v2.service $(SERVER_USER)@$(SERVER_IP):/etc/systemd/system/
	ssh $(SERVER_USER)@$(SERVER_IP) "systemctl daemon-reload && systemctl restart $(SERVICE) 2>/dev/null || true"
	@echo "✅ если сервис ещё не включён — make switchover"

.PHONY: switchover
switchover:
	ssh $(SERVER_USER)@$(SERVER_IP) "systemctl disable --now $(OLD_SERVICE) && systemctl enable --now $(SERVICE) && sleep 2 && curl -s 127.0.0.1:8100/healthz"

.PHONY: rollback
rollback:
	ssh $(SERVER_USER)@$(SERVER_IP) "systemctl disable --now $(SERVICE) && systemctl enable --now $(OLD_SERVICE)"

.PHONY: logs
logs:
	ssh $(SERVER_USER)@$(SERVER_IP) "journalctl -u $(SERVICE) -f"

.PHONY: status
status:
	ssh $(SERVER_USER)@$(SERVER_IP) "systemctl status $(SERVICE)"
