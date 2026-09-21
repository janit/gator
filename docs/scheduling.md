# Scheduling: where a unit is allowed to run

Gator has always answered one question about a chunk of work — *which model
should do it* — and answered it from a roles file so no model id lives in the
code. On a machine with more than one local GPU there is a second question,
and it is not the same kind of question.

A role is a preference. You would like the heavy role to use the big model.
An eligibility set is a constraint. Difficult work *must* run on the 32 GB card,
and the interesting part is not making that the default — it is making it
impossible to talk out of.

So they are separate files, separate code paths, and separate vocabulary.

## The rule

> Preference may move ordinary work; eligibility may not move heavy work.

A `heavy` unit is eligible for `local-5090` and nothing else. If that card is
busy the unit queues. If it is down the unit waits. Once the card has been
unhealthy or disabled for longer than `GATOR_BACKEND_TIMEOUT` (default 1800
seconds), the unit's record and `gator status` report `blocked_backend` instead
of `waiting_for_required_backend`. The unit stays queued for the same card and
starts as soon as the card comes back. Only `GATOR_PROBE_HEALTH=1` detects an
unhealthy card, by running `health_cmd`. Without it, only a card switched off
with `gator sched disable` counts as down. It does not spill to the 4090 — not under load, not
under queue pressure, not because someone wrote a weight claiming the 4090 is
faster.

That last one is worth dwelling on, because it is where this kind of design
usually leaks. A scheduler that expresses "prefer the 5090" as a score can
always be argued out of it by a big enough number somewhere else. So eligibility
is not a score. `policy.candidates` filters by the class's eligible set *first*,
and scoring only ever chooses among what survives:

```python
def candidates(config, resource_class, state):
    out = []
    for ident in eligible(config, resource_class):   # <- hard set, first
        ...                                          # <- health, capacity,
    return out                                       #    reservation after
```

There is a test that generates five hundred random weightings and asserts the
4090 never wins a heavy unit. It is the cheapest possible insurance against
someone later "simplifying" the two steps into one.

## The pieces

| file | what it decides |
|---|---|
| `gator_sched/config.py` | what backends exist and what each class may use |
| `gator_sched/policy.py` | eligibility (hard) and expected completion (soft) |
| `gator_sched/leases.py` | who currently holds which backend, durably |
| `gator_sched/health.py` | whether a backend can take work at all |
| `gator-sched.py` | the argv-only CLI that Bash talks to |

`policy.py` reads no file, no clock and no environment variable. The caller
supplies the state; it decides. That is what makes the invariants testable as
pure functions rather than as end-to-end plumbing.

## Why leases are files and not a variable

Gator units are detached. The shell that admitted one has usually exited before
the worker writes its first token, so "is this backend free?" cannot live in a
process — it has to be state on disk that unrelated invocations contend for.

The primitive is `fcntl.flock` held across a read-modify-write of one small JSON
document, which is then replaced atomically. That is the shape the budget state
and `gator-record.py` already use; this adds the mutual exclusion they do not
need and a lease cannot do without.

Two failure modes get explicit handling, because the lazy answer to each is
wrong in the same direction:

- **A worker dies without releasing.** Reaped by process liveness, so a crashed
  unit cannot strand a GPU forever. A lease taken before its worker exists is
  protected by age instead, until `gator-unit` claims it.
- **The document will not parse.** Raised, never rounded down to "no leases
  held". Guessing there means two workers on one card.

## Why there is no daemon

Section 10 of the spec describes a queue, which usually implies something
resident to drain it. Gator has no resident anything, and adding one would be a
new lifecycle to supervise, crash and restart.

Instead the queue is drained at the three moments something is already
happening: a new `feed`, a `status` or `wait`, and — the one that actually keeps
a card busy — the release of the lease that was in the way, by the unit that
held it. `gator-unit` releases and drains *before* dropping its lock, so the
successor has taken its own lock before the predecessor lets go, and `gator
wait` never sees a false moment of quiet with work still outstanding.

## What did not change

Verification, merge-on-green, worktree isolation, the record, the budgets. The
scheduler sits between a resolved worker request and a concrete worker launch.
It decides where; it has no opinion about whether the result is any good.

## Automatic classification

When nothing the operator configured decides a unit's class — no `--resource`,
no `role.<role>` mapping, no explicit `role.default` — gator can ask a model how
hard the task is. It is off unless the resources file names an endpoint:

    classifier.endpoint  = http://localhost:8086/v1
    classifier.model     = Qwen3.8-27B
    classifier.threshold = 0.75   # demote only when at least this sure
    classifier.timeout   = 5

The model is shown two options, H (heavy) and S (standard), and gator reads the
probability it assigns to each from a single decode step. Nothing the model
writes is used, so it cannot answer `remote`, name a class, or say anything else.
A unit starts at `heavy` and moves to `standard` only when P(standard) reaches
the threshold. A timeout, an unreachable endpoint, a model that wanted to say
something else, or a response that does not parse all keep it at `heavy`, and
the record says which (`resource.classifier = abstained:timeout`).

The heavy guarantee does not depend on the classifier being right. It chooses
between two classes; eligibility then decides where each may run, exactly as for
a class chosen by hand.

The endpoint needs an OpenAI-compatible `/chat/completions` that returns
`logprobs` — llama-server, vLLM, and viiwork in front of either. It receives the
unit's title, scope and task text, so its address passes the same trust gate as
the rest of the resources file: a repository's own `.gator/resources` cannot set
it unless `GATOR_TRUST_REPO_CONFIG=1`.

`gator auto plan` records the same decision on each selectable candidate as
`resource_recommendation`, inside the hashed plan. Changing the classifier
settings makes a stored plan report `stale_policy`.

Calibrate against your own endpoint with
`GATOR_CLASSIFIER_LIVE=1 deno test -A test/classifier_live_test.ts`.
