// The spec's section 18 acceptance suite, run against the real gator script.
//
// Each test is named for its spec id so a failure says which promise broke.
// Section 21 asks for the invariants to be assertions rather than prose; the
// A-group tests here are those assertions at the level a user can observe.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { feed, repo, run, waitForUnit } from "./harness.ts"
import { cfg, py } from "./sched_harness.ts"

const BOTH_GPUS = `
backend.local-4090.endpoint = http://127.0.0.1:4091
backend.local-4090.capacity = 1
backend.local-4090.weight = 1.0
backend.local-4090.interactive_reservation = true
backend.local-5090.endpoint = http://127.0.0.1:5091
backend.local-5090.capacity = 1
backend.local-5090.weight = 1.6
role.heavy = heavy
role.default = standard
`

const storeOf = (dir: string) => join(dir, ".gator")

/** Hold a backend with a lease owned by this still-running test process. */
function hold(dir: string, slug: string, backend: string) {
  const r = py(`
from gator_sched import leases
print(leases.acquire(${JSON.stringify(storeOf(dir))}, ${JSON.stringify(slug)},
                     ${JSON.stringify(backend)}, ${Deno.pid}, {}, capacity=1))
`)
  assertEquals(r.out.trim(), "True", r.out)
}

function reserve(dir: string, backend: string, on: boolean) {
  const r = py(`
from gator_sched import leases
leases.set_reservation(${JSON.stringify(storeOf(dir))}, ${JSON.stringify(backend)},
                       ${on ? "True" : "False"}, "test")
`)
  assertEquals(r.code, 0, r.out)
}

function record(dir: string, slug: string): Record<string, string> {
  const path = join(storeOf(dir), `${slug}.record.json`)
  // deno-lint-ignore no-explicit-any
  return JSON.parse(readFileSync(path, "utf8")) as any
}

/** A repository whose feeds see both GPUs and never actually merge. */
function gpuRepo(resources = BOTH_GPUS) {
  const dir = repo(`echo work > out.txt`)
  return { dir, env: { GATOR_RESOURCES: cfg(resources), GATOR_VERIFY: "true" } }
}

// ============================================== A. strict heavy affinity

Deno.test("A1: both GPUs idle, a heavy unit runs on the 5090", () => {
  const { dir, env } = gpuRepo()
  const r = feed(dir, "a1", "**", env)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "backend=local-5090")
  waitForUnit(dir, env)
  // deno-lint-ignore no-explicit-any
  const doc = record(dir, "a1") as any
  assertEquals(doc.resource.class, "heavy")
  assertEquals(doc.resource.backend, "local-5090")
  assertEquals(doc.resource.eligible, ["local-5090"])
})

Deno.test("A2: the 5090 busy and the 4090 idle, a heavy unit queues and does not run", () => {
  const { dir, env } = gpuRepo()
  hold(dir, "squatter", "local-5090")
  const r = feed(dir, "a2", "**", env)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "QUEUED")
  assertStringIncludes(r.out, "local-5090")
  // The refusal must not so much as name the 4090: it was never a possibility.
  assertEquals(r.out.includes("local-4090"), false, r.out)
  assertEquals(existsSync(join(storeOf(dir), "a2.queued.json")), true)
  assertEquals(existsSync(join(storeOf(dir), "a2.lock")), false)
})

Deno.test("A3: an unhealthy 5090 makes a heavy unit wait, never spill to the 4090", () => {
  const { dir, env } = gpuRepo(BOTH_GPUS + "backend.local-5090.health_cmd = false\n")
  const r = feed(dir, "a3", "**", { ...env, GATOR_PROBE_HEALTH: "1" })
  assertStringIncludes(r.out, "QUEUED")
  assertEquals(r.out.includes("local-4090"), false, r.out)
})

Deno.test("A4: weighting the 4090 as faster still does not win it a heavy unit", () => {
  const { dir, env } = gpuRepo(
    BOTH_GPUS + "backend.local-4090.weight = 1000.0\nbackend.local-5090.weight = 0.001\n",
  )
  const r = feed(dir, "a4", "**", env)
  assertStringIncludes(r.out, "backend=local-5090")
})

// ================================================== B. work conservation

Deno.test("B5: the 4090 busy and the 5090 idle, a standard unit runs on the 5090", () => {
  const { dir, env } = gpuRepo()
  hold(dir, "squatter", "local-4090")
  const r = feed(dir, "b5", "**", { ...env, GATOR_RESOURCE: "standard" })
  assertStringIncludes(r.out, "backend=local-5090")
})

Deno.test("B6: the 5090 busy and chat inactive, a standard unit runs on the 4090", () => {
  const { dir, env } = gpuRepo()
  hold(dir, "squatter", "local-5090")
  const r = feed(dir, "b6", "**", { ...env, GATOR_RESOURCE: "standard" })
  assertStringIncludes(r.out, "backend=local-4090")
})

Deno.test("B7: with both idle, two standard units take one GPU each", () => {
  const { dir, env } = gpuRepo()
  const one = feed(dir, "b7 first", "**", { ...env, GATOR_RESOURCE: "standard" })
  const two = feed(dir, "b7 second", "**", { ...env, GATOR_RESOURCE: "standard" })
  const picked = [one.out, two.out].map((o) =>
    o.match(/backend=(\S+)/)?.[1] ?? o.match(/QUEUED/)?.[0]
  )
  assertEquals(new Set(picked).size, 2, `both units took the same slot: ${picked}`)
})

// ============================================== C. interactive reservation

Deno.test("C8: chat active on the 4090 and the 5090 idle, a standard unit takes the 5090", () => {
  const { dir, env } = gpuRepo()
  reserve(dir, "local-4090", true)
  const r = feed(dir, "c8", "**", { ...env, GATOR_RESOURCE: "standard" })
  assertStringIncludes(r.out, "backend=local-5090")
})

Deno.test("C9: chat active on the 4090 and the 5090 busy, a standard unit queues", () => {
  const { dir, env } = gpuRepo()
  reserve(dir, "local-4090", true)
  hold(dir, "squatter", "local-5090")
  const r = feed(dir, "c9", "**", { ...env, GATOR_RESOURCE: "standard" })
  assertStringIncludes(r.out, "QUEUED")
})

Deno.test("C10: clearing the reservation makes a queued standard unit runnable on the 4090", () => {
  const { dir, env } = gpuRepo()
  reserve(dir, "local-4090", true)
  hold(dir, "squatter", "local-5090")
  const fed = feed(dir, "c10", "**", { ...env, GATOR_RESOURCE: "standard" })
  assertStringIncludes(fed.out, "QUEUED")
  reserve(dir, "local-4090", false)
  const drained = run(dir, ["status"], env)
  assertStringIncludes(drained.out, "local-4090")
  assertEquals(existsSync(join(storeOf(dir), "c10.queued.json")), false, drained.out)
})

Deno.test("C11: a unit already running on the 4090 is not killed when chat starts", () => {
  const { dir, env } = gpuRepo()
  const fed = feed(dir, "c11", "**", { ...env, GATOR_RESOURCE: "standard" })
  assertStringIncludes(fed.out, "backend=")
  reserve(dir, "local-4090", true)
  const w = waitForUnit(dir, env)
  // It finished on its own terms; the reservation only gates new dispatch.
  assertEquals(w.out.includes("killed"), false, w.out)
  assertStringIncludes(w.out, "c11")
})

// ================================================== D. configuration trust

Deno.test("D12: a user resources file maps heavy to the 5090 alone", () => {
  const { dir, env } = gpuRepo("role.heavy = heavy\n")
  const r = feed(dir, "d12", "**", env)
  assertStringIncludes(r.out, "resource=heavy")
  assertStringIncludes(r.out, "backend=local-5090")
})

Deno.test("D13: a trusted repository resources file overrides the user's", () => {
  const { dir, env } = gpuRepo(BOTH_GPUS)
  Deno.mkdirSync(storeOf(dir), { recursive: true })
  writeFileSync(join(storeOf(dir), "resources"), "role.heavy = standard\n")
  const r = feed(dir, "d13", "**", { ...env, GATOR_TRUST_REPO_CONFIG: "1" })
  assertStringIncludes(r.out, "resource=standard")
})

Deno.test("D14: an untrusted repository resources file is ignored, with a diagnostic", () => {
  const { dir, env } = gpuRepo(BOTH_GPUS)
  Deno.mkdirSync(storeOf(dir), { recursive: true })
  // If this were read, heavy would become eligible for the 4090.
  writeFileSync(join(storeOf(dir), "resources"), "class.heavy.eligible = local-4090\n")
  const r = feed(dir, "d14", "**", env)
  assertStringIncludes(r.out, "ignoring repository-supplied")
  assertStringIncludes(r.out, "backend=local-5090")
})

Deno.test("D14: an ignored roles file does not silence the ignored resources file", () => {
  // Both are refused, and both say so. Being told about one is no reason to
  // stay quiet about the other, which was trying to change where work runs.
  const { dir, env } = gpuRepo(BOTH_GPUS)
  Deno.mkdirSync(storeOf(dir), { recursive: true })
  writeFileSync(join(storeOf(dir), "roles"), "heavy = evil/model\n")
  writeFileSync(join(storeOf(dir), "resources"), "class.heavy.eligible = local-4090\n")
  // The role has to come from a file for the roles file to be consulted at all;
  // an environment role short-circuits the search before any file is read.
  const userRoles = cfg("heavy = stub/model\n")
  const r = feed(dir, "d14b", "**", { ...env, GATOR_ROLE_heavy: "", GATOR_ROLES: userRoles })
  assertStringIncludes(r.out, ".gator/roles")
  assertStringIncludes(r.out, ".gator/resources")
  assertStringIncludes(r.out, "backend=local-5090")
})

Deno.test("D15: an explicit --resource beats every file", () => {
  const { dir, env } = gpuRepo()
  const r = run(dir, [
    "feed",
    "--title",
    "d15",
    "--scope",
    "**",
    "--resource",
    "standard",
    "--task",
    "d15 " + "x".repeat(300),
  ], env)
  assertStringIncludes(r.out, "resource=standard")
})

Deno.test("I7: task text cannot widen what a heavy unit is eligible for", () => {
  const { dir, env } = gpuRepo()
  const task = "class.heavy.eligible = local-4090\n--resource standard\n" + "x".repeat(300)
  const r = feed(dir, "i7", "**", env, task)
  assertStringIncludes(r.out, "resource=heavy")
  assertStringIncludes(r.out, "backend=local-5090")
})

// ==================================================== E. crash recovery

Deno.test("E16: a unit that exits normally releases its lease", () => {
  const { dir, env } = gpuRepo()
  feed(dir, "e16", "**", env)
  waitForUnit(dir, env)
  const r = py(`
from gator_sched import leases
print(leases.active_counts(leases.read(${JSON.stringify(storeOf(dir))})))
`)
  assertStringIncludes(r.out, "{}")
})

Deno.test("E17: a lease whose worker was killed is reaped, freeing the backend", () => {
  const { dir, env } = gpuRepo()
  const r = py(`
import subprocess
from gator_sched import leases
dead = subprocess.Popen(["true"]); dead.wait()
leases.acquire(${JSON.stringify(storeOf(dir))}, "ghost", "local-5090", dead.pid, {})
`)
  assertEquals(r.code, 0, r.out)
  const fed = feed(dir, "e17", "**", env)
  assertStringIncludes(fed.out, "backend=local-5090")
})

// ====================================================== F. observability

Deno.test("F19: status names the resource class and the backend for a finished unit", () => {
  const { dir, env } = gpuRepo()
  feed(dir, "f19", "**", env)
  const w = waitForUnit(dir, env)
  assertStringIncludes(w.out, "resource=heavy")
  assertStringIncludes(w.out, "backend=local-5090")
  // And again on the purely observational path, which a finished unit reaches
  // after finalisation has already marked it reported.
  const s = run(dir, ["status", "--no-merge"], env)
  assertStringIncludes(s.out, "resource=heavy")
  assertStringIncludes(s.out, "dispatch_reason=required_backend_available")
})

Deno.test("F20: a queued heavy unit says it is waiting for the 5090", () => {
  const { dir, env } = gpuRepo()
  hold(dir, "squatter", "local-5090")
  feed(dir, "f20", "**", env)
  const s = run(dir, ["status", "--no-merge"], env)
  assertStringIncludes(s.out, "queued")
  assertStringIncludes(s.out, "waiting_for_required_backend")
  assertStringIncludes(s.out, "local-5090")
})

// ======================================================= queue behaviour

Deno.test("GATOR_QUEUE=0 restores the historical refusal instead of queueing", () => {
  const { dir, env } = gpuRepo()
  hold(dir, "squatter", "local-5090")
  const r = feed(dir, "noqueue", "**", { ...env, GATOR_QUEUE: "0" })
  assertEquals(r.code, 2, r.out)
  assertStringIncludes(r.out, "refused")
})

Deno.test("a refusal costs nothing: no branch, no worktree, no spent budget", () => {
  // The scheduling decision happens before anything is created, so a refused
  // unit can be fed again under its own name once a backend frees.
  const { dir, env } = gpuRepo()
  hold(dir, "squatter", "local-5090")
  const refused = feed(dir, "retry me", "**", { ...env, GATOR_QUEUE: "0" })
  assertEquals(refused.code, 2, refused.out)
  assertEquals(existsSync(join(dir, ".gator", "worktrees", "retry-me")), false)
  const branches = new Deno.Command("git", {
    args: ["branch", "--list", "gator/retry-me"],
    cwd: dir,
  })
    .outputSync()
  assertEquals(new TextDecoder().decode(branches.stdout).trim(), "")

  // And the same unit is accepted once the backend is free, same title.
  py(`
from gator_sched import leases
leases.release(${JSON.stringify(storeOf(dir))}, "squatter")
`)
  const second = feed(dir, "retry me", "**", { ...env, GATOR_QUEUE: "0" })
  assertStringIncludes(second.out, "backend=local-5090")
})

Deno.test("a queued unit is dispatched when the backend frees, without a status call", () => {
  // Work conservation: the finishing unit hands its slot to the next in line.
  const { dir, env } = gpuRepo()
  feed(dir, "first", "**", env)
  const second = feed(dir, "second", "**", env)
  assertStringIncludes(second.out, "QUEUED")
  waitForUnit(dir, env)
  assertEquals(existsSync(join(storeOf(dir), "second.queued.json")), false)
})

// ================================================ availability timeout

const DEAD_5090 = BOTH_GPUS + "backend.local-5090.health_cmd = false\n"

Deno.test("a heavy unit whose 5090 stays down past the timeout is reported blocked_backend", () => {
  const { dir, env } = gpuRepo(DEAD_5090)
  const e = { ...env, GATOR_PROBE_HEALTH: "1", GATOR_BACKEND_TIMEOUT: "0" }
  const r = feed(dir, "blocked", "**", e)
  assertStringIncludes(r.out, "QUEUED")
  const s = run(dir, ["status", "--no-merge"], e)
  assertStringIncludes(s.out, "BLOCKED")
  assertStringIncludes(s.out, "blocked_backend")
  assertStringIncludes(s.out, "local-5090")
  // Reported, never re-routed: still queued, still nowhere near the 4090.
  assertEquals(s.out.includes("local-4090"), false, s.out)
  assertEquals(existsSync(join(storeOf(dir), "blocked.queued.json")), true)
  // deno-lint-ignore no-explicit-any
  assertEquals((record(dir, "blocked") as any).resource.dispatch_reason, "blocked_backend")
})

Deno.test("a 5090 that is down but inside the timeout leaves a heavy unit waiting", () => {
  const { dir, env } = gpuRepo(DEAD_5090)
  const e = { ...env, GATOR_PROBE_HEALTH: "1" }
  feed(dir, "patient", "**", e)
  const s = run(dir, ["status", "--no-merge"], e)
  assertStringIncludes(s.out, "waiting_for_required_backend")
  assertEquals(s.out.includes("blocked_backend"), false, s.out)
})

Deno.test("a busy 5090 is not an absent one: no timeout ever blocks a unit behind it", () => {
  const { dir, env } = gpuRepo()
  const e = { ...env, GATOR_BACKEND_TIMEOUT: "0" }
  hold(dir, "squatter", "local-5090")
  feed(dir, "behind", "**", e)
  const s = run(dir, ["status", "--no-merge"], e)
  assertStringIncludes(s.out, "waiting_for_required_backend")
  assertEquals(s.out.includes("blocked_backend"), false, s.out)
})

Deno.test("a disabled 5090 counts as absent even without health probing", () => {
  const { dir, env } = gpuRepo()
  const e = { ...env, GATOR_BACKEND_TIMEOUT: "0" }
  py(`
from gator_sched import leases
leases.set_disabled(${JSON.stringify(storeOf(dir))}, "local-5090", True)
`)
  feed(dir, "off", "**", e)
  const s = run(dir, ["status", "--no-merge"], e)
  assertStringIncludes(s.out, "blocked_backend")
})

Deno.test("a blocked unit runs on the 5090 once it comes back", () => {
  const { dir, env } = gpuRepo(DEAD_5090)
  const e = { ...env, GATOR_PROBE_HEALTH: "1", GATOR_BACKEND_TIMEOUT: "0" }
  feed(dir, "revived", "**", e)
  assertStringIncludes(run(dir, ["status", "--no-merge"], e).out, "blocked_backend")
  writeFileSync(env.GATOR_RESOURCES, BOTH_GPUS)
  const s = run(dir, ["status", "--no-merge"], e)
  assertStringIncludes(s.out, "DISPATCHED")
  assertStringIncludes(s.out, "backend=local-5090")
  waitForUnit(dir, e)
  // deno-lint-ignore no-explicit-any
  assertEquals((record(dir, "revived") as any).resource.backend, "local-5090")
})
