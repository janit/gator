"""The scope matcher: one implementation, used to validate and to enforce.

`--scope` was prose in the worker's prompt and nothing compared it to the
diff, so a unit could write anywhere in its worktree and merge (spec section
2, finding 2). Validation and enforcement must use the same matcher or the
thing a planner is allowed to declare will drift from the thing a worker is
held to.

Two audiences, one grammar, one deliberate difference:

  * A **human** typing `--scope` may decline scoping with `**`, which matches
    everything. That is an explicit choice, made by someone who can be asked.
  * A **planner** may not: `validate_scope` refuses `**` from a model, because
    a whole-repository scope from something being judged is not a scope.
"""
import re

FORBIDDEN_ROOTS = (".git", ".gator")
UNSCOPED = "**"


class ScopeError(ValueError):
    """A pattern this grammar does not accept."""


def parse(text):
    """Split a human-written scope string. Commas or whitespace, either way."""
    return [p for p in re.split(r"[,\s]+", (text or "").strip()) if p]


def check_pattern(pattern, allow_unscoped=False):
    """Normalise one pattern, or raise ScopeError saying why not."""
    if not isinstance(pattern, str) or not pattern:
        raise ScopeError(f"scope entry must be a non-empty string: {pattern!r}")
    if pattern == UNSCOPED:
        if allow_unscoped:
            return UNSCOPED
        raise ScopeError("a whole-repository scope is not a scope")
    if pattern.startswith("/") or ":" in pattern:
        raise ScopeError(f"scope must be repository-relative: {pattern}")
    if pattern in ("*", ".", "./", "**/*"):
        raise ScopeError("a whole-repository scope is not a scope")

    body = pattern[:-3] if pattern.endswith("/**") else pattern
    if not body or body.startswith("/"):
        raise ScopeError(f"scope names no directory: {pattern}")
    parts = body.split("/")
    if any(p in ("..", "") for p in parts):
        raise ScopeError(f"scope escapes the repository: {pattern}")
    if parts[0] in FORBIDDEN_ROOTS:
        raise ScopeError(f"scope may not name {parts[0]}: {pattern}")
    if "*" in body:
        raise ScopeError(f"the only wildcard is a trailing /**: {pattern}")
    return pattern


def matches(path, patterns):
    """Is this repository-relative path inside the declared scope?"""
    for pattern in patterns:
        if pattern == UNSCOPED:
            return True
        if pattern.endswith("/**"):
            prefix = pattern[:-2]           # keep the trailing slash
            if path.startswith(prefix):
                return True
        elif path == pattern:
            return True
    return False


def violations(paths, patterns):
    """Every changed path the scope does not cover, in a stable order."""
    return sorted(p for p in set(paths) if not matches(p, patterns))
