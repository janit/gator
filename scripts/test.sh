#!/usr/bin/env bash
# Run the suite with every temporary directory under one per-run root, and
# remove that root afterwards. The tests make a repository, a worktree and a
# store per case and never clean them up themselves; left in /tmp they filled a
# 124G tmpfs over a few days of runs. Node's os.tmpdir(), Python's tempfile
# and mktemp all honour TMPDIR, so this catches the workers' files too.
set -uo pipefail
root=$(mktemp -d -t gator-test-XXXXXX) || exit 1
trap 'rm -rf "$root"' EXIT
TMPDIR="$root" deno test -A "$@"
