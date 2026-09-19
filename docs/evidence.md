# Why this exists

Condensed from a study run on 2026-09-17/18 against one local fleet. The full
write-up and the raw artefacts are kept privately; this is the part that justifies
the design decisions in gator.

## Setup

- **Workload:** a 603-line clean-room build brief for a small web app — 19 files, a
  seven-middleware chain with a mandated order, an exact HTTP contract, SQLite
  seeding rules, a Preact island, a unit test suite and deployment artefacts.
- **Scoring:** 136 checks, 301 points, derived from the brief alone and frozen
  before any run was scored. Validated in both directions: an implementation
  written to the spec by hand scores 301/301, a stub scaffold 14%, and an
  independent reference implementation 129/129 on the subset it targets.
- **Models:** granite-4.2-8b (16,384-token window) and Qwen3.8-27B (49,152),
  quantised, served by one gateway. All traffic through a logging proxy.

## 1. Neither model delegates while it can read

At the API level, no harness involved, three tasks that plainly warrant delegation,
three trials each, with a system prompt urging delegation:

| condition | granite-4.2-8b | Qwen3.8-27B |
|---|---|---|
| default — a `read` tool is available | **0/9** | **0/9** |
| delegate is the only tool | 4/9 | **9/9** |
| explicit "delegate this, do not read" | 8/9 | **9/9** |

The 27B model is no more willing than the 8B one. Both answer the same way — *"Let
me read the spec before planning anything"*. Delegation is not a capability either
lacks; it is a choice neither makes while a file-reading tool is on the table.

**Consequence for this design:** a chat role that delegates needs the smallest
possible reason to reach for a file instead. Hence *delegate by reference* — name
the file and the scope, and let the worker, which starts in a worktree of the same
repository, read it itself.

## 2. The surface matters more than the model

Same chat model (Qwen3.8-27B), same brief, same fleet; the only variable is where
delegation lives:

| delegation surface | runs | delegated |
|---|---|---|
| plugin tool, behind `execute` → code mode → a namespaced catalog | 5 | **0** |
| skill + script, behind `shell` | 7 | **5** |

Fisher exact, two-sided **p = 0.0278**.

Tool-call counts from one run explain it: `shell` 179, `read` 80, `edit` 29,
`write` 25, `grep` 12, **`execute` 2**. The catalog holding the delegate function
was itself labelled *"The Code Mode tool catalog below is partial."* Reaching for
`read` cost one decision; delegating cost three, through a surface advertised as
incomplete.

It is not reliable — two of the seven runs did the work themselves — so this is
"delegation starts happening", not "delegation is solved".

## 3. Verification is the binding limitation, not capability

A delegated implementation, scored as delivered and after a two-character repair:

| | score |
|---|---|
| as delivered | 90/301 (29.9%) |
| after fixing two import paths | **299/301 (99.3%)** |

Both API route files imported `"../../db.ts"` where the file was three levels up.
A failed build zeroes every runtime category at once: **209 points for one wrong
relative path**. A second, independent worker made the identical mistake, so it is
systematic for this model on this layout rather than bad luck.

With it fixed the delegated work scored build 20/20 (its own tests passing), and
perfect marks on the HTTP contract, middleware semantics, page rendering and
browser behaviour — the best local-model result in the study.

**Consequence for this design:** merge on green, never on clean. The worker
produced excellent work and the system would have reported nothing useful, because
nothing ran the build. Verification runs in the worktree so a failure costs a merge
that never happened.

## 4. Harness overhead decides what a small model can do at all

Tokens spent before any work, on a trivial task:

| harness | tools | prompt tokens |
|---|---|---|
| OpenCode 2.0.5 `build` agent | 12 | 8,431 |
| Pi 0.84.2 stock | 4 | **1,574** |

Against granite's 16,384-token window and a 7,693-token brief, the first is
arithmetically impossible and the second leaves ~7,100 tokens to work in. The same
model died in 14 seconds on one harness and implemented files on the other.

**Consequence for this design:** the skill adds nothing to the chat model's
context beyond one `SKILL.md`, and the worker gets a fresh process with only its
own task.

## Limitations

Single fleet, two quantised local models, one workload, twelve implementation runs
plus the API-level benchmark. The delegation-rate result is significant but young;
it deserves replication with a different chat model and a second workload before
being treated as settled.
