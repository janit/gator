import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dirname!, "../skill/gator/gator")
const workerPath = new Map<string, string>()
const LONG_TASK = "x".repeat(300)

function git(cwd: string, ...args: string[]) {
  const { success, stderr } = new Deno.Command("git", { args, cwd }).outputSync()
  if (!success) throw new Error(new TextDecoder().decode(stderr))
}

/** A repo with a stub "worker", so every test runs without touching a model. */
function repo(worker: string, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gator-"))
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
  writeFileSync(join(dir, "base.txt"), "base\n")
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "base")

  // The stub lives outside the repo, so the caller's tree stays clean — a dirty
  // tree holds merges, which is the behaviour under test further down.
  const bin = mkdtempSync(join(tmpdir(), "gator-worker-"))
  writeFileSync(join(bin, "worker.sh"), worker)
  chmodSync(join(bin, "worker.sh"), 0o755)
  workerPath.set(dir, join(bin, "worker.sh"))
  return dir
}

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const { code, stdout, stderr } = new Deno.Command(SCRIPT, {
    args,
    cwd: dir,
    env: {
      // A developer's own resources file may configure a classifier. The suite
      // must never send task text to it, so the default is no file at all.
      GATOR_RESOURCES: "/dev/null",
      GATOR_ROLE_heavy: "stub/model",
      GATOR_WORKER_CMD: `bash ${workerPath.get(dir)}`,
      GATOR_COOLDOWN: "0",
      GATOR_POLL: "0.2",
      ...env,
    },
  }).outputSync()
  const d = new TextDecoder()
  return { code, out: d.decode(stdout) + d.decode(stderr) }
}

const waitForUnit = (dir: string, env: Record<string, string> = {}) => run(dir, ["wait"], env)

// ---------------------------------------------------------------- guardrails

Deno.test("refuses a task below the complexity floor", () => {
  const r = run(repo("echo hi"), [
    "feed",
    "--title",
    "tiny",
    "--scope",
    "a.ts",
    "--task",
    "too short",
  ])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "too small a chunk")
})

Deno.test("refuses a unit with no scope", () => {
  const r = run(repo("echo hi"), [
    "feed",
    "--title",
    "no scope",
    "--scope",
    "",
    "--task",
    LONG_TASK,
  ])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "names no scope")
})

Deno.test("refuses an unconfigured role", () => {
  const r = run(repo("echo hi"), [
    "--title",
    "x",
    "--role",
    "nope",
    "--scope",
    "a",
    "--task",
    LONG_TASK,
  ])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "not configured")
})

Deno.test("refuses a duplicate task in the same session", () => {
  const dir = repo("echo hi > f.txt")
  assertEquals(
    run(dir, ["feed", "--title", "one", "--scope", "f.txt", "--task", LONG_TASK]).code,
    0,
  )
  waitForUnit(dir)
  const second = run(dir, ["feed", "--title", "two", "--scope", "f.txt", "--task", LONG_TASK])
  assertEquals(second.code, 2)
  assertStringIncludes(second.out, "already been fed")
})

Deno.test("refuses once the session budget is spent", () => {
  const r = run(repo("echo hi > f.txt"), [
    "--title",
    "one",
    "--scope",
    "f.txt",
    "--task",
    LONG_TASK,
  ], {
    GATOR_MAX_PER_SESSION: "0",
  })
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "feeding budget spent")
})

Deno.test("refuses outside a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "gator-nogit-"))
  workerPath.set(dir, "/bin/true")
  const r = run(dir, ["feed", "--title", "x", "--scope", "a", "--task", LONG_TASK])
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "not a git repository")
})

// ------------------------------------------------------------------ statuses

Deno.test("a clean, green unit is merged and its worktree removed", () => {
  const dir = repo("echo added > added.txt", { "deno.json": '{"tasks":{"test":"true"}}' })
  const started = run(
    dir,
    ["--title", "adds a file", "--scope", "added.txt", "--task", LONG_TASK],
    {
      GATOR_VERIFY: "true",
    },
  )
  assertEquals(started.code, 0)
  assertStringIncludes(started.out, "verify before merge: true")
  const done = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(done.out, "→ merged")
  assertStringIncludes(done.out, "verified green")
  assert(existsSync(join(dir, "added.txt")))
  assertFalse(existsSync(join(dir, ".gator/worktrees/adds-a-file")))
})

Deno.test("a unit that fails verification is NOT merged and keeps its worktree", () => {
  const dir = repo("echo broken > broken.txt")
  run(dir, ["feed", "--title", "breaks the build", "--scope", "broken.txt", "--task", LONG_TASK], {
    GATOR_VERIFY: "echo 'compile error: everything is on fire' >&2; exit 1",
  })
  const done = waitForUnit(dir, { GATOR_VERIFY: "echo x; exit 1" })
  assertStringIncludes(done.out, "→ unverified")
  assertStringIncludes(done.out, "NOT merged")
  assertStringIncludes(done.out, "everything is on fire")
  // committed on its branch, but it never reached the caller's tree
  assertFalse(existsSync(join(dir, "broken.txt")))
  assert(existsSync(join(dir, ".gator/worktrees/breaks-the-build")))
})

Deno.test("a worker that commits nothing reports empty, not success", () => {
  const dir = repo("true")
  run(dir, ["feed", "--title", "does nothing", "--scope", "a.ts", "--task", LONG_TASK], {
    GATOR_VERIFY: "true",
  })
  const done = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(done.out, "→ empty")
  assertFalse(done.out.includes("→ merged"))
})

Deno.test("uncommitted worker output is captured rather than lost", () => {
  const dir = repo("echo stray > stray.txt")
  run(dir, ["feed", "--title", "forgets to commit", "--scope", "stray.txt", "--task", LONG_TASK], {
    GATOR_VERIFY: "true",
  })
  const done = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(done.out, "→ merged")
  assertEquals(readFileSync(join(dir, "stray.txt"), "utf8").trim(), "stray")
})

Deno.test("a green unit is held, not merged, while the caller's tree is dirty", () => {
  const dir = repo("echo added > added.txt")
  run(dir, ["feed", "--title", "held unit", "--scope", "added.txt", "--task", LONG_TASK], {
    GATOR_VERIFY: "true",
  })
  writeFileSync(join(dir, "base.txt"), "edited by the human\n")
  const held = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(held.out, "→ ready (held")
  assertFalse(existsSync(join(dir, "added.txt")))

  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "human work")
  const merged = run(dir, ["status"], { GATOR_VERIFY: "true" })
  assertStringIncludes(merged.out, "→ merged")
  assert(existsSync(join(dir, "added.txt")))
})

Deno.test("a role can come from a file instead of the environment", () => {
  const dir = repo("echo added > added.txt")
  mkdirSync(join(dir, ".gator"), { recursive: true })
  writeFileSync(join(dir, ".gator", "roles"), "# a comment\nheavy = stub/from-file\n")
  const started = run(dir, [
    "feed",
    "--title",
    "file role",
    "--scope",
    "added.txt",
    "--task",
    LONG_TASK,
  ], {
    GATOR_ROLE_heavy: "",
    GATOR_VERIFY: "true",
    // Repository-supplied config is ignored unless the user opts in: a cloned
    // .gator/roles can name the command that runs. See test/security_test.ts.
    GATOR_TRUST_REPO_CONFIG: "1",
  })
  assertEquals(started.code, 0)
  assertStringIncludes(started.out, "model=stub/from-file")
  waitForUnit(dir, {
    GATOR_ROLE_heavy: "",
    GATOR_VERIFY: "true",
    GATOR_TRUST_REPO_CONFIG: "1",
  })
})

Deno.test("COMPAT: a role from the user's own file needs no opt-in", () => {
  // The behaviour change is scoped to *repository* config. The user's own
  // roles file works exactly as it always did.
  const dir = repo("echo hi")
  const userRoles = join(mkdtempSync(join(tmpdir(), "gator-roles-")), "roles")
  writeFileSync(userRoles, "heavy = stub/user-file\n")
  const started = run(dir, [
    "feed",
    "--title",
    "user file role",
    "--scope",
    "added.txt",
    "--task",
    LONG_TASK,
  ], { GATOR_ROLE_heavy: "", GATOR_ROLES: userRoles, GATOR_VERIFY: "true" })
  assertEquals(started.code, 0, started.out)
  assertStringIncludes(started.out, "model=stub/user-file")
})

Deno.test("the bare flag form still works, without the verb", () => {
  // v0.0.1 shipped `gator --title ...` and `gator --wait`; anything already
  // calling that must keep working.
  const dir = repo("echo added > added.txt")
  const started = run(dir, ["--title", "no verb", "--scope", "added.txt", "--task", LONG_TASK], {
    GATOR_VERIFY: "true",
  })
  assertEquals(started.code, 0)
  assertStringIncludes(started.out, "FED")
  const done = run(dir, ["--wait"], { GATOR_VERIFY: "true" })
  assertStringIncludes(done.out, "→ merged")
})

Deno.test("status before anything is delegated reports the verify command", () => {
  const dir = repo("true", { "deno.json": '{"tasks":{"build":"x","test":"y"}}' })
  const r = run(dir, ["status"])
  assertStringIncludes(r.out, "the gator has not been fed yet")
  assertStringIncludes(r.out, "deno task build && deno task test")
})
