// Regression tests for the seven behaviours reproduced in spec section 2.
//
//   DESIRED          — the behaviour we want. Fixed in this plan; keep it green.
//   CHARACTERIZATION — what the code does today. The finding and the step that
//                      will change it are named in the test. When that step
//                      lands, rewrite the test as DESIRED; do not delete it.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { feed, git, repo, repoNamed, run, waitForUnit } from "./harness.ts"

// ---------------------------------------------------- §9.16 hostile repo names

Deno.test("DESIRED §9.16: a repository path containing a quote is handled, not executed", () => {
  const dir = repoNamed("echo hi", "it's a repo")
  const r = feed(dir, "quoted path")
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "FED")

  // The state file must be valid JSON with the unit counted — proof the path
  // reached Python as an argument rather than as source.
  const state = JSON.parse(readFileSync(join(dir, ".gator", "state.json"), "utf8"))
  assertEquals(state.units, 1)
  assertEquals(state.hashes.length, 1)
})

Deno.test("DESIRED §9.16: a repository path containing a space is handled", () => {
  const dir = repoNamed("echo hi", "two words")
  const r = feed(dir, "spaced path")
  assertEquals(r.code, 0, r.out)
  const state = JSON.parse(readFileSync(join(dir, ".gator", "state.json"), "utf8"))
  assertEquals(state.units, 1)
})

// ============================================================ §2 finding 1
Deno.test("CHARACTERIZATION §2.1: with no verifier a changed unit merges anyway", () => {
  // Today: merge-on-clean with a "NOT verified" warning.
  // Auto must fail closed instead — Task 12 refuses to plan without an
  // approved verification profile; legacy keeps this behaviour until step 3.
  const dir = repo(`echo work > out.txt`)
  feed(dir, "no verifier", "**", { GATOR_VERIFY: "" })
  const w = waitForUnit(dir, { GATOR_VERIFY: "" })
  assertStringIncludes(w.out, "merged")
  assertStringIncludes(w.out, "NOT verified")
})

// ============================================================ §2 finding 2
Deno.test("DESIRED §2.2: a worker writing outside its scope is not merged", () => {
  // Was CHARACTERIZATION: scope was prose in the prompt and nothing compared
  // it to the diff, so the out-of-scope file merged. Enforced as of the scope
  // work — every rename endpoint, deletion, mode change and symlink counts.
  // See test/scope_test.ts for the full matrix (§9.10).
  const dir = repo(`echo out > outside.txt`)
  feed(dir, "escapes scope", "src/**", { GATOR_VERIFY: "true" })
  const w = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(w.out, "out_of_scope")
  assertEquals(existsSync(join(dir, "outside.txt")), false, "the out-of-scope file was held")
})

// ============================================================ §2 finding 3
Deno.test("CHARACTERIZATION §2.3: partial work that admits it is incomplete still merges", () => {
  // Process success plus a passing generic test does not prove completion.
  // Step 3 requires evidence mapped to every acceptance criterion (§9.11).
  const dir = repo(`echo partial > half.txt; echo "I could not finish: requirements missing"`)
  feed(dir, "half done", "**", { GATOR_VERIFY: "true" })
  const w = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(w.out, "merged")
})

// ============================================================ §2 finding 4
Deno.test("DESIRED §2.4: the record pins the target ref captured at feed time", () => {
  // The merge itself is not yet bound to it — step 3 enforces that (§9.12) —
  // but the intended target is now recorded rather than inferred at finalise.
  const dir = repo(`echo work > out.txt`)
  feed(dir, "pins target", "**", { GATOR_VERIFY: "true" })
  run(dir, ["wait", "--no-merge"], { GATOR_VERIFY: "true" })
  const r = JSON.parse(readFileSync(join(dir, ".gator", "pins-target.record.json"), "utf8"))
  assertEquals(r.target_ref, "refs/heads/main")
  assertEquals(r.base_sha.length, 40)
})

Deno.test("CHARACTERIZATION §2.4: finalising after a branch switch merges into the new branch", () => {
  // Step 3 refuses as stale_target instead (§9.12).
  const dir = repo(`echo work > out.txt`)
  feed(dir, "switcheroo", "**", { GATOR_VERIFY: "true" })
  run(dir, ["wait", "--no-merge"], { GATOR_VERIFY: "true" })
  git(dir, "checkout", "-q", "-b", "elsewhere")
  const w = run(dir, ["status"], { GATOR_VERIFY: "true" })
  assertStringIncludes(w.out, "merged")
  const branch = new Deno.Command("git", { args: ["branch", "--show-current"], cwd: dir })
    .outputSync()
  assertEquals(new TextDecoder().decode(branch.stdout).trim(), "elsewhere")
  assertEquals(existsSync(join(dir, "out.txt")), true, "merged into the branch checked out now")
})

// ============================================================ §2 finding 5
Deno.test("DESIRED §2.5: a worker that exits nonzero without committing is failed", () => {
  // Was reported `empty`, hiding the failure. Fixed by the outcome precedence
  // in Task 2: a failure cause outranks the absence of output.
  const dir = repo(`exit 7`)
  feed(dir, "exits seven", "**", { GATOR_VERIFY: "true" })
  const w = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(w.out, "failed")
  const r = JSON.parse(readFileSync(join(dir, ".gator", "exits-seven.record.json"), "utf8"))
  assertEquals(r.worker.rc, 7)
  assertEquals(r.outcome, "failed")
})

// ============================================================ §2 finding 6
Deno.test("DESIRED §2.6: a failing verifier leaves the unit unmerged with its worktree", () => {
  // An existing safeguard. Pinned so later refactoring cannot lose it.
  const dir = repo(`echo work > out.txt`)
  feed(dir, "red build", "**", { GATOR_VERIFY: "false" })
  const w = waitForUnit(dir, { GATOR_VERIFY: "false" })
  assertStringIncludes(w.out, "unverified")
  assertEquals(existsSync(join(dir, "out.txt")), false, "nothing merged")
  assertEquals(
    existsSync(join(dir, ".gator", "worktrees", "red-build")),
    true,
    "worktree kept for inspection",
  )
})

// ============================================================ §2 finding 7
Deno.test("CHARACTERIZATION §2.7: two units green apart merge into a red combined tree", () => {
  // The reproduced disjoint-file conflict. Each unit passes the verifier in
  // its own worktree; the merged tree fails the same verifier. Step 4 verifies
  // the exact integration candidate instead (§9.13).
  const V = "test ! -f a.txt || test ! -f b.txt"
  // One stub, two branches: the file it writes is named after the branch, so a
  // single worker command serves both units.
  const dir = repo(`n=$(git rev-parse --abbrev-ref HEAD); echo x > "\${n##*-}.txt"`)

  // Both must be in flight before either merges, so both branch from a base
  // holding neither file. Feeding them one after the other would give the
  // second a worktree that already contains the first's file, and its verifier
  // would — correctly — fail there.
  feed(dir, "unit a", "a.txt", { GATOR_VERIFY: V })
  feed(dir, "unit b", "b.txt", { GATOR_VERIFY: V })
  waitForUnit(dir, { GATOR_VERIFY: V })

  assertEquals(
    existsSync(join(dir, "a.txt")) && existsSync(join(dir, "b.txt")),
    true,
    "both merged",
  )
  const combined = new Deno.Command("bash", { args: ["-c", V], cwd: dir }).outputSync()
  assertEquals(combined.success, false, "the combined tree fails the verifier both units passed")
})
