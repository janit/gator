# AGENTS.md

Rules for agents working in this repository.

## What this is

gator is a delegation skill. A chat model feeds it a chunk of work; gator runs a
worker on it in its own git worktree and branch, verifies the result there, and
merges it back only when it builds and tests clean. `README.md` describes it.

- `skill/gator/`: the skill itself. `SKILL.md`, the `gator` and `gator-unit`
  shell scripts, and the Python helpers (`gator-*.py`, `gator_sched/` for
  scheduling, `gator_auto/` for `gator auto plan`).
- `scripts/`: `install.ts` (installs the skill and `gator` onto PATH) and
  `test.sh` (runs the suite under one temporary root it removes afterwards).
- `test/`: Deno tests. The worker is stubbed; nothing touches a model.
- `docs/`: `auto.md`, `scheduling.md`, `evidence.md`.

The skill runs on Linux with GNU utilities, Git and Python 3. Deno builds and
tests it but is not needed to run it.

## Rules

- Guardrails are enforced in the scripts, never by asking a model to behave:
  scope checked against the diff, minimum chunk size, dedup, budgets,
  cooldown, concurrency. Do not weaken one to make a case pass.
- The repository is untrusted input. A repository's own `.gator/roles`,
  `.gator/verify` or `.gator/resources` stays ignored unless
  `GATOR_TRUST_REPO_CONFIG=1`. Keep it that way.
- Resource class eligibility is a hard constraint, applied before anything is
  scored. Nothing may move a unit onto hardware its class forbids.
- No model id in the code: roles come from the roles file or `GATOR_ROLE_<name>`.
- Never put keys or secrets in commands, tests or the repository.
- When behaviour or a variable changes, update `README.md` and the matching
  file in `docs/` in the same change.
- Tests must not leave files behind: run them through `deno task test`, which
  puts every temporary directory under one root and removes it.
- Keep the prose plain. No marketing filler.
- Open a pull request and stop. Never push to the default branch.

## Verify

`.pi/verify-cmd` is the fast gate. Run it before you say a change is done. It is
`deno task check` and then the suite through `deno task test`, with two racy
tests in `test/sched_accept_test.ts` left out (the file says which and why).
The suite needs `python3`. If you fix those two tests, put them back in the gate.

## Commits

One plain sentence in the imperative or as a statement of the result, no
prefix. A release names its version at the end, as in
`Heterogeneous local GPU scheduling (v0.3.0)`.
