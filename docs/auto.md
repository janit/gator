# `gator auto` — recommendation-only planning

Implements steps 1 and 2 of the delivery sequence in
[the specification](superpowers/specs/2026-09-19-autogator-design.md). Execution
(`auto run`, `auto accept`) is steps 3 and 4 and is not built.

## Commands

```bash
gator auto plan  --from <committed file> [--json] [--no-baseline]
gator auto show  --plan <plan-id> [--json]
gator auto plans [--json]
```

`plan` costs one bounded planner call and writes local plan metadata. It is not
a free dry run. It never starts a worker.

Exit codes: `0` success, including a valid no-candidate plan; `2` invalid input
or policy refusal; `3` a terminal unsuccessful run; `4` a wait deadline while
work is still active. JSON is the machine contract — never parse the human
output.

## What gets stored

```
.gator/
  auto/
    plans/<plan-id>.json      canonical bytes; `sha256sum` reproduces the digest
    plans/<plan-id>.sha256    the digest, sha256sum-compatible
    completed.json            the dedup ledger
```

The stored file *is* the canonical JSON that was hashed, so the identity lives
in the filename and the sidecar rather than inside the document. Editing the
file by hand invalidates it, which is the point.

A plan binds to five things. Any drift and it no longer applies:

| binding | detected as |
|---|---|
| this checkout | `wrong_repository` |
| the source's committed blob | `stale_source` |
| the selection policy | `stale_policy` |
| the branch, and its HEAD | `stale_target` |
| the plan's own bytes | `stale_plan_hash` |

Checked most-specific-first: committing a source edit also moves HEAD, so both
are true, and `stale_source` is the one worth telling you about.

## The rubric

| dimension | scale | threshold |
|---|---|---|
| `benefit` | 0–3 | ≥ 2 |
| `clarity` | 0–2 | **= 2** |
| `boundedness` | 0–2 | **= 2** |
| `risk` | enum | not `disallowed` |

`clarity` and `boundedness` have thresholds equal to their maxima, so **only the
top value passes — they are gates, not weights.** The 0–2 scale survives because
the intermediate values explain a rejection, not because a 1 is merely
disfavoured. Change the gate deliberately if you change it.

Ranking, once the gates are passed: explicit source priority, then `benefit`,
then the narrower scope, then the candidate id for stability. Work completed
under an earlier revision of the source stays eligible but sorts last.

**The 240-character task floor carries no quality signal here.** In auto mode the
planner writes the task text, so clearing it is trivial. It is an input-shape
check; the gates above are the only real bar.

## Reason codes

Preconditions: `not_a_repo`, `bare_repo`, `detached_head`, `unsupported_worktree`,
`source_missing`, `source_not_committed`, `source_outside_repo`,
`source_too_large`, `source_symlink_escape`, `no_source`.

Planner: `planner_tools_enabled`, `planner_timeout`, `planner_failed`,
`planner_invalid_json`, `planner_input_too_large`, `planner_output_too_large`.

Validation: `candidate_unknown_field`, `candidate_missing_field`,
`candidate_bad_id`, `candidate_duplicate_id`, `candidate_bad_score`,
`candidate_bad_risk`, `candidate_bad_scope`, `candidate_scope_root`,
`too_many_candidates`, `unknown_dependency`.

Verification: `verifier_not_approved`, `baseline_red`.

Rate limiting: `plan_cooldown`, `plan_budget_spent`, `plan_in_flight`.

Hostile input: `candidate_control_characters`, `planner_output_too_large`.

Bindings: `plan_not_found`, `stale_plan_hash`, `stale_source`, `stale_policy`,
`stale_target`, `wrong_repository`.

Eligibility (reported per candidate, not as a refusal): `benefit_below_threshold`,
`needs_clarification`, `not_bounded`, `unresolved_dependency`, `risk_disallowed`,
`no_acceptance_criteria`, `task_below_floor`, `already_completed`.

## The planner is given no tools

`pi -p --offline -ne -ns -np -nc -nt --no-session` — `-nt` disables built-in and
extension tools alike. The controller refuses a recognised host command that
lacks it, because a read-only *prompt* is not a capability restriction. The
source and a bounded file listing go in the prompt, so a planner with no tools
still has what it needs.

Source prose is fenced as untrusted data. It is task material and carries no
authority over budgets, launch commands, secrets or policy.

## §9 coverage

Satisfied here: **1, 2, 3, 4, 5, 9, 16, 17**, and 6 and 14 for the parts that
exist without execution.

Left for steps 3–4: **7** (concurrent reservations), **8** (crash and resume),
**10** (scope enforced against the diff), **11** (worker-modified verification),
**12** (integration guards), **13** (exact-candidate verification), **15**
(budget persistence). `test/findings_test.ts` carries these as
`CHARACTERIZATION` tests describing today's behaviour; each names the step that
will turn it into a `DESIRED` one.

## Trust boundary

The repository is untrusted input. `.gator/roles` and `.gator/verify` are read
from the working tree **only** when `GATOR_TRUST_REPO_CONFIG=1`; otherwise a
clone could name the command that runs. See the 2026-09-20 review in
`docs/private/` for the reproductions.

## What this does not protect

Worktrees and diff checks protect **integration**, not the machine. The worker
and the planner run as subprocesses with your permissions. Nothing here prevents
out-of-tree writes, network access, credential reads or git manipulation, and no
claim of hostile-code isolation is made. Real isolation is separate future work.

Linux, with the GNU utilities `gator` already assumes (`timeout`, `setsid`,
`readlink -f`, `sha256sum`), plus Git and Python 3. Other platforms need
dedicated testing first.
