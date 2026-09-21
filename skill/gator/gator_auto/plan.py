"""Plan validation, canonicalisation and persistence.

Planner output is untrusted. Everything here fails closed: an unknown field is
a refusal rather than an ignored extra, because an ignored extra is exactly how
a `worker_cmd` or `verify` key would reach execution. Nothing model-generated
is ever evaluated.
"""
import hashlib
import json
import os
import re
import tempfile

from . import scope
from .repo import MAX_CANDIDATES, Refusal

# Exactly the keys a candidate may carry. The controller — not the planner —
# assigns repository identity, hashes, target binding, role, budgets, verifier
# configuration and run ids (spec section 6).
ALLOWED = frozenset({
    "id", "source_ref", "title", "task", "scope", "acceptance",
    "depends_on", "benefit", "clarity", "boundedness", "risk", "rationale",
})
REQUIRED = ALLOWED

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# C0 and C1, tab and newline included: a task is prose, not a control stream.
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
RISKS = frozenset({"normal", "review_required", "disallowed"})
SCORE_RANGE = {"benefit": (0, 3), "clarity": (0, 2), "boundedness": (0, 2)}



def validate_scope(patterns):
    """The planner's view of the matcher: same grammar, no whole-repo escape.

    A human may type `**` and decline scoping; a model may not, so this is
    `scope.check_pattern` with `allow_unscoped` left false.
    """
    if not isinstance(patterns, list) or not patterns:
        raise Refusal("candidate_bad_scope", "scope must be a non-empty list of patterns")
    out = []
    for pattern in patterns:
        try:
            out.append(scope.check_pattern(pattern))
        except scope.ScopeError as bad:
            code = ("candidate_scope_root" if "whole-repository" in str(bad)
                    else "candidate_bad_scope")
            raise Refusal(code, str(bad))
    return out


def safe_text(value, limit=200):
    """Make planner-supplied text safe to print and to store.

    A control character can erase the line a tool just printed and substitute
    the model's own, which is finding 6 of the 2026-09-20 review. Validated
    fields are refused outright for containing them; this is for the values that
    are reported *because* validation failed, where refusing is not an option
    and the raw bytes must still never reach a terminal or a manifest.
    """
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    rendered = CONTROL_CHARS.sub(lambda m: "\\x%02x" % ord(m.group()), text)
    return rendered[:limit]


def validate_candidates(raw, limits):
    if not isinstance(raw, dict):
        raise Refusal("planner_invalid_json", "the planner must return a JSON object")
    candidates = raw.get("candidates")
    if not isinstance(candidates, list):
        raise Refusal("planner_invalid_json", "the planner must return a 'candidates' list")
    if len(candidates) > MAX_CANDIDATES:
        raise Refusal(
            "too_many_candidates",
            f"{len(candidates)} candidates, over the {MAX_CANDIDATES} limit",
        )

    seen = set()
    out = []
    unusable = []
    for candidate in candidates:
        try:
            out.append(_validate_one(candidate, seen))
        except Refusal as bad:
            # One unusable candidate must not destroy a plan that judged the
            # rest correctly. Asking the planner to rate *every* item means
            # being sent items that cannot be built — an undesigned task
            # naming no files, say — and for a command that only recommends,
            # the safe answer is to drop that one and say why, not to refuse
            # the whole answer. Dropped candidates can never be selected, so
            # nothing unvalidated reaches a worker.
            # Everything here comes off the planner's JSON *having failed
            # validation*, so it is the one place unchecked model text enters a
            # structure that gets printed and stored. Render it rather than
            # echo it: an id of "x\x1b[2K\rrejected other-id: fine" would
            # otherwise erase the rejection line and forge its own.
            unusable.append({
                "id": safe_text(candidate.get("id")) if isinstance(candidate, dict) else None,
                "reason": bad.code,
                "detail": safe_text(bad.message),
            })
    return out, unusable


def _validate_one(candidate, seen):
    for candidate in (candidate,):
        if not isinstance(candidate, dict):
            raise Refusal("planner_invalid_json", "each candidate must be a JSON object")

        # The allowlist is checked first, before any value is read: an extra
        # key is a refusal, never something quietly dropped.
        extra = set(candidate) - ALLOWED
        if extra:
            raise Refusal(
                "candidate_unknown_field",
                f"candidate carries fields the contract does not allow: {sorted(extra)}",
            )
        missing = REQUIRED - set(candidate)
        if missing:
            raise Refusal("candidate_missing_field", f"candidate is missing {sorted(missing)}")

        cid = candidate["id"]
        if not isinstance(cid, str) or not ID_RE.match(cid):
            raise Refusal("candidate_bad_id", f"candidate id is not a safe slug: {cid!r}")
        if cid in seen:
            raise Refusal("candidate_duplicate_id", f"two candidates share the id {cid!r}")

        for key, (low, high) in SCORE_RANGE.items():
            value = candidate[key]
            if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
                raise Refusal(
                    "candidate_bad_score",
                    f"{cid}.{key} must be an integer in {low}..{high}, got {value!r}",
                )

        if candidate["risk"] not in RISKS:
            raise Refusal(
                "candidate_bad_risk",
                f"{cid}.risk must be one of {sorted(RISKS)}, got {candidate['risk']!r}",
            )

        for key in ("source_ref", "title", "task", "rationale"):
            if not isinstance(candidate[key], str):
                raise Refusal("candidate_missing_field", f"{cid}.{key} must be a string")
            # Free text reaches a terminal. An ESC sequence lets the model erase
            # the line the tool just printed and substitute its own — including
            # a forged "bindings still hold". Refuse at validation so the stored
            # manifest is clean too, not just today's rendering.
            if CONTROL_CHARS.search(candidate[key]):
                raise Refusal(
                    "candidate_control_characters",
                    f"{cid}.{key} contains control characters, which can rewrite "
                    "terminal output. Plain text only.",
                )

        for item in candidate["acceptance"] if isinstance(candidate["acceptance"], list) else []:
            if isinstance(item, dict):
                for value in item.values():
                    if isinstance(value, str) and CONTROL_CHARS.search(value):
                        raise Refusal(
                            "candidate_control_characters",
                            f"{cid}.acceptance contains control characters",
                        )

        acceptance = candidate["acceptance"]
        if not isinstance(acceptance, list):
            raise Refusal("candidate_missing_field", f"{cid}.acceptance must be a list")
        for item in acceptance:
            if not isinstance(item, dict) or set(item) != {"id", "criterion"}:
                raise Refusal(
                    "candidate_missing_field",
                    f"{cid}.acceptance items must be exactly {{id, criterion}}",
                )

        depends = candidate["depends_on"]
        if not isinstance(depends, list) or not all(isinstance(d, str) for d in depends):
            raise Refusal("candidate_missing_field", f"{cid}.depends_on must be a list of ids")

        normalised = dict(candidate)
        normalised["scope"] = validate_scope(candidate["scope"])
        seen.add(cid)
        return normalised


# --------------------------------------------------------------- persistence

# Fields assigned when the manifest is saved; excluded from the hash, because
# the hash is what identifies them.
DERIVED = ("plan_id", "plan_sha256")


def canonical(plan):
    """Canonical bytes. Key order and whitespace cannot change the hash."""
    body = {k: v for k, v in plan.items() if k not in DERIVED}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def plan_hash(plan):
    return hashlib.sha256(canonical(plan)).hexdigest()


def plan_id(plan):
    """Deterministic: replanning identical inputs is visibly the same plan."""
    return "p" + plan_hash(plan)[:16]


def plans_dir(store):
    return os.path.join(store, "auto", "plans")


def save(store, plan):
    """Write the canonical bytes, with identity in the filename and a sidecar.

    The file *is* the canonical bytes, so `sha256sum` on it reproduces the
    recorded digest without this tool. plan_id and plan_sha256 are therefore
    not stored inside the document — they identify it from outside.
    """
    directory = plans_dir(store)
    os.makedirs(directory, exist_ok=True)
    digest = plan_hash(plan)
    pid = "p" + digest[:16]

    body = canonical(plan)
    path = os.path.join(directory, f"{pid}.json")
    fd, temp = tempfile.mkstemp(dir=directory)
    with os.fdopen(fd, "wb") as handle:
        handle.write(body)
    os.replace(temp, path)

    # sha256sum-compatible, so the hash can be checked without this tool.
    with open(os.path.join(directory, f"{pid}.sha256"), "w") as handle:
        handle.write(f"{digest}  {path}\n")

    plan["plan_id"] = pid
    plan["plan_sha256"] = digest
    return pid


def load(store, pid):
    directory = plans_dir(store)
    path = os.path.join(directory, f"{pid}.json")
    sidecar = os.path.join(directory, f"{pid}.sha256")
    if not os.path.exists(path):
        raise Refusal("plan_not_found", f"no stored plan {pid}")
    with open(path, "rb") as handle:
        raw = handle.read()

    stale = Refusal(
        "stale_plan_hash",
        f"stored plan {pid} has been modified since it was written; "
        "approval was bound to the original",
    )
    try:
        plan = json.loads(raw)
    except ValueError:
        raise stale

    # The bytes on disk must still hash to what the sidecar recorded, and the
    # content must still hash to the id it is filed under. An edited plan is
    # not the plan anyone approved.
    digest = hashlib.sha256(raw).hexdigest()
    if not os.path.exists(sidecar):
        raise stale
    with open(sidecar) as handle:
        recorded = handle.read().split()[0]
    if digest != recorded or plan_hash(plan) != digest or not pid == "p" + digest[:16]:
        raise stale

    plan["plan_id"] = pid
    plan["plan_sha256"] = digest
    return plan


def listing(store):
    directory = plans_dir(store)
    if not os.path.isdir(directory):
        return []
    out = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(directory, name)
        try:
            with open(path) as handle:
                plan = json.load(handle)
        except ValueError:
            continue
        out.append({
            "plan_id": name[:-len(".json")],
            "source": plan.get("source", {}).get("path"),
            "selected_id": plan.get("selected_id"),
            "target_ref": plan.get("target_ref"),
            "written_at": os.path.getmtime(path),
        })
    out.sort(key=lambda p: p["written_at"], reverse=True)
    return out


def check_binding(plan, facts, source, policy):
    """Why this plan can no longer be acted on, or None when it still holds."""
    # Most specific first. Committing a source edit also moves HEAD, so both
    # stale_source and stale_target are true; the source is the actionable one.
    if plan.get("repo_id") != facts["repo_id"]:
        return "wrong_repository"
    if plan.get("source", {}).get("blob_sha") != source["blob_sha"]:
        return "stale_source"
    if plan.get("policy_hash") != policy:
        return "stale_policy"
    if plan.get("target_ref") != facts["target_ref"]:
        return "stale_target"
    if plan.get("base_sha") != facts["base_sha"]:
        return "stale_target"
    return None


# ------------------------------------------------------------ completed work

def ledger_path(store):
    return os.path.join(store, "auto", "completed.json")


def ledger(store):
    try:
        with open(ledger_path(store)) as handle:
            return json.load(handle).get("entries", [])
    except Exception:
        return []


def ledger_lookup(store, source_ref):
    for entry in ledger(store):
        if entry.get("source_ref") == source_ref:
            return entry
    return None


def mark_completed(candidates, store, source_blob_sha):
    """Attach completion provenance — a controller field, never the planner's.

    Spec section 6 pins the source-contract revision to the whole source blob,
    which is conservative to the point of bluntness: one typo fixed in the
    source re-opens every candidate in it, finished ones included. Rather than
    parse document structure in v1, carry the provenance forward. A candidate
    completed under *this* revision is ineligible; one completed under an
    earlier revision stays eligible, sorts last, and is called out for review.
    Neither silently dropped nor silently re-selected.
    """
    for candidate in candidates:
        entry = ledger_lookup(store, candidate["source_ref"])
        if entry is None:
            candidate["previously_completed"] = None
            continue
        candidate["previously_completed"] = {
            "run_id": entry.get("run_id"),
            "source_blob_sha": entry.get("source_blob_sha"),
            "same_revision": entry.get("source_blob_sha") == source_blob_sha,
        }
    return candidates


# ------------------------------------------------------------- raw responses

def _write_private(path, text):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=directory)
    with os.fdopen(fd, "w") as handle:
        handle.write(text)
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def keep_response(store, text):
    """The last thing the planner said, whatever happened next.

    Written before validation, because a response that fails to validate is the
    one worth reading. It can quote the source, so it is 0600 like the rest of
    the store.
    """
    _write_private(os.path.join(store, "auto", "last-response.txt"), text)


def archive_response(store, plan_id, text):
    """The response that produced this plan, filed under the plan's own id."""
    _write_private(os.path.join(plans_dir(store), f"{plan_id}.raw.txt"), text)
