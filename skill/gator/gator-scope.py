#!/usr/bin/env python3
"""gator-scope — compare a unit's whole diff against its declared scope.

  gator-scope.py <worktree> <base_sha> <scope>
  gator-scope.py --check <scope>      exit 2, with the reason, if unenforceable

Prints JSON: {"checked": bool, "changed": n, "violations": [paths]}.
Exit 0 whether or not there are violations; the caller decides what they mean.

Every endpoint of a rename, every deletion, every mode change and every
symlink counts, because each is a way to move work out of the declared area.
Git's output is read NUL-delimited so a path with a newline in it cannot hide.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from gator_auto import scope  # noqa: E402


def changed_paths(worktree, base_sha):
    """Every path touched between base and HEAD, both endpoints of a rename."""
    proc = subprocess.run(
        ["git", "-C", worktree, "diff", "--name-status", "-M", "-z", base_sha, "HEAD"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None

    fields = [f for f in proc.stdout.split("\0") if f != ""]
    paths, i = [], 0
    while i < len(fields):
        status = fields[i]
        # A rename or copy is followed by two paths; everything else by one.
        if status[:1] in ("R", "C"):
            paths.extend(fields[i + 1:i + 3])
            i += 3
        else:
            paths.append(fields[i + 1])
            i += 2
    return paths


def main(argv):
    # `--check <scope>`: is this scope one the grammar can enforce? Asked at
    # feed time, so a pattern like `src/*.ts` is refused before anything is
    # created, not discovered as unenforceable after the work is done.
    if argv[:1] == ["--check"]:
        patterns = scope.parse(argv[1] if len(argv) > 1 else "")
        if not patterns:
            print("scope names no files", file=sys.stderr)
            return 2
        for raw in patterns:
            try:
                scope.check_pattern(raw, allow_unscoped=True)
            except scope.ScopeError as e:
                print(f"{e}. Name files, or directories as dir/**; \"**\" declines scoping.",
                      file=sys.stderr)
                return 2
        return 0
    if len(argv) < 3:
        print(json.dumps({"checked": False, "changed": 0, "violations": []}))
        return 0
    worktree, base_sha, declared = argv[0], argv[1], argv[2]

    patterns = []
    for raw in scope.parse(declared):
        try:
            patterns.append(scope.check_pattern(raw, allow_unscoped=True))
        except scope.ScopeError:
            # A scope the grammar rejects cannot be enforced, and silently
            # treating it as "everything" would be the wrong way to fail.
            print(json.dumps({
                "checked": False, "changed": 0, "violations": [],
                "unenforceable": raw,
            }))
            return 0

    paths = changed_paths(worktree, base_sha)
    if paths is None or not patterns:
        print(json.dumps({"checked": False, "changed": 0, "violations": []}))
        return 0

    print(json.dumps({
        "checked": True,
        "changed": len(set(paths)),
        "violations": scope.violations(paths, patterns),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
