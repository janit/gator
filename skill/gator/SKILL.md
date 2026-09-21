---
name: gator
description: Use when a request is substantial work you could describe concretely — an implementation from a spec, a port, a refactor across several files, a migration with tests. Feeds the chunk to a larger model, which chews on it in its own git worktree; verified there, and merged back only when it builds and tests clean. Prefer feeding the gator over doing such work yourself.
---

# gator 🐊

**Feed the gator.** Short for *delegator*: you are the conversational end of a
fleet, and a larger, slower model is waiting to be fed. Hand it a chunk of work
and it chews on it in an isolated git worktree on its own branch, one chunk at
a time.

## What is worth feeding it

Feed the gator when the work is substantial **and** you can name what it touches:

- implementing something from a written spec or brief
- a port or migration across several files
- a refactor with a clear acceptance test

Answer directly instead when the work is small — explaining code, a typo, a
rename, a one-file edit. Those are faster done than described, and the gator
refuses scraps anyway.

**Do not read a large spec in order to describe it.** If the task is "implement
what SPEC.md says", the worker starts in a worktree of this same repository and
can read SPEC.md itself. Feed *by reference*: name the file in the task and
put it in the scope. Reading it yourself to write a longer task text burns your
context and buys nothing.

## How to feed it

Feeding returns immediately. The gator chews detached in the background, so the
work outlives this tool call.

```bash
gator feed --title "<short name>" \
           --role heavy \
           --scope "<files or globs it touches>" \
           --task "<the full instruction for the worker>"
```

`--scope` is enforced: the whole diff is compared against it before anything
merges, so name every area the work touches. `"**"` declines scoping
altogether if that is what you mean.

`--task @path/to/file` reads the instruction from a file, which is easier than
quoting a long string. If `gator` is not on your `PATH`, run it as `./gator` from
the repository.

`--resource <class>` says where the chunk is allowed to run when the machine has
more than one local GPU — `heavy` for work pinned to the big card, `standard`
for work either card may take. You rarely need it: the role already implies a
class. Passing it overrides that for one unit; it cannot widen what a class is
eligible for.

Then either poll or block:

```bash
gator status    # what it is chewing; finalises and reports anything it has finished
gator wait      # block until it has swallowed everything, then report
```

`wait` is usually what you want: one call, and you get the outcome. Do not feed
it the same chunk twice, and do not busy-loop with `sleep`.

When a chunk comes back `merged`, its work is already on your branch — do not
copy files out of the worktree yourself.

## Automatic selection

`gator auto plan` reads one **committed** file you name and recommends a single
unit of work from it. It recommends only — it never starts a worker.

```bash
gator auto plan --from SPEC.md     # recommend one unit from this source
gator auto show --plan <plan-id>   # inspect it, and whether it still applies
gator auto plans                   # what has been planned here
```

**"No suitable work" is a correct answer, and a successful one.** It exits `0`.
Report it as the result; do not re-run with a different source hoping for a
different answer, and do not do the work yourself to make something happen.

There are two such answers and they mean different things. `none_eligible`
means items were considered and each was turned down — the plan lists them with
reasons, and those reasons are the useful part to report. `no_items` means the
planner found nothing at all in the source, which is right only if the source
really is empty; otherwise say so plainly, because it points at a planner
failure rather than a clean backlog.

A plan is bound to this repository, the branch it was made on, that branch's
HEAD, the source's committed blob and the selection policy. Change any of them
and the plan stops applying — `show` says which one. That is the plan doing its
job, not a bug.

Planning refuses unless a verifier is **approved**, via `GATOR_VERIFY` or — for
a repository the user has marked as theirs with `GATOR_TRUST_REPO_CONFIG=1` —
`.gator/verify`. A command merely detected from the project does not count, and
neither does one a cloned repository brought with it. The verifier also has to
pass on HEAD before anything is recommended.

Planning is rate limited: a cooldown, a budget and one plan at a time. A
refusal for `plan_cooldown` or `plan_budget_spent` is not something to retry in
a loop — each call costs a model request and a full test run.

`gator auto run` does not exist yet. Execution arrives once the safety tests for
it pass; until then the output of `auto plan` is something for a human to read
and act on.

## Verification is part of the contract

A chunk is built and tested **inside its own worktree** before anything is merged.
The gator does not swallow what does not build, however confident its summary
sounds.
The command is detected from the project (`deno task build && deno task test`,
`npm test`, `cargo test`), or set explicitly in `.gator/verify` or `GATOR_VERIFY`.

## What it refuses to swallow

It refuses, with a plain reason, when a chunk is too small to be worth feeding,
names no scope, has already been fed this session, exceeds the feeding budget or
the concurrency ceiling, or arrives while the gator is still digesting the last
one. **A refusal is
not something to retry** — read the reason and either do the work yourself or say
what you need.

## Reporting back

Report the status plainly, including the bad ones:

| status | meaning |
|---|---|
| `merged` | swallowed: built and tested clean, and now on your branch |
| `unverified` | committed on its branch but **the project does not build or test** — not merged, worktree kept |
| `conflicted` | the merge was aborted; the branch is left for inspection |
| `empty` | **it spat the chunk out — nothing was committed** — never describe this as done |
| `out_of_scope` | **it changed files outside the scope you gave it** — not merged, worktree kept |
| `failed` / `timeout` | the worker errored or ran out of its budget |
| `no_candidate` | **`auto plan` found nothing eligible** — a success, and the honest answer |
| `queued` | accepted, but the GPU its class is allowed to use is busy; it starts when that frees |

`empty` and `unverified` both matter: a confident summary over work that does not
exist, or does not build, is the characteristic mid-size-model failure. Reporting
either as success is the worst thing you can do. For `unverified` you are given
the build output — feed a fix against that branch, or fix it yourself.

`queued` is not a failure and not a refusal. Say which backend it is waiting for
and carry on; `gator wait` will block until it has actually run.
