"""Minimal PocketBase admin client for pb_scripts/ (stdlib only, no venv needed).

Every script targets the LOCAL dev server by default (http://127.0.0.1:8090, superuser created
by `make seed`). Production is reached only when PB_ENV_FILE / PB_URL say so, which is how the
maintainer runs a reviewed script: `make pb-prod S=pb_scripts/<file>.py [APPLY=1]`.

Env (all optional):
  PB_URL, PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD  explicit target and superuser
  PB_ENV_FILE  .env file with SITE_API_URL + PB_SUPERUSER_EMAIL/PASSWORD (maintainer's prod creds)
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

LOCAL_URL = "http://127.0.0.1:8090"
# Same values as seed.go (seedAdminEmail/seedAdminPassword); only valid on a local seeded DB.
LOCAL_ADMIN_EMAIL = "admin@local.test"
LOCAL_ADMIN_PASSWORD = "localadmin123"

BACKUP_DIR = Path(__file__).resolve().parent / ".backups"
# Production sits behind Cloudflare, which rejects the default urllib user agent.
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"


def load_env_file(path: str | os.PathLike) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


class PB:
    def __init__(self, url: str, email: str = "", password: str = ""):
        self.url = url.rstrip("/")
        self.token = ""
        if email:
            data = self.req("POST", "/api/collections/_superusers/auth-with-password",
                            {"identity": email, "password": password})
            self.token = data["token"]

    @property
    def is_local(self) -> bool:
        host = urllib.parse.urlparse(self.url).hostname or ""
        return host in ("127.0.0.1", "localhost", "::1")

    def req(self, method: str, path: str, body=None, query: dict | None = None):
        url = self.url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(url, data=data, method=method)
        r.add_header("User-Agent", UA)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        if self.token:
            r.add_header("Authorization", self.token)
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            sys.exit(f"[HTTP {e.code}] {method} {path}: {e.read().decode(errors='replace')[:800]}")
        return json.loads(raw) if raw else None

    # --- collections (schema) ---
    def collections(self) -> list[dict]:
        return self.req("GET", "/api/collections", query={"perPage": 500})["items"]

    def collection(self, name: str) -> dict | None:
        for c in self.collections():
            if c["name"] == name:
                return c
        return None

    def create_collection(self, col: dict) -> dict:
        return self.req("POST", "/api/collections", col)

    def update_collection(self, name_or_id: str, patch: dict) -> dict:
        return self.req("PATCH", f"/api/collections/{name_or_id}", patch)

    # --- records ---
    def records(self, collection: str, filter: str = "", fields: str = "", sort: str = "") -> list[dict]:
        out, page = [], 1
        while True:
            q = {"page": page, "perPage": 500}
            if filter:
                q["filter"] = filter
            if fields:
                q["fields"] = fields
            if sort:
                q["sort"] = sort
            data = self.req("GET", f"/api/collections/{collection}/records", query=q)
            out += data["items"]
            if page >= data["totalPages"]:
                return out
            page += 1

    def update_record(self, collection: str, rid: str, patch: dict) -> dict:
        return self.req("PATCH", f"/api/collections/{collection}/records/{rid}", patch)


def backup_collection(pb: PB, name: str) -> Path | None:
    """Save the current definition of a collection before changing it. Returns the file path."""
    col = pb.collection(name)
    if col is None:
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    where = "local" if pb.is_local else "prod"
    path = BACKUP_DIR / f"{ts}_{where}_{name}.json"
    path.write_text(json.dumps(col, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def target_from_env() -> tuple[str, str, str]:
    env = dict(os.environ)
    if env.get("PB_ENV_FILE"):
        f = load_env_file(env["PB_ENV_FILE"])
        url = (f.get("SITE_API_URL") or "").removesuffix("/").removesuffix("/api")
        return url, f.get("PB_SUPERUSER_EMAIL", ""), f.get("PB_SUPERUSER_PASSWORD", "")
    return (env.get("PB_URL") or LOCAL_URL,
            env.get("PB_ADMIN_EMAIL") or LOCAL_ADMIN_EMAIL,
            env.get("PB_ADMIN_PASSWORD") or LOCAL_ADMIN_PASSWORD)


def connect(description: str) -> tuple[PB, argparse.Namespace]:
    """Standard CLI for a schema/data script: dry-run unless --apply; prints the target first."""
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    args = ap.parse_args()
    url, email, password = target_from_env()
    if not (url and email and password):
        sys.exit("[FATAL] no target: set PB_URL/PB_ADMIN_* or PB_ENV_FILE")
    pb = PB(url, email, password)
    mode = "APPLY" if args.apply else "dry-run"
    where = "local dev DB" if pb.is_local else "PRODUCTION"
    print(f"== {mode} against {pb.url} ({where})")
    return pb, args
