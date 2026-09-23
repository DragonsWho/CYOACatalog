#!/usr/bin/env python3
"""Example: add an optional text field `example_note` to `tags`.

Template for schema scripts; copy it, don't apply it. Why: <the reason for the change>.
Undo: remove the field in the admin UI (/_/ → tags → fields), or PATCH the backup back.

  make pb-local S=pb_scripts/example_add_field.py [APPLY=1]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pblib import backup_collection, connect  # noqa: E402

COLLECTION = "tags"
FIELD = {"name": "example_note", "type": "text", "required": False, "max": 500}


def main() -> None:
    pb, args = connect(__doc__.splitlines()[0])
    col = pb.collection(COLLECTION)
    if col is None:
        sys.exit(f"[FATAL] no collection {COLLECTION}")

    if any(f["name"] == FIELD["name"] for f in col["fields"]):
        print(f"{COLLECTION}.{FIELD['name']} already exists — nothing to do")
        return

    print(f"will add {COLLECTION}.{FIELD['name']} ({FIELD['type']})")
    if not args.apply:
        print("dry-run: nothing written (add --apply)")
        return

    print("backup:", backup_collection(pb, COLLECTION))
    # PATCH with the full field list: PocketBase replaces `fields` as a whole, so keep the existing
    # ones (with their ids) and append the new field.
    pb.update_collection(col["id"], {"fields": col["fields"] + [FIELD]})
    print("done")


if __name__ == "__main__":
    main()
