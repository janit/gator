# gator 🐊

**gator** is a skill for feeding a larger model. A chat model
hands it a chunk of substantial work; the gator chews on it in an isolated git
worktree on its own branch, and it is merged back only when it builds and tests
clean.

One `SKILL.md` and two shell scripts. No plugin, no host API. Any agent that
reads `skills/<name>/SKILL.md` and can run a shell command can use it: OpenCode,
Pi, Claude Code.

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

The gator chews detached, so a chunk outlives the tool call that fed it and
survives the session being interrupted.

## Tests

```bash
deno task test     # the suite
deno task check    # types, formatting, lint
```

The worker is stubbed, so every guardrail, every status and the verification gate
run in about five seconds without touching a model. The only runtime requirement
is Deno; the skill itself is shell, and runs anywhere.
