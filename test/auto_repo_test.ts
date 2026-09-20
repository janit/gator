import { assertEquals, assertStringIncludes } from "@std/assert"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { git, repo, run } from "./harness.ts"

const auto = (dir: string, args: string[], env: Record<string, string> = {}) =>
  run(dir, ["auto", ...args], env)

function commit(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), body)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", name)
}

Deno.test("auto plan refuses a source that is not committed", () => {
  const dir = repo("echo hi")
  writeFileSync(join(dir, "SPEC.md"), "# spec\n") // written but not committed
  const r = auto(dir, ["plan", "--from", "SPEC.md", "--json"])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "source_not_committed")
})

Deno.test("auto plan refuses an absent source", () => {
  const r = auto(repo("echo hi"), ["plan", "--from", "NOPE.md", "--json"])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "source_missing")
})

Deno.test("auto plan refuses a path escaping the repository", () => {
  const r = auto(repo("echo hi"), ["plan", "--from", "../outside.md", "--json"])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "source_outside_repo")
})

Deno.test("auto plan refuses an absolute source path", () => {
  const r = auto(repo("echo hi"), ["plan", "--from", "/etc/passwd", "--json"])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "source_outside_repo")
})

Deno.test("auto plan refuses a source over 128 KiB", () => {
  const dir = repo("echo hi")
  commit(dir, "BIG.md", "x".repeat(129 * 1024))
  const r = auto(dir, ["plan", "--from", "BIG.md", "--json"])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "source_too_large")
})

Deno.test("auto plan refuses a detached HEAD", () => {
  const dir = repo("echo hi")
  commit(dir, "SPEC.md", "# spec\n")
  const sha = new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: dir }).outputSync()
  git(dir, "checkout", "-q", new TextDecoder().decode(sha.stdout).trim())
  const r = auto(dir, ["plan", "--from", "SPEC.md", "--json"])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "detached_head")
})

Deno.test("auto refuses a verb that does not exist yet rather than guessing", () => {
  const r = auto(repo("echo hi"), ["run", "--plan", "x"])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "verb_unavailable")
})

Deno.test("auto refuses outside a git repository", () => {
  const { code, stdout, stderr } = new Deno.Command(
    join(import.meta.dirname!, "../skill/gator/gator"),
    { args: ["auto", "plan", "--from", "SPEC.md", "--json"], cwd: "/tmp" },
  ).outputSync()
  const d = new TextDecoder()
  assertEquals(code, 2)
  assertStringIncludes(d.decode(stdout) + d.decode(stderr), "not a git repository")
})
