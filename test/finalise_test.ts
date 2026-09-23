// Finalising: the outcomes that do not end in a merge, and what is left behind.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { feed, repo, run, waitForUnit } from "./harness.ts"

const branchExists = (dir: string, branch: string) =>
  new Deno.Command("git", {
    args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd: dir,
  }).outputSync().success

const porcelain = (dir: string) =>
  new TextDecoder().decode(
    new Deno.Command("git", { args: ["status", "--porcelain"], cwd: dir }).outputSync().stdout,
  ).trim()

Deno.test("a failed unit stays listed by later status calls until its branch is gone", () => {
  const dir = repo(`echo half > half.txt; git add -A; git commit -qm half; exit 7`)
  feed(dir, "falls over", "**", { GATOR_VERIFY: "true" })
  const first = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(first.out, "failed")

  // Reported once is not resolved: a missed first line must not hide it.
  const again = run(dir, ["status"], { GATOR_VERIFY: "true" })
  assertStringIncludes(again.out, 'falls-over" → failed (reported earlier, not merged')

  new Deno.Command("git", {
    args: ["worktree", "remove", "--force", ".gator/worktrees/falls-over"],
    cwd: dir,
  })
    .outputSync()
  new Deno.Command("git", { args: ["branch", "-D", "gator/falls-over"], cwd: dir }).outputSync()
  const cleared = run(dir, ["status"], { GATOR_VERIFY: "true" })
  assertEquals(cleared.out.includes("falls-over"), false, cleared.out)
})

Deno.test("a merged unit is not listed again", () => {
  const dir = repo(`echo work > out.txt`)
  feed(dir, "lands", "**", { GATOR_VERIFY: "true" })
  assertStringIncludes(waitForUnit(dir, { GATOR_VERIFY: "true" }).out, "merged")
  assertEquals(run(dir, ["status"], { GATOR_VERIFY: "true" }).out.includes("lands"), false)
})

Deno.test("a real merge conflict is aborted cleanly and the branch kept", () => {
  // Both units write the same line of the same file, so the second conflicts.
  const dir = repo(`n=$(git rev-parse --abbrev-ref HEAD); echo "$n" > base.txt`)
  feed(dir, "writer a", "base.txt", { GATOR_VERIFY: "true" })
  feed(dir, "writer b", "base.txt", { GATOR_VERIFY: "true" })
  const w = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(w.out, "conflicted")
  assertEquals(readFileSync(join(dir, "base.txt"), "utf8"), "gator/writer-a\n")
  assertEquals(porcelain(dir), "", "the caller's tree is left clean")
  assertEquals(branchExists(dir, "gator/writer-b"), true, "the conflicting branch is kept")
  const rec = JSON.parse(readFileSync(join(dir, ".gator", "writer-b.record.json"), "utf8"))
  assertEquals(rec.finalised, "conflicted")
  assertStringIncludes(
    run(dir, ["status"], { GATOR_VERIFY: "true" }).out,
    'writer-b" → conflicted (reported earlier',
  )
})

Deno.test("an empty unit's worktree and branch are both removed", () => {
  const dir = repo(`true`)
  feed(dir, "does nothing", "**", { GATOR_VERIFY: "true" })
  assertStringIncludes(waitForUnit(dir, { GATOR_VERIFY: "true" }).out, "empty")
  assertEquals(existsSync(join(dir, ".gator", "worktrees", "does-nothing")), false)
  assertEquals(branchExists(dir, "gator/does-nothing"), false)
})
