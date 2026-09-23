"""Repository facts, preconditions and bounded source loading.

Every refusal carries a stable reason code: the controller's callers are
programs, and a program cannot branch on prose.
"""
import hashlib
import json
import os
import subprocess

MAX_SOURCE_BYTES = 128 * 1024
MAX_PLANNER_INPUT_BYTES = 256 * 1024
MAX_PLANNER_OUTPUT_BYTES = 256 * 1024
MAX_CANDIDATES = 20
PLANNER_TIMEOUT = 120


def secure_store(store):
    """0700 the store and 0600 its files.

    It holds the task text, the model's output and verifier logs, which on a
    shared host means another local user could read every delegated prompt and
    whatever a failing test printed. Two files were already private only
    because mkstemp happens to create them that way.
    """
    try:
        os.chmod(store, 0o700)
    except OSError:
        return
    for root, dirs, files in os.walk(store):
        for name in dirs:
            try:
                os.chmod(os.path.join(root, name), 0o700)
            except OSError:
                pass
        for name in files:
            try:
                os.chmod(os.path.join(root, name), 0o600)
            except OSError:
                pass


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def git(root, *args, check=True):
    proc = subprocess.run(
        ["git", "-C", root, *args], capture_output=True, text=True
    )
    if check and proc.returncode != 0:
        raise Refusal("git_failed", f"git {' '.join(args)}: {proc.stderr.strip()}")
    return proc


def repo_facts(root):
    """Facts about the repository, or a refusal naming why it cannot be used."""
    common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
    if git(root, "rev-parse", "--is-bare-repository").stdout.strip() == "true":
        raise Refusal("bare_repo", "a bare repository has no working tree to plan against")
    if git(root, "rev-parse", "--show-superproject-working-tree").stdout.strip():
        raise Refusal("unsupported_worktree", "submodule execution is not supported in v1")

    head = git(root, "symbolic-ref", "-q", "HEAD", check=False)
    if head.returncode != 0 or not head.stdout.strip():
        raise Refusal("detached_head", "HEAD is detached; a plan must bind to a named branch")

    dirty = git(root, "status", "--porcelain", "--", ".", ":(exclude).gator").stdout.strip()
    return {
        "root": root,
        # Identity of this checkout. A clone has a different common dir, so a
        # plan cannot be carried between repositories (spec section 9.5).
        "repo_id": hashlib.sha256(os.path.realpath(common).encode()).hexdigest()[:16],
        "target_ref": head.stdout.strip(),
        "base_sha": git(root, "rev-parse", "HEAD").stdout.strip(),
        "dirty": bool(dirty),
    }


def load_source(root, rel):
    """The committed source, pinned by blob SHA rather than by working-tree bytes."""
    if os.path.isabs(rel):
        raise Refusal("source_outside_repo", f"the source path must be repository-relative: {rel}")
    normal = os.path.normpath(rel)
    if normal.startswith("..") or normal.startswith("/"):
        raise Refusal("source_outside_repo", f"the source path escapes the repository: {rel}")

    full = os.path.join(root, normal)
    if os.path.islink(full):
        target = os.path.realpath(full)
        if not target.startswith(os.path.realpath(root) + os.sep):
            raise Refusal("source_symlink_escape", f"the source symlink escapes the repository: {rel}")

    listed = git(root, "cat-file", "-e", f"HEAD:{normal}", check=False)
    if listed.returncode != 0:
        if not os.path.exists(full):
            raise Refusal("source_missing", f"no such source in the repository: {rel}")
        raise Refusal(
            "source_not_committed",
            f"{rel} is not committed; the gator plans from committed HEAD, not your working tree",
        )

    blob_sha = git(root, "rev-parse", f"HEAD:{normal}").stdout.strip()
    raw = subprocess.run(
        ["git", "-C", root, "cat-file", "blob", blob_sha], capture_output=True
    ).stdout
    if len(raw) > MAX_SOURCE_BYTES:
        raise Refusal(
            "source_too_large",
            f"{rel} is {len(raw)} bytes, over the {MAX_SOURCE_BYTES} limit. "
            "Split it or name a smaller source; it will not be truncated silently.",
        )
    return {
        "path": normal,
        "blob_sha": blob_sha,
        "text": raw.decode("utf-8", errors="replace"),
        "bytes": len(raw),
    }


def tracked_context(root, limit=400):
    """A bounded sample of tracked paths, and the true total.

    Returns (sample, total). One walk: the caller needs both numbers and the
    tree can be large.
    """
    out = git(root, "ls-files", "-z").stdout
    paths = sorted(p for p in out.split("\0") if p)
    return paths[:limit], len(paths)


def policy_hash(values):
    """A hash over the effective policy, so drift invalidates an approval."""
    canonical = json.dumps(values, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


# ------------------------------------------------------------- verification

def verification_profile(root, store, env):
    """The verifier, and whether a human actually approved it.

    Spec section 7 requires a *user-approved* profile. Detection is the
    controller guessing what "green" means, which is exactly the thing a plan
    must not assume. So GATOR_VERIFY and .gator/verify are approval; a command
    inferred from deno.json or package.json is not.
    """
    explicit = env.get("GATOR_VERIFY", "").strip()
    if explicit:
        return _profile("environment", explicit, True)

    # .gator/verify lives in the repository, and a repository can commit it.
    # Reading it from a clone would mean `auto plan` — the command that starts
    # no worker — executing a stranger's shell during the baseline run. It
    # counts as approval only when the user says this repository is theirs.
    configured = os.path.join(store, "verify")
    if os.path.exists(configured) and env.get("GATOR_TRUST_REPO_CONFIG") == "1":
        with open(configured) as handle:
            command = handle.read().strip()
        if command:
            return _profile("file", command, True)

    return _profile("none", "", False)


def _profile(name, command, approved):
    return {
        "name": name,
        "command": command,
        "command_sha256": hashlib.sha256(command.encode()).hexdigest(),
        "approved": approved,
    }


def require_approved_verifier(profile):
    if not profile["approved"]:
        raise Refusal(
            "verifier_not_approved",
            "no approved verification profile. Auto will not fall back to "
            "merge-on-clean; a command detected from the project is the "
            "controller guessing, and one committed to this repository is a "
            "stranger's guess. Set GATOR_VERIFY, or write the command to "
            ".gator/verify and set GATOR_TRUST_REPO_CONFIG=1 if this "
            "repository is yours.",
        )
    return profile


def baseline_check(root, command, timeout=900):
    """Run the verifier on a clean checkout of HEAD, in a throwaway worktree.

    Recommending work into a repository that does not already build is not a
    recommendation anyone can act on (spec section 7).
    """
    import shutil
    import tempfile as _tempfile

    # A run killed mid-verifier never reaches the `finally` below, and leaves
    # a worktree registered against a temp directory that is later cleaned
    # away. Pruning first keeps those from accumulating in .git/worktrees.
    git(root, "worktree", "prune", check=False)
    scratch = _tempfile.mkdtemp(prefix="gator-baseline-")
    work = os.path.join(scratch, "tree")
    try:
        git(root, "worktree", "add", "-q", "--detach", work, "HEAD")
        try:
            proc = subprocess.run(
                ["bash", "-c", command],
                cwd=work,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            rc = proc.returncode
            tail = (proc.stdout + proc.stderr)[-2000:]
        except subprocess.TimeoutExpired:
            rc, tail = 124, f"the baseline verifier did not finish within {timeout}s"
    finally:
        git(root, "worktree", "remove", "--force", work, check=False)
        shutil.rmtree(scratch, ignore_errors=True)

    if rc != 0:
        raise Refusal(
            "baseline_red",
            f"the approved verifier fails on HEAD before any work is done "
            f"(exit {rc}). Fix the baseline first.\n{tail.strip()[-600:]}",
        )
    return {"checked": True, "rc": rc}
