# gator 🐊

**gator** is a **dele*gator*** skill — the name is the end of the word, and the
animal earns it. A chat model hands it a chunk of substantial work; the gator
chews on it in an isolated git worktree on its own branch, and it is merged back
only when it builds and tests clean.

Delegation, in other words, with teeth: what comes back has to build.

One `SKILL.md`, two shell scripts and a small Python controller. No plugin, no
host API. Any agent that reads `skills/<name>/SKILL.md` and can run a shell
command can use it: OpenCode, Pi, Claude Code.

```bash
deno task install     # installs the skill, and `gator` onto your PATH
```

Roles live in a file, so no model id is in the code and no shell profile has to be
edited — `~/.config/gator/roles`, or `.gator/roles` to override per repository:

```ini
heavy  = fleet/DeepSeek-V4-Flash
review = fleet/Qwen3.8-Flash-Next

# how a worker is launched; %PROVIDER% and %MODEL% come from the role
worker_cmd = opencode run --standalone --auto --model %PROVIDER%/%MODEL% "$(cat)"
```

`GATOR_ROLE_<name>` in the environment still wins, for overriding one unit.

Then, from a session in that repository:

```bash
gator feed --title "port the tokenizer" --role heavy \
           --scope "src/lexer.ts,src/lexer_test.ts" --task @task.md
gator wait
```

## Why a skill and not a tool

Delegation fails at one step: getting the model to choose it. Measured against a
603-line build brief, with Qwen3.8-27B as the chat model on a local fleet:

| delegation surface | runs | delegated |
|---|---|---|
| a plugin tool, reached through code mode | 5 | **0** |
| `gator`, reached through `shell` | 7 | **5** |

Fisher exact, two-sided **p = 0.0278**. Same model, same brief, same fleet. In one
of those runs the model made 179 `shell` calls and 2 `execute` calls — `shell` is
the tool these models live in, and a delegate function behind `execute` → code mode
→ a namespaced catalog is three decisions away from a `read` that is one. Put
delegation where the model's hand already is.

The same benchmark, at the API level: with a file-reading tool available, neither
granite-4.2-8b nor Qwen3.8-27B delegated — 0/9 each. Remove `read` and Qwen goes
9/9. Size was never the constraint.

See `docs/evidence.md`.

## Merge only when green

Each unit is built and tested **inside its own worktree** before anything is
merged, so a broken unit costs a merge that never happened rather than a rollback
of your work.

This is the difference between a system that helps and one that lies to you. In
the study a delegated implementation scored **90/301 as delivered and 299/301
after fixing two characters** in an import path — 209 points lost because nothing
ran the build. A unit that does not build reports `unverified`, keeps its
worktree, and hands back the build output.

The command is detected from the project (`deno task build && deno task test`,
`npm test`, `cargo test`), or set in `.gator/verify` or `GATOR_VERIFY`.

## Statuses

| status | meaning |
|---|---|
| `merged` | swallowed: built and tested clean, now on your branch |
| `unverified` | committed on its branch, but does not build — not merged, worktree kept |
| `ready (held)` | green, but your tree is dirty; merges when it is clean |
| `conflicted` | the merge was aborted; branch left for inspection |
| `empty` | **it spat the chunk out, nothing committed** — never report this as done |
| `failed` / `timeout` | the worker errored or spent its budget |
| `queued` | admitted, but the backend it is allowed to use is busy — see below |

`empty` and `unverified` exist because a confident summary over work that does not
exist, or does not build, is the characteristic mid-size-model failure.

## What it refuses to swallow

Enforced in the script, not by asking a model to behave: a minimum chunk size,
scope required, dedup by task hash, a per-session feeding budget, a cooldown
while it digests, and a concurrency ceiling. A refusal comes back as a plain
reason.

| variable | default | meaning |
|---|---|---|
| `GATOR_ROLE_<name>` | — | model reference for a role; overrides the roles file |
| `GATOR_ROLES` | `~/.config/gator/roles` | where roles are read from |
| `GATOR_MIN_TASK_CHARS` | `240` | below this a chunk is refused as too small |
| `GATOR_MAX_CONCURRENT` | `2` | how many chunks it chews at once |
| `GATOR_MAX_PER_SESSION` | `8` | total feedings per session |
| `GATOR_COOLDOWN` | `90` | digestion time between feedings, seconds |
| `GATOR_UNIT_TIMEOUT` | `2400` | per-chunk budget, seconds |
| `GATOR_VERIFY` | detected | the command that decides "green" |
| `GATOR_AUTOMERGE` | `1` | set `0` to leave green chunks on their branch |
| `GATOR_WORKER_CMD` | `pi …` | how to invoke a worker; `%PROVIDER%`/`%MODEL%` substituted |
| `GATOR_RESOURCES` | `~/.config/gator/resources` | where backends and eligibility are read from |
| `GATOR_RESOURCE` | — | resource class for one unit; overrides the files |
| `GATOR_QUEUE` | `1` | set `0` to refuse a unit outright instead of queueing it |
| `GATOR_PROBE_HEALTH` | `0` | set `1` to run each backend's `health_cmd` before dispatch |
| `GATOR_BACKEND_TIMEOUT` | `1800` | how long a unit's only backend may be down or disabled before the unit reports `blocked_backend`, seconds |

The gator chews detached, so a chunk outlives the tool call that fed it and
survives the session being interrupted.

## Which GPU it chews on

If you have more than one local GPU, the roles file answers *which model* does
the work and a second file answers *where it is allowed to run*. They are
separate because they are different kinds of statement. A role is a preference.
An eligibility set is a constraint, and the point of keeping it separate is that
nothing — not load, not weighting, not a queue backing up — can argue a unit
onto hardware its class forbids.

`~/.config/gator/resources`, or `.gator/resources` with the same trust opt-in
that roles and verify need:

```ini
role.heavy   = heavy        # the heavy role runs as the heavy class
role.review  = remote
role.default = standard

backend.local-4090.endpoint = http://127.0.0.1:4091
backend.local-4090.capacity = 1
backend.local-4090.weight   = 1.0
backend.local-4090.interactive_reservation = true

backend.local-5090.endpoint = http://127.0.0.1:5091
backend.local-5090.capacity = 1
backend.local-5090.weight   = 1.6

class.standard.eligible = local-4090,local-5090
class.heavy.eligible    = local-5090
class.remote.eligible   = fleet
```

Those `class.*.eligible` lines are hard constraints, and they are the defaults
even with no file at all. A `heavy` unit runs on the 5090 or it waits. If the
5090 is busy it queues. If the 5090 is down or disabled for longer than
`GATOR_BACKEND_TIMEOUT`, the unit is still queued for it, but `gator status`
reports it as `blocked_backend`. A dead card is detected only with
`GATOR_PROBE_HEALTH=1`; without it, only `gator sched disable` counts. It never
quietly lands on the 4090, and a weight claiming the 4090 is a thousand times
faster does not change that — eligibility is applied before anything is scored.

Ordinary `standard` work is eligible for both, so an idle 5090 always beats a
busy 4090 and neither card sits idle while there is work it may take.

`interactive_reservation` marks a card you also chat on. While the reservation
is set, no *new* unit starts there; one already running is left alone.

```bash
gator sched reserve --backend local-4090 --on    # chat is using it
gator sched reserve --backend local-4090 --off   # it is free again
gator sched status                               # what each backend is doing
```

The worker command gets `%RESOURCE%`, `%BACKEND%` and `%ENDPOINT%` alongside
`%PROVIDER%` and `%MODEL%`, so a worker can be pointed at an already-running
model server without a GPU id ever appearing in Gator's role logic.

There is no scheduler daemon. A queued unit gets its turn when the unit ahead of
it releases its slot, or at the next `gator status` or `gator wait`.

### Letting a model pick the class

When nothing you configured decides a unit's class (no `--resource`, no
`role.<role>` mapping, no explicit `role.default`), gator can ask a model how
hard the task is. It is off unless the resources file names an endpoint:

```ini
classifier.endpoint  = http://localhost:8086/v1
classifier.model     = Qwen3.8-27B
classifier.threshold = 0.75   # demote to standard only when at least this sure
classifier.timeout   = 5
```

The rule is conservative. A unit stays `heavy` unless the model gives
`standard` at least the threshold's probability. A timeout, an unreachable
endpoint or an answer that does not parse all keep it `heavy`, and the record
says why. The model can choose only between `heavy` and `standard`, and your own
settings always win. The order is `--resource` / `GATOR_RESOURCE`, then a role
mapping, then an explicit `role.default`, then the classifier, then the built-in
default. `FED`, `QUEUED` and `status` lines show which of these decided
(`source=`).

The endpoint receives the task text, so a cloned repository's own
`.gator/resources` cannot set it. See
[docs/scheduling.md](docs/scheduling.md#automatic-classification).

## Automatic selection

`gator auto plan` picks one unit of work out of a committed file and recommends
it. It recommends only — no worker starts.

```bash
gator auto plan  --from SPEC.md     # recommend one unit
gator auto show  --plan <plan-id>   # inspect it, and whether it still applies
gator auto plans                    # what has been planned here
```

The result is a canonical, hashed manifest under `.gator/auto/plans/`, bound to
this checkout, the branch, its HEAD, the source's committed blob and the
selection policy. Change any of them and the plan stops applying, and `show`
names which. "No suitable work" is a normal, successful answer.

Planning refuses without a verifier you approved — `GATOR_VERIFY` or
`.gator/verify`. A command detected from the project is the tool guessing, not
your approval, and auto will not guess. The verifier must also pass on HEAD
before anything is recommended.

Planning is rate limited the way `feed` is — a cooldown, a per-repository
budget and one plan at a time — because each call costs a model request and a
full verifier run. `GATOR_PLAN_COOLDOWN`, `GATOR_MAX_PLANS`.

`gator auto run` does not exist yet. See [docs/auto.md](docs/auto.md).

## Supported platform

Linux, with the GNU utilities this already assumes — `timeout`, `setsid`,
`readlink -f`, `sha256sum` — plus Git and Python 3. Deno builds and tests it but
is not needed to run it. Other platforms may work and have not been tested.

## Security model

Be clear about what this does and does not do.

**It protects integration.** Work happens in a separate worktree on its own
branch, it is verified there, and nothing reaches your branch unless the
verifier passed. A bad unit costs a merge that never happened.

**Scope is enforced, not requested.** The whole base-to-result diff is compared
against `--scope` before anything merges — every rename endpoint, deletion,
mode change and symlink, because each is a way to move work out of the
declared area. A unit that strayed is held with its worktree and the offending
paths named. `--scope "**"` declines scoping, which is yours to choose; the
planner cannot choose it.

**It is not a sandbox.** The worker and the planner are subprocesses running
with your permissions. Nothing here prevents writes outside the worktree,
network access, reading credentials or manipulating git. The prompt asks the
worker not to push; asking is all it is. If you point this at a model you do not
trust, the worktree will not save you — that needs real isolation, which is
separate future work and is not claimed here.

The planner is given no tools at all (`-nt`), which is a capability restriction
rather than a request, and the source it reads is fenced as untrusted data with
no authority over budgets, commands or policy. That bounds the planner. It does
not bound the worker.

**The repository is untrusted input.** `.gator/` lives inside it and a
repository can commit its own, so a clone can arrive carrying a `roles` file
that names the command to run, a `verify` file that the baseline check would
execute, or a `resources` file naming endpoints and a health command — and
claiming that `heavy` may run anywhere it likes. All three are ignored unless
you say otherwise:

```bash
GATOR_TRUST_REPO_CONFIG=1 gator ...   # this repository's .gator/ is mine
```

Without it, a repository-supplied `roles`, `verify` or `resources` is skipped
with a note on stderr, and `auto plan` refuses for want of an approved verifier
rather than running a stranger's shell. Set it only for repositories you wrote.

Task text has no authority over any of this either. A chunk that asks to be
scheduled somewhere is asking the model that reads it, not the scheduler, which
never sees the prompt.

## Tests

```bash
deno task test     # the suite
deno task check    # types, formatting, lint
```

The worker is stubbed, so every guardrail, every status and the verification gate
run in about five seconds without touching a model. The only runtime requirement
is Deno; the skill itself is shell, and runs anywhere.
