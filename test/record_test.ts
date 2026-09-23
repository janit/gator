import { assertEquals, assertStringIncludes } from "@std/assert"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { feed, repo, run, waitForUnit } from "./harness.ts"

const RECORD = join(import.meta.dirname!, "../skill/gator/gator-record.py")

function rec(args: string[]) {
  const { code, stdout, stderr } = new Deno.Command("python3", { args: [RECORD, ...args] })
    .outputSync()
  const d = new TextDecoder()
  return { code, out: d.decode(stdout).trim(), err: d.decode(stderr).trim() }
}

function tmpRecord(): string {
  return join(mkdtempSync(join(tmpdir(), "gator-rec-")), "unit.record.json")
}

Deno.test("record: write composes dotted keys and coerces scalars", () => {
  const p = tmpRecord()
  const w = rec(["write", p, "slug=demo", "worker.rc=0", "result.committed=true", "verify.rc=-1"])
  assertEquals(w.code, 0, w.err)
  const r = JSON.parse(Deno.readTextFileSync(p))
  assertEquals(r.schema_version, 1)
  assertEquals(r.slug, "demo")
  assertEquals(r.worker.rc, 0)
  assertEquals(r.result.committed, true)
  assertEquals(r.verify.rc, -1)
})

Deno.test("record: a second write merges into the existing record", () => {
  const p = tmpRecord()
  rec(["write", p, "slug=demo", "base_sha=abc123", "verify.configured=true"])
  rec(["write", p, "worker.rc=0", "result.committed=true", "result.ahead=1", "verify.rc=0"])
  const r = JSON.parse(Deno.readTextFileSync(p))
  assertEquals(r.slug, "demo") // survives from the launch-intent write
  assertEquals(r.base_sha, "abc123") // survives
  assertEquals(r.verify.configured, true)
  assertEquals(r.verify.rc, 0) // added by the completion write
  assertEquals(r.outcome, "ready") // recomputed on every write
})

Deno.test("record: get returns the default for a missing file, key or bad JSON", () => {
  assertEquals(rec(["get", "/nonexistent/x.json", "worker.rc", "7"]).out, "7")
  const p = tmpRecord()
  rec(["write", p, "slug=demo"])
  assertEquals(rec(["get", p, "verify.rc", "-1"]).out, "-1")
  writeFileSync(p, "{not json")
  assertEquals(rec(["get", p, "slug", "fallback"]).out, "fallback")
})

// ------------------------------------------- §9.9 distinct truthful results

const outcomeOf = (pairs: string[]) => {
  const p = tmpRecord()
  rec(["write", p, ...pairs])
  return rec(["outcome", p]).out
}

Deno.test("§9.9: a nonzero worker exit that committed nothing is failed, not empty", () => {
  assertEquals(outcomeOf(["worker.rc=7", "result.committed=false", "result.ahead=0"]), "failed")
})

Deno.test("§9.9: a timed-out worker is timeout even with no commit", () => {
  assertEquals(outcomeOf(["worker.rc=124", "result.committed=false", "result.ahead=0"]), "timeout")
})

Deno.test("§9.9: a clean worker that committed nothing is empty", () => {
  assertEquals(outcomeOf(["worker.rc=0", "result.committed=false", "result.ahead=0"]), "empty")
})

Deno.test("§9.9: a failing verifier over real commits is unverified", () => {
  assertEquals(
    outcomeOf([
      "worker.rc=0",
      "result.committed=true",
      "result.ahead=1",
      "verify.configured=true",
      "verify.rc=1",
    ]),
    "unverified",
  )
})

Deno.test("§9.9: a green worker with commits is ready", () => {
  assertEquals(
    outcomeOf([
      "worker.rc=0",
      "result.committed=true",
      "result.ahead=1",
      "verify.configured=true",
      "verify.rc=0",
    ]),
    "ready",
  )
})

Deno.test("§9.9: a launch error outranks every other dimension", () => {
  assertEquals(
    outcomeOf([
      "worker.launch_error=true",
      "worker.rc=0",
      "result.committed=true",
      "result.ahead=1",
    ]),
    "launch_error",
  )
})

// ------------------------------------- end-to-end: the record a real unit writes

Deno.test("the record captures the exact verifier that ran, not one detected later", () => {
  const dir = repo(`echo work > out.txt`)
  feed(dir, "records verifier", "**", { GATOR_VERIFY: "true" })
  waitForUnit(dir, { GATOR_VERIFY: "true" })

  const r = JSON.parse(
    Deno.readTextFileSync(join(dir, ".gator", "records-verifier.record.json")),
  )
  assertEquals(r.verify.configured, true)
  assertEquals(r.verify.command, "true")
  assertEquals(r.verify.rc, 0)
  assertEquals(r.result.committed, true)
  assertEquals(r.outcome, "ready")
  assertEquals(r.base_sha.length, 40)
  assertEquals(r.target_ref, "refs/heads/main")
  assertEquals(r.verify.verified_sha.length, 40)
})

Deno.test("§9.9: a worker that exits nonzero without committing records failed", () => {
  const dir = repo(`exit 7`)
  feed(dir, "dies quietly", "**", { GATOR_VERIFY: "true" })
  waitForUnit(dir, { GATOR_VERIFY: "true" })

  // The record is the machine contract. The human line still derives its own
  // status until Task 4 makes reporting read from here; that is asserted there.
  const r = JSON.parse(Deno.readTextFileSync(join(dir, ".gator", "dies-quietly.record.json")))
  assertEquals(r.worker.rc, 7)
  assertEquals(r.result.committed, false)
  assertEquals(r.outcome, "failed")
})

// ------------------------------- reporting is a pure read; finalising is not

Deno.test("status --json is read-only and never merges", () => {
  const dir = repo(`echo work > out.txt`)
  feed(dir, "observe me", "**", { GATOR_VERIFY: "true" })
  // Wait without finalising, so nothing but `status --json` has touched state.
  run(dir, ["wait", "--no-merge"], { GATOR_VERIFY: "true" })

  const head = () =>
    new TextDecoder().decode(
      new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: dir }).outputSync().stdout,
    )
  const before = head()
  const r = run(dir, ["status", "--json"], { GATOR_VERIFY: "true" })
  assertEquals(r.code, 0, r.out)

  const parsed = JSON.parse(r.out)
  assertEquals(parsed.schema_version, 1)
  assertEquals(parsed.units.length, 1)
  assertEquals(parsed.units[0].slug, "observe-me")
  assertEquals(parsed.units[0].outcome, "ready")

  assertEquals(before, head(), "status --json must not advance the branch")
  assertEquals(existsSync(join(dir, ".gator", "worktrees", "observe-me")), true, "worktree kept")
  assertEquals(existsSync(join(dir, ".gator", "observe-me.reported")), false, "not reported")
})

Deno.test("status --no-merge reports without merging", () => {
  const dir = repo(`echo work > out.txt`)
  feed(dir, "hold me", "**", { GATOR_VERIFY: "true" })
  waitForUnit(dir, { GATOR_VERIFY: "true", GATOR_AUTOMERGE: "0" })

  const r = run(dir, ["status", "--no-merge"], { GATOR_VERIFY: "true" })
  assertStringIncludes(r.out, "ready")
  const log = new Deno.Command("git", { args: ["log", "--oneline"], cwd: dir }).outputSync()
  assertEquals(new TextDecoder().decode(log.stdout).trim().split("\n").length, 1)
})

Deno.test("§9.9: the human line reports the outcome the record holds", () => {
  const dir = repo(`exit 7`)
  feed(dir, "loud failure", "**", { GATOR_VERIFY: "true" })
  const w = waitForUnit(dir, { GATOR_VERIFY: "true" })
  assertStringIncludes(w.out, "failed")
})

Deno.test("finalisation reports the verifier that ran, not one detected later", () => {
  const dir = repo(`echo work > out.txt`)
  feed(dir, "red build", "**", { GATOR_VERIFY: "false" })
  // A verifier is detectable from deno.json at finalise time, but the record
  // holds the one that actually ran.
  Deno.writeTextFileSync(join(dir, "deno.json"), JSON.stringify({ tasks: { test: "true" } }))
  const w = waitForUnit(dir, { GATOR_VERIFY: "false" })
  assertStringIncludes(w.out, "unverified")
  assertStringIncludes(w.out, "verify command: false")
})

// ====================================== the scheduling decision (spec §15, I6)

Deno.test("I6: the record carries the resource class, backend and queue delay", () => {
  const path = tmpRecord()
  rec([
    "write",
    path,
    "slug=u1",
    "resource.class=heavy",
    "resource.backend=local-5090",
    "resource.endpoint=http://127.0.0.1:5091",
    "resource.eligible=local-5090",
    "resource.queue_ms=18422",
    "resource.dispatch_reason=required_backend_available",
  ])
  const doc = JSON.parse(Deno.readTextFileSync(path))
  assertEquals(doc.resource.class, "heavy")
  assertEquals(doc.resource.backend, "local-5090")
  // The eligible set is a list in the record even though it crosses the CLI
  // boundary as a comma string: a reader should not have to re-split it.
  assertEquals(doc.resource.eligible, ["local-5090"])
  assertEquals(doc.resource.queue_ms, 18422)
})

Deno.test("I6: a multi-backend eligible set round-trips as a list", () => {
  const path = tmpRecord()
  rec(["write", path, "resource.eligible=local-4090,local-5090"])
  const doc = JSON.parse(Deno.readTextFileSync(path))
  assertEquals(doc.resource.eligible, ["local-4090", "local-5090"])
})

Deno.test("an empty eligible set records as an empty list, not as one empty name", () => {
  const path = tmpRecord()
  rec(["write", path, "resource.eligible="])
  const doc = JSON.parse(Deno.readTextFileSync(path))
  assertEquals(doc.resource.eligible, [])
})

Deno.test("get renders a recorded list as JSON for its shell caller", () => {
  const path = tmpRecord()
  rec(["write", path, "resource.eligible=local-5090"])
  assertEquals(rec(["get", path, "resource.eligible", "[]"]).out, '["local-5090"]')
})

Deno.test("a scope that could not be enforced fails closed as out_of_scope", () => {
  assertEquals(
    outcomeOf([
      "worker.rc=0",
      "result.committed=true",
      "result.ahead=1",
      "scope.unenforceable=src/*.ts",
    ]),
    "out_of_scope",
  )
})

Deno.test("§2.7: green alone but red once integrated is integration_failed", () => {
  assertEquals(
    outcomeOf([
      "worker.rc=0",
      "result.committed=true",
      "result.ahead=1",
      "verify.configured=true",
      "verify.rc=0",
      "integration.rc=1",
    ]),
    "integration_failed",
  )
})
