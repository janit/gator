"""Eligibility gates and the ranking rubric — pure functions, no I/O.

Keeping this free of git, subprocess and the filesystem means the whole
selection policy is testable by calling one function, which is the only way a
rubric stays honest as it is tuned.

On the scales (spec section 5): `benefit` is 0..3 and genuinely graded, but
`clarity` and `boundedness` are 0..2 with a threshold of 2 — their thresholds
equal their maxima, so **only the top value passes**. They are gates, not
weights. The 0..2 scale survives because the intermediate values explain a
rejection, not because a 1 is merely disfavoured. Anyone tuning this should
change the gate deliberately rather than assume a 1 is "slightly worse".

On the character floor: in auto mode the planner writes the task text, so
clearing 240 characters is trivial and carries no quality signal whatsoever.
It stays as an input-shape check. The gates above are the only real bar.
"""
import os

GATES = {"benefit": 2, "clarity": 2, "boundedness": 2}


def min_task_chars():
    try:
        return int(os.environ.get("GATOR_MIN_TASK_CHARS", "240"))
    except ValueError:
        return 240


def eligibility(candidate, eligible_ids):
    """A reason code when the candidate cannot be selected, else None."""
    if candidate["risk"] == "disallowed":
        return "risk_disallowed"
    if not candidate["acceptance"]:
        return "no_acceptance_criteria"
    if candidate["clarity"] < GATES["clarity"]:
        return "needs_clarification"
    if candidate["boundedness"] < GATES["boundedness"]:
        return "not_bounded"
    if candidate["benefit"] < GATES["benefit"]:
        return "benefit_below_threshold"
    if len(candidate["task"]) < min_task_chars():
        return "task_below_floor"
    # A dependency is resolved only when the thing depended on is itself
    # selectable. Deferring is the point: inventing the prerequisite is not.
    for dep in candidate["depends_on"]:
        if dep not in eligible_ids:
            return "unresolved_dependency"
    if candidate.get("previously_completed", {}) and \
            candidate["previously_completed"].get("same_revision"):
        return "already_completed"
    return None


def _sort_key(candidate, priorities):
    # Explicit source priority first; absent priority is neutral, which means
    # it sorts after any stated one rather than ahead of it.
    priority = priorities.get(candidate["id"])
    return (
        0 if priority is not None else 1,
        priority if priority is not None else 0,
        # Work completed under an earlier revision of the source stays eligible
        # but sorts last: it needs a human look, not an automatic re-run.
        1 if candidate.get("previously_completed") else 0,
        -candidate["benefit"],
        len(candidate["scope"]),
        candidate["id"],
    )


def rank(candidates, priorities):
    """Partition into (eligible, sorted) and (rejected, with reasons)."""
    # Dependencies resolve against candidates that pass every gate other than
    # the dependency gate itself, so a chain does not reject its own head.
    self_eligible = {
        c["id"] for c in candidates
        if eligibility({**c, "depends_on": []}, set()) is None
    }

    eligible, rejected = [], []
    for candidate in candidates:
        reason = eligibility(candidate, self_eligible)
        if reason is None:
            eligible.append(candidate)
        else:
            rejected.append({
                "id": candidate["id"],
                "title": candidate["title"],
                "reason": reason,
                "rationale": candidate["rationale"],
            })
    eligible.sort(key=lambda c: _sort_key(c, priorities))
    return eligible, rejected


def select(candidates, priorities):
    """`selected_id` of None is a valid no-candidate result, not an error."""
    eligible, rejected = rank(candidates, priorities)
    return {
        "selected_id": eligible[0]["id"] if eligible else None,
        "candidates": eligible,
        "rejected": rejected,
    }
