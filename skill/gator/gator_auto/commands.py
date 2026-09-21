"""Command implementations behind `gator auto`."""
import json
import os
import sys

from gator_sched import classify as classifier
from gator_sched.config import ConfigError, load as load_resources, resolution_inputs
from gator_sched.policy import resolve as resolve_resource

from . import SCHEMA_VERSION
from . import budget
from .plan import (
    archive_response,
    keep_response,
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


# The role an automatic unit runs under. The controller assigns it; the planner
# cannot. `gator feed` defaults to the same role.
AUTO_ROLE = "heavy"


def resources(opts):
    try:
        return load_resources(opts.get("config") or [])
    except ConfigError as exc:
        raise Refusal(exc.code, str(exc))


def recommend(candidates, config):
    """Controller-owned: where each selectable candidate would run, and who said so.

    After the first sign that the endpoint itself is down, the remaining
    candidates are not sent. A hung endpoint then costs one timeout, not one
    per candidate.
    """
    unavailable = False
    for candidate in candidates:
        def ask(candidate=candidate):
            nonlocal unavailable
            if unavailable:
                return classifier.abstained("endpoint_unavailable")
            verdict = classifier.classify(
                config.classifier,
                candidate["title"],
                " ".join(candidate["scope"]),
                candidate["task"],
            )
            if verdict.get("abstained") in classifier.TRANSPORT:
                unavailable = True
            return verdict

        candidate["resource_recommendation"] = resolve_resource(config, AUTO_ROLE, ask=ask)
    return candidates


def effective_policy(env, resource_config):
    """The values an approval is bound to. Drift here invalidates a plan."""
    return {
        "gates": GATES,
        "min_task_chars": min_task_chars(),
        "max_candidates": MAX_CANDIDATES,
        "max_source_bytes": MAX_SOURCE_BYTES,
        # What each candidate's recommended class was computed from.
        "resource_resolution": resolution_inputs(resource_config),
    }


def resolve_role(env, name):
    """Read a role `gator` already resolved.

    Precedence — environment, then the repository's roles file when trusted,
    then the user's — is implemented once, in the shell script, which exports
    the answer before handing over. Re-deriving it here would be a second
    implementation of a subtle rule, and the two would drift.
    """
    return env.get(f"GATOR_ROLE_{name}", "")


def plan(opts):
    env = os.environ
    if not opts["from"]:
        raise Refusal("no_source", "name the source to plan from, with --from <file>")

    facts = repo_facts(opts["repo"])
    secure_store(opts["store"])
    source = load_source(facts["root"], opts["from"])

    # Before the budget: a broken resource config must cost nothing.
    resource_config = resources(opts)

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
        # Keep the response before anything can reject it. When a plan cannot
        # be built there is no plan to file the evidence under, and that is
        # precisely when it is needed: the 2026-09-20 pilot had to reproduce a
        # run by hand to find out whether the model or the validator had failed.
        response = invoke(cmd, prompt, timeout)
        keep_response(opts["store"], response)
        raw = extract_json(response)

    validated, unusable = validate_candidates(raw, {})
    candidates = mark_completed(validated, opts["store"], source["blob_sha"])
    chosen = select(candidates, {})
    # Candidates the contract could not accept are reported alongside the ones
    # the rubric turned down. They were considered; they just cannot be acted
    # on, and silently dropping them would misreport what the planner said.
    chosen["rejected"].extend({
        "id": u["id"] or "(unnamed)",
        "title": "(unusable)",
        "reason": u["reason"],
        "rationale": u["detail"],
    } for u in unusable)
    recommend(chosen["candidates"], resource_config)

    result = {
        "schema_version": SCHEMA_VERSION,
        "repo_id": facts["repo_id"],
        "target_ref": facts["target_ref"],
        "base_sha": facts["base_sha"],
        "source": {"path": source["path"], "blob_sha": source["blob_sha"]},
        "policy_hash": policy_hash(effective_policy(env, resource_config)),
        "verification_profile": profile,
        "baseline": baseline,
        "selected_id": chosen["selected_id"],
        "candidates": chosen["candidates"],
        "rejected": chosen["rejected"],
        # Three answers, not two. "The planner found no items" and "items were
        # found and none qualified" both used to print "No suitable work",
        # which made a planner malfunction indistinguishable from a correct
        # abstention — the failure mode the 2026-09-20 pilot could not see.
        "outcome": (
            "selected" if chosen["selected_id"]
            else "none_eligible" if (chosen["candidates"] or chosen["rejected"])
            else "no_items"
        ),
        "considered": len(chosen["candidates"]) + len(chosen["rejected"]),
    }
    save(opts["store"], result)
    archive_response(opts["store"], result["plan_id"], response)
    if opts["json"]:
        return emit(result, True)
    render(result)
    return 0


def render(result):
    selected = result["selected_id"]
    if result.get("outcome") == "no_items":
        print("The planner reported no work items at all in this source.")
        print(
            "That is the right answer only if the source really contains none. "
            "Otherwise it is a planner failure — read what it actually said:"
        )
        print("  .gator/auto/last-response.txt")
        return
    if selected is None:
        n = result.get("considered", 0)
        print(f"Considered {n} item(s); none eligible. That is a result, not a failure.")
    else:
        chosen = next(c for c in result["candidates"] if c["id"] == selected)
        print(f'SELECTED "{chosen["id"]}" — {chosen["title"]}')
        print(f'  from   {chosen["source_ref"]}')
        print(f'  scope  {" ".join(chosen["scope"])}')
        print(f'  why    {chosen["rationale"]}')
        rec = chosen.get("resource_recommendation")
        if rec:
            why = ("classifier " + classifier.describe(rec)
                   if rec["source"] == "classifier" else rec["source"])
            print(f'  class  {rec["class"]} ({why})')
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
        reason = check_binding(
            stored, facts, source,
            policy_hash(effective_policy(os.environ, resources(opts))),
        )
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
