#!/usr/bin/env bash
# Exchange branches with a second agent's clone (Codex) on the same machine.
#
#   scripts/codex.sh sync <dir>   hand our main to the clone (it rebases its `codex` branch on it)
#   scripts/codex.sh pull <dir>   fetch its `codex` branch, run the gates, show what changed,
#                                 ask, merge into main, then sync back
#
# The gates run from THIS repo's copy of the rules, never the clone's: the agent can edit its
# own hook. Files that execute on the maintainer's machine or production are listed separately so
# they get read before merging. Nothing is pushed to GitHub and nothing is deployed here.
set -euo pipefail

cmd=${1:-}
dir=${2:-}
branch=codex
ref=refs/remotes/codex/$branch

die() { echo "codex: $*" >&2; exit 1; }
[ -n "$dir" ] || die "CODEX_DIR is not set (put CODEX_DIR := /path/to/clone in deploy.mk)"
git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || die "$dir is not a git clone"
cd "$(git rev-parse --show-toplevel)"

sync() {
  # updateInstead is set in the clone, so this also refreshes its checkout if it sits on main.
  git push --quiet "$dir" main:main && echo "codex: main handed to $dir (tell Codex: git rebase main)"
}

pull() {
  [ "$(git branch --show-current)" = main ] || die "switch to main first"
  git diff --quiet && git diff --cached --quiet || die "commit or stash your own changes first"
  git fetch --quiet "$dir" "+$branch:$ref" || die "no '$branch' branch in $dir"

  local n
  n=$(git rev-list --count "main..$ref")
  if [ "$n" = 0 ]; then echo "codex: nothing new on '$branch'"; return 0; fi

  echo "== $n new commit(s) from Codex:"
  git log --oneline "main..$ref"
  echo
  git diff --stat "main...$ref"
  echo

  local fail=0 files
  files=$(git diff --name-only --diff-filter=ACMR "main...$ref")

  # Gate 1: Cyrillic (same allowlist as the pre-commit hook, taken from main).
  local allow
  allow=$(git show main:.cyrillic-allow 2>/dev/null | grep -v '^#' | sed '/^$/d' || true)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -n "$allow" ] && printf '%s\n' "$f" | grep -qE -f <(printf '%s\n' "$allow"); then continue; fi
    if git show "$ref:$f" | grep -qIP '[\x{0400}-\x{04FF}]'; then echo "GATE: Cyrillic in $f"; fail=1; fi
  done <<< "$files"

  # Gate 2: the deploy host must not appear.
  local host
  host=$(sed -n 's/^SSH_HOST *:*= *[^@]*@\{0,1\}\(.*\)$/\1/p' deploy.mk 2>/dev/null | tr -d ' ')
  if [ -n "$host" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if git show "$ref:$f" | grep -qF "$host"; then echo "GATE: deploy host in $f"; fail=1; fi
    done <<< "$files"
  fi

  # Gate 3: secrets in the new commits.
  local gl
  gl=$(command -v gitleaks || echo "$HOME/go/bin/gitleaks")
  if [ -x "$gl" ]; then
    "$gl" git --no-banner --redact --log-opts="main..$ref" . >/dev/null 2>&1 \
      || { echo "GATE: gitleaks found secrets (run: $gl git --log-opts=main..$ref .)"; fail=1; }
  fi
  [ "$fail" = 0 ] || die "gates failed, nothing merged"

  # Files that run on this machine or against production: read these before saying yes.
  local risky
  risky=$(printf '%s\n' "$files" | grep -E '^(Makefile|scripts/|\.githooks/|\.gitignore|\.cyrillic-allow|\.gitleaks\.toml|package\.json|package-lock\.json|bun\.lockb|go\.(mod|sum)|vite\.config|playwright\.config|e2e/global-|pb_hooks/|pb_scripts/|semantic-search/.*(Makefile|\.service|requirements))' || true)
  if [ -n "$risky" ]; then
    echo "!! These files run on your machine or production — read them first:"
    printf '   %s\n' $risky
    echo "   git diff main...$ref -- <file>"
    echo
  fi

  local a
  read -r -p "Merge these $n commit(s) into main? [y/N] " a < /dev/tty
  [ "$a" = y ] || [ "$a" = Y ] || die "not merged"

  git merge --ff-only --quiet "$ref" 2>/dev/null \
    || git merge --no-ff --quiet -m "Merge Codex branch" "$ref" \
    || die "merge conflict: resolve it, or git merge --abort"
  echo "codex: merged. Not pushed: git push when you are happy."
  sync
}

case "$cmd" in
  sync) sync ;;
  pull) pull ;;
  *) die "usage: scripts/codex.sh sync|pull <dir>" ;;
esac
