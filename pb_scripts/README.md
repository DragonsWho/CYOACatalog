# pb_scripts — PocketBase schema and data changes

Production schema is never changed from app code or by hand-editing `pb_schema.json`. A change is a
small Python script here: written and tested against the local DB, reviewed by the maintainer, then
applied to production by the maintainer.

## Writing a script

Copy `example_add_field.py` and name it `YYYY-MM-DD_what_it_does.py`. Conventions:

- stdlib only (`pblib.py` is the client); no venv, no pip;
- dry-run by default: print exactly what would change; write only with `--apply`;
- idempotent: a second run finds nothing to do and says so;
- `backup_collection()` before changing a collection's schema;
- change only what the task needs: patch the fields/rules you touch, never re-upload a whole
  collection (that would overwrite anything changed on production since your snapshot);
- a docstring on top: what it changes, why, how to undo.

## Testing locally

```bash
make seed                                           # fresh local DB (optional)
make dev                                            # local server on :8090
make pb-local S=pb_scripts/<file>.py                # dry-run
make pb-local S=pb_scripts/<file>.py APPLY=1        # apply locally
make pb-local S=pb_scripts/<file>.py                # again: must report nothing to do
```

Then check the site on :8090 and run `make check`. Commit the script; mention in the commit message
that it must be applied to production.

## Applying to production (maintainer)

```bash
make pb-prod S=pb_scripts/<file>.py            # dry-run against production
make pb-prod S=pb_scripts/<file>.py APPLY=1    # asks for "yes", then refreshes pb_schema.json
```

Commit the refreshed `pb_schema.json` together with (or right after) the script. Backups of changed
collections land in `pb_scripts/.backups/` (not in git).
