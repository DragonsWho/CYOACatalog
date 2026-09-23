# Semantic search service (FastAPI, port 8100). Deploys to the same box as the site.
# SSH_HOST comes from ../deploy.mk (untracked: the origin IP must stay private).
-include ../deploy.mk
REMOTE_DIR := /root/semantic-search-v2/
SERVICE := semantic-search-v2.service

.PHONY: serve-local deploy-setup deploy logs status

serve-local:
	EMBED_MIN_INTERVAL=0.5 python3 -m uvicorn server:app --port 8100

# First time only: venv + systemd unit. Then put .env (GOOGLE_API_KEY, PB_SUPERUSER_EMAIL,
# PB_SUPERUSER_PASSWORD) into $(REMOTE_DIR). With no index the first sync builds it.
deploy-setup:
	ssh $(SSH_HOST) "mkdir -p $(REMOTE_DIR)index && python3 -m venv $(REMOTE_DIR)venv && $(REMOTE_DIR)venv/bin/pip install -r /dev/stdin" < requirements.txt
	scp $(SERVICE) $(SSH_HOST):/etc/systemd/system/
	ssh $(SSH_HOST) "systemctl daemon-reload && systemctl enable $(SERVICE)"

# Code only. The index on the server re-syncs itself and is usually fresher than any local copy.
deploy:
	rsync -avz server.py lib_embed.py $(SSH_HOST):$(REMOTE_DIR)
	scp $(SERVICE) $(SSH_HOST):/etc/systemd/system/
	ssh $(SSH_HOST) "systemctl daemon-reload && systemctl restart $(SERVICE)"

logs:
	ssh $(SSH_HOST) "journalctl -u $(SERVICE) -f"

status:
	ssh $(SSH_HOST) "systemctl status $(SERVICE)"
