"""Command implementations behind `gator auto`."""
import json
import os
import sys

from . import SCHEMA_VERSION
from . import budget
from .plan import (
    check_binding,
    listing,
    load,
    mark_completed,
    save,
    validate_candidates,
)
from .planner import build_prompt, extract_json, invoke, resolve_planner_cmd
from .rank import GATES, select
from .repo import (
    MAX_CANDIDATES,
    baseline_check,
    require_approved_verifier,
    verification_profile,
    MAX_SOURCE_BYTES,
    PLANNER_TIMEOUT,
    Refusal,
    load_source,
    policy_hash,
    repo_facts,
    secure_store,
    tracked_context,
)
from .rank import min_task_chars


def emit(payload, as_json):
    if as_json:
        json.dump(payload, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    return 0


def effective_policy(env):
    """The values an approval is bound to. Drift here invalidates a plan."""
    return {
        "gates": GATES,
        "min_task_chars": min_task_chars(),
        "max_candidates": MAX_CANDIDATES,
        "max_source_bytes": MAX_SOURCE_BYTES,
    }


def resolve_role(env, name):
    var = f"GATOR_ROLE_{name}"
    return env.get(var, "")


def plan(opts):
    env = os.environ
    if not opts["from"]:
        raise Refusal("no_source", "name the source to plan from, with --from <file>")

    facts = repo_facts(opts["repo"])
    secure_store(opts["store"])
    source = load_source(facts["root"], opts["from"])

    # Budget first, so a refusal costs nothing. Planning is a model call plus a
    # full verifier run; an agent retrying on refusal must not be able to spend
    # either without limit (spec section 4).
    budget.check(opts["store"], env)

    with budget.SingleFlight(opts["store"]):
        # The verifier gate comes before the planner call: a recommendation
        # nobody can act on is not worth a planner call, let alone a worker.
        profile = require_approved_verifier(
            verification_profile(facts["root"], opts["store"], env)
        )
        if opts["no_baseline"]:
            baseline = {"checked": False, "rc": None}
        else:
            baseline = budget.cached_baseline(
                opts["store"], facts["base_sha"], profile["command_sha256"]
            )
            if baseline is None:
                baseline = baseline_check(
                    facts["root"],
                    profile["command"],
                    int(env.get("GATOR_VERIFY_TIMEOUT", "900")),
                )
                budget.remember_baseline(
                    opts["store"], facts["base_sha"], profile["command_sha256"], baseline
                )

        files, total = tracked_context(facts["root"])
        prompt = build_prompt(source, files, total)

        model = resolve_role(env, "planner") or resolve_role(env, "heavy")
        cmd = resolve_planner_cmd(env, model)
        timeout = int(env.get("GATOR_PLANNER_TIMEOUT", PLANNER_TIMEOUT))

        budget.record(opts["store"], env)
        raw = extract_json(invoke(cmd, prompt, timeout))

    candidates = mark_completed(
        validate_candidates(raw, {}), opts["store"], source["blob_sha"]
    )
    chosen = select(candidates, {})

    result = {
        "schema_version": SCHEMA_VERSION,
        "repo_id": facts["repo_id"],
        "target_ref": facts["target_ref"],
        "base_sha": facts["base_sha"],
        "source": {"path": source["path"], "blob_sha": source["blob_sha"]},
        "policy_hash": policy_hash(effective_policy(env)),
        "verification_profile": profile,
        "baseline": baseline,
        "selected_id": chosen["selected_id"],
        "candidates": chosen["candidates"],
        "rejected": chosen["rejected"],
    }
    save(opts["store"], result)
    if opts["json"]:
        return emit(result, True)
    render(result)
    return 0


def render(result):
    selected = result["selected_id"]
    if selected is None:
        print("No suitable work in this source. That is a result, not a failure.")
    else:
        chosen = next(c for c in result["candidates"] if c["id"] == selected)
        print(f'SELECTED "{chosen["id"]}" — {chosen["title"]}')
        print(f'  from   {chosen["source_ref"]}')
        print(f'  scope  {" ".join(chosen["scope"])}')
        print(f'  why    {chosen["rationale"]}')
        prior = chosen.get("previously_completed")
        if prior:
            print(
                f'  NOTE   previously completed as {prior["run_id"]} under an earlier '
                f'revision of {result["source"]["path"]} — review before approving'
            )
    for item in result["rejected"]:
        print(f'  rejected {item["id"]}: {item["reason"]} — {item["rationale"]}')


def show(opts):
    if not opts["plan"]:
        raise Refusal("no_plan", "name the plan to show, with --plan <plan-id>")
    stored = load(opts["store"], opts["plan"])

    # Re-derive the current facts and say whether the plan still binds to them.
    # A plan that no longer binds is shown, not hidden: the point is to explain
    # why it cannot be acted on.
    facts = repo_facts(opts["repo"])
    try:
        source = load_source(facts["root"], stored["source"]["path"])
        reason = check_binding(stored, facts, source, policy_hash(effective_policy(os.environ)))
    except Refusal as missing:
        reason = missing.code

    stored["bindings"] = {"valid": reason is None, "reason": reason}
    if opts["json"]:
        return emit(stored, True)

    render(stored)
    if reason:
        print(f"\nThis plan no longer applies: {reason}. Re-plan before acting on it.")
    else:
        print("\nBindings still hold: repository, target HEAD, source blob and policy.")
    return 0


def plans(opts):
    rows = listing(opts["store"])
    if opts["json"]:
        return emit({"schema_version": SCHEMA_VERSION, "plans": rows}, True)
    if not rows:
        print("no plans stored yet")
        return 0
    for row in rows:
        chosen = row["selected_id"] or "(no candidate)"
        print(f'{row["plan_id"]}  {row["source"]}  → {chosen}')
    return 0
