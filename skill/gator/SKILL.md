---
name: gator
description: Use when a request is substantial work you could describe concretely — an implementation from a spec, a port, a refactor across several files, a migration with tests. Feeds the chunk to a larger model, which chews on it in its own git worktree; verified there, and merged back only when it builds and tests clean. Prefer feeding the gator over doing such work yourself.
---

# gator 🐊

**Feed the gator.** You are the conversational end of a fleet, and a larger,
slower model is waiting to be fed. Hand it a chunk of work and it chews on it in
an isolated git worktree on its own branch, one chunk at a time.

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

`--task @path/to/file` reads the instruction from a file, which is easier than
quoting a long string. If `gator` is not on your `PATH`, run it as `./gator` from
the repository.

Then either poll or block:

```bash
gator status    # what it is chewing; finalises and reports anything it has finished
gator wait      # block until it has swallowed everything, then report
```

`wait` is usually what you want: one call, and you get the outcome. Do not feed
it the same chunk twice, and do not busy-loop with `sleep`.

When a chunk comes back `merged`, its work is already on your branch — do not
copy files out of the worktree yourself.

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
| `failed` / `timeout` | the worker errored or ran out of its budget |

`empty` and `unverified` both matter: a confident summary over work that does not
exist, or does not build, is the characteristic mid-size-model failure. Reporting
either as success is the worst thing you can do. For `unverified` you are given
the build output — feed a fix against that branch, or fix it yourself.
