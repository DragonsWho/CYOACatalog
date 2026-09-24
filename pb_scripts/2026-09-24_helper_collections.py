#!/usr/bin/env python3
"""Create `helper_devices` and `helper_jobs` for the moderator helper app (cyoa-helper).

Why: moderators download games on their own computers with a small helper program and drive it from
the /moderator/mod-tools page. A paired helper is a `helper_devices` row (the token is stored only
as a SHA-256 hash); every download / check / upload the page asks for is a `helper_jobs` row that
the helper claims, reports progress on and finishes. Both collections are server-only: all rules
are null, the Go handlers in modkit.go read and write them through the privileged app. Without them
the binary still starts; the Mod Tools endpoints answer 503 "run the schema script".

Undo: delete `helper_jobs` first (it references `helper_devices`), then `helper_devices`, in the
admin UI (/_/). Nothing else references them.

  make pb-local S=pb_scripts/2026-09-24_helper_collections.py [APPLY=1]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pblib import connect  # noqa: E402

USERS_ID = "_pb_users_auth_"


def text(name, max_len, **kw):
    return {"name": name, "type": "text", "required": False, "max": max_len, **kw}


def json_field(name, max_size):
    return {"name": name, "type": "json", "required": False, "maxSize": max_size}


def autodates():
    return [
        {"name": "created", "type": "autodate", "onCreate": True, "onUpdate": False},
        {"name": "updated", "type": "autodate", "onCreate": True, "onUpdate": True},
    ]


def devices_payload():
    return {
        "name": "helper_devices",
        "type": "base",
        "listRule": None, "viewRule": None,
        "createRule": None, "updateRule": None, "deleteRule": None,
        "fields": [
            {"name": "user", "type": "relation", "required": True, "collectionId": USERS_ID,
             "maxSelect": 1, "cascadeDelete": True},
            text("name", 100),
            # sha256 hex of the device token; the token itself is shown to the helper once
            text("token_hash", 64, hidden=True),
            {"name": "last_seen", "type": "date", "required": False},
            {"name": "revoked", "type": "bool", "required": False},
            text("client_version", 40),
            text("platform", 40),
            *autodates(),
        ],
        "indexes": [
            "CREATE UNIQUE INDEX `idx_helper_devices_token` ON `helper_devices` (`token_hash`)",
            "CREATE INDEX `idx_helper_devices_user` ON `helper_devices` (`user`)",
        ],
    }


def jobs_payload(devices_id):
    return {
        "name": "helper_jobs",
        "type": "base",
        "listRule": None, "viewRule": None,
        "createRule": None, "updateRule": None, "deleteRule": None,
        "fields": [
            {"name": "user", "type": "relation", "required": True, "collectionId": USERS_ID,
             "maxSelect": 1, "cascadeDelete": True},
            {"name": "device", "type": "relation", "required": True, "collectionId": devices_id,
             "maxSelect": 1, "cascadeDelete": True},
            {"name": "kind", "type": "select", "required": True, "maxSelect": 1,
             "values": ["download", "import", "check", "upload"]},
            {"name": "status", "type": "select", "required": True, "maxSelect": 1,
             "values": ["queued", "running", "done", "failed", "cancelled"]},
            json_field("input", 100_000),
            json_field("progress", 20_000),
            # check report: file counts, missing files, warnings; capped by the helper
            json_field("result", 2_000_000),
            text("log", 200_000),
            text("error", 2000),
            *autodates(),
        ],
        "indexes": [
            "CREATE INDEX `idx_helper_jobs_device_status` ON `helper_jobs` (`device`, `status`)",
            "CREATE INDEX `idx_helper_jobs_user_created` ON `helper_jobs` (`user`, `created`)",
        ],
    }


def main() -> None:
    pb, args = connect(__doc__.splitlines()[0])

    devices = pb.collection("helper_devices")
    jobs = pb.collection("helper_jobs")
    if devices and jobs:
        print("helper_devices and helper_jobs already exist — nothing to do")
        return

    if not devices:
        print("will create helper_devices (server-only rules)")
    if not jobs:
        print("will create helper_jobs (server-only rules)")
    if not args.apply:
        print("dry-run: nothing written (add --apply)")
        return

    if not devices:
        devices = pb.create_collection(devices_payload())
        print("created helper_devices", devices["id"])
    if not jobs:
        jobs = pb.create_collection(jobs_payload(devices["id"]))
        print("created helper_jobs", jobs["id"])
    print("done")


if __name__ == "__main__":
    main()
