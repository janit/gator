// Scope enforcement: spec section 7, "Compare the entire base-to-result diff,
// including every rename endpoint, deletion, new file, mode change and
// symlink." Until now --scope was prose in the worker's prompt and nothing
// ever compared it to what the worker did.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { feed, repo, waitForUnit } from "./harness.ts"

const rec = (dir: string, slug: string) =>
  JSON.parse(readFileSync(join(dir, ".gator", `${slug}.record.json`), "utf8"))

const V = { GATOR_VERIFY: "true" }

Deno.test("SCOPE: a worker writing outside its scope is not merged", () => {
  const dir = repo(`echo out > outside.txt`)
  feed(dir, "escapes", "src/**", V)
  const w = waitForUnit(dir, V)

  assertStringIncludes(w.out, "out_of_scope")
  assertEquals(existsSync(join(dir, "outside.txt")), false, "nothing merged")
  assertEquals(existsSync(join(dir, ".gator", "worktrees", "escapes")), true, "worktree kept")
  assertStringIncludes(w.out, "outside.txt")
})

Deno.test("SCOPE: a worker staying inside its scope still merges", () => {
  const dir = repo(`mkdir -p src && echo ok > src/new.ts`)
  feed(dir, "stays in", "src/**", V)
  const w = waitForUnit(dir, V)
  assertStringIncludes(w.out, "merged")
  assertEquals(existsSync(join(dir, "src", "new.ts")), true)
})

Deno.test("SCOPE: an exact path scope matches only that path", () => {
  const ok = repo(`echo a > a.txt`)
  feed(ok, "exact ok", "a.txt", V)
  assertStringIncludes(waitForUnit(ok, V).out, "merged")

  const bad = repo(`echo b > b.txt`)
  feed(bad, "exact bad", "a.txt", V)
  assertStringIncludes(waitForUnit(bad, V).out, "out_of_scope")
})

Deno.test("SCOPE: ** is the documented way to decline scoping", () => {
  // A human may scope broadly; the planner may not. validate_scope still
  // refuses ** from a model — see test/auto_validation_test.ts.
  const dir = repo(`echo anywhere > anywhere.txt`)
  feed(dir, "unscoped", "**", V)
  assertStringIncludes(waitForUnit(dir, V).out, "merged")
})

Deno.test("SCOPE: a deletion outside scope is a violation", () => {
  const dir = repo(`rm base.txt`)
  feed(dir, "deletes", "src/**", V)
  const w = waitForUnit(dir, V)
  assertStringIncludes(w.out, "out_of_scope")
  assertEquals(existsSync(join(dir, "base.txt")), true, "the deletion did not land")
})

Deno.test("SCOPE: both endpoints of a rename are checked", () => {
  // Renaming an in-scope file to an out-of-scope path moves work out of the
  // declared area, and a diff that only looked at one endpoint would miss it.
  const dir = repo(
    `mkdir -p src && git mv base.txt src/moved.txt 2>/dev/null || { mkdir -p src; mv base.txt src/moved.txt; }`,
  )
  feed(dir, "renames out", "src/**", V)
  const w = waitForUnit(dir, V)
  assertStringIncludes(w.out, "out_of_scope")
  assertStringIncludes(w.out, "base.txt")
})

Deno.test("SCOPE: a mode change outside scope is a violation", () => {
  const dir = repo(`chmod +x base.txt`)
  feed(dir, "chmods", "src/**", V)
  assertStringIncludes(waitForUnit(dir, V).out, "out_of_scope")
})

Deno.test("SCOPE: a symlink outside scope is a violation", () => {
  const dir = repo(`ln -s /etc/passwd link.txt`)
  feed(dir, "symlinks", "src/**", V)
  assertStringIncludes(waitForUnit(dir, V).out, "out_of_scope")
})

Deno.test("SCOPE: the violation is recorded, not only printed", () => {
  const dir = repo(`echo out > outside.txt`)
  feed(dir, "recorded", "src/**", V)
  waitForUnit(dir, V)
  const r = rec(dir, "recorded")
  assertEquals(r.outcome, "out_of_scope")
  assertEquals(r.scope.checked, true)
  assertStringIncludes(JSON.stringify(r.scope.violations), "outside.txt")
})

Deno.test("SCOPE: a failing worker still reports the failure, not the scope", () => {
  // Precedence, spec section 7: the worker's own failure outranks scope.
  const dir = repo(`echo out > outside.txt; exit 3`)
  feed(dir, "fails and strays", "src/**", V)
  assertStringIncludes(waitForUnit(dir, V).out, "failed")
})

Deno.test("SCOPE: scope outranks a failing verifier", () => {
  // Also precedence: invalid scope comes before verification failure, because
  // a unit that wrote where it should not is not made acceptable by a red
  // build, and the scope is the more actionable fact.
  const dir = repo(`echo out > outside.txt`)
  feed(dir, "strays and breaks", "src/**", { GATOR_VERIFY: "false" })
  assertStringIncludes(waitForUnit(dir, { GATOR_VERIFY: "false" }).out, "out_of_scope")
})
