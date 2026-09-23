// The lease store, the interactive reservation, health states, and the CLI.
//
// Gator's units are detached: the process that admitted one has usually exited
// long before it finishes. So admission cannot be a variable in one shell — it
// has to be durable state that separate processes contend for correctly. These
// tests are mostly about that contention.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { cfg, py, sched, store } from "./sched_harness.ts"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// ================================================================ lease store

Deno.test("E16: a released lease frees the backend", () => {
  const s = store()
  const r = py(`
import os
from gator_sched import leases
s = ${JSON.stringify(s)}
print(leases.acquire(s, "u1", "local-5090", os.getpid(), {}))
print(leases.active_counts(leases.read(s)).get("local-5090", 0))
print(leases.release(s, "u1"))
print(leases.active_counts(leases.read(s)).get("local-5090", 0))
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "True\n1\nTrue\n0")
})

Deno.test("E17: a lease held by a dead process is reaped", () => {
  const s = store()
  const r = py(`
import os, subprocess
from gator_sched import leases
s = ${JSON.stringify(s)}
# A real process that really exits, so the pid is genuinely gone.
dead = subprocess.Popen(["true"]); dead.wait()
leases.acquire(s, "u1", "local-5090", dead.pid, {})
print("before", leases.active_counts(leases.read(s)).get("local-5090", 0))
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "before 0")
})

Deno.test("E18: a lease held by a live process survives a fresh read", () => {
  const s = store()
  const r = py(`
import os
from gator_sched import leases
s = ${JSON.stringify(s)}
leases.acquire(s, "u1", "local-5090", os.getpid(), {})
# A separate read, as a later gator invocation would do.
print("still", leases.active_counts(leases.read(s)).get("local-5090", 0))
`)
  assertStringIncludes(r.out, "still 1")
})

Deno.test("capacity cannot be overrun by concurrent acquirers", async () => {
  // Twenty processes race for a single slot. The flock is the only thing
  // standing between them and two workers on one GPU.
  const s = store()
  // The lease records this test process, not the racer: a racer that recorded
  // its own pid would exit, be correctly reaped, and hand the slot to the next
  // contender — which would measure reaping rather than mutual exclusion.
  const racer = `
import os, sys
sys.path.insert(0, ${JSON.stringify(join(import.meta.dirname!, "../skill/gator"))})
from gator_sched import leases
s = ${JSON.stringify(s)}
if leases.acquire(s, "u%s" % os.getpid(), "local-5090", ${Deno.pid}, {}, capacity=1):
    print("WON")
`
  const procs = Array.from(
    { length: 20 },
    () => new Deno.Command("python3", { args: ["-c", racer], stdout: "piped" }).spawn(),
  )
  const outs = await Promise.all(
    procs.map(async (p) => new TextDecoder().decode((await p.output()).stdout)),
  )
  const wins = outs.filter((o) => o.includes("WON")).length
  assertEquals(wins, 1, `expected exactly one winner, got ${wins}`)
})

Deno.test("a corrupt lease document fails closed rather than granting a lease", () => {
  const s = store()
  const r = py(`
import os
from gator_sched import leases
s = ${JSON.stringify(s)}
leases.store_dir(s)
open(os.path.join(s, "sched", "leases.json"), "w").write("{not json")
try:
    leases.acquire(s, "u1", "local-5090", os.getpid(), {})
    print("GRANTED")
except Exception as e:
    print("REFUSED", type(e).__name__)
`)
  assertStringIncludes(r.out, "REFUSED")
})

Deno.test("the scheduler directory is not world-readable", () => {
  const s = store()
  const r = py(`
import os, stat
from gator_sched import leases
d = leases.store_dir(${JSON.stringify(s)})
print(oct(stat.S_IMODE(os.stat(d).st_mode)))
`)
  assertStringIncludes(r.out, "0o700")
})

// ============================================================== reservation

Deno.test("I4: a reserved 4090 leaves the standard candidate set; the 5090 remains", () => {
  const s = store()
  const p = cfg("backend.local-4090.interactive_reservation = true\n")
  const r = py(`
from gator_sched import leases
from gator_sched.config import load
from gator_sched.policy import candidates
s = ${JSON.stringify(s)}
c = load([${JSON.stringify(p)}])
leases.set_reservation(s, "local-4090", True, "test")
print(sorted(candidates(c, "standard", leases.backend_states(s, c))))
leases.set_reservation(s, "local-4090", False, "test")
print(sorted(candidates(c, "standard", leases.backend_states(s, c))))
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "['local-5090']")
  assertStringIncludes(r.out, "['local-4090', 'local-5090']")
})

Deno.test("I4: a reservation never alters what heavy is eligible for", () => {
  const s = store()
  const r = py(`
from gator_sched import leases
from gator_sched.config import load
from gator_sched.policy import eligible, candidates
s = ${JSON.stringify(s)}
c = load([])
leases.set_reservation(s, "local-4090", True, "test")
leases.set_reservation(s, "local-5090", True, "test")
print(eligible(c, "heavy"))
# The 5090 carries no interactive reservation, so a stray one cannot idle it.
print(candidates(c, "heavy", leases.backend_states(s, c)))
`)
  assertStringIncludes(r.out, "['local-5090']\n['local-5090']")
})

// ================================================================== health

Deno.test("a backend with no health command is healthy", () => {
  const r = py(`
from gator_sched.config import Backend
from gator_sched.health import probe
print(probe(Backend("local-5090")))
`)
  assertStringIncludes(r.out, "True")
})

Deno.test("a failing health probe marks a backend unhealthy but does not widen eligibility", () => {
  const s = store()
  const p = cfg("backend.local-5090.health_cmd = false\n")
  const r = py(`
from gator_sched import leases
from gator_sched.config import load
from gator_sched.policy import candidates, eligible
s = ${JSON.stringify(s)}
c = load([${JSON.stringify(p)}])
print(candidates(c, "heavy", leases.backend_states(s, c, probe_health=True)))
print(eligible(c, "heavy"))
`)
  assertStringIncludes(r.out, "[]\n['local-5090']")
})

Deno.test("A3: an unhealthy required backend blocks after the availability timeout", () => {
  const r = py(`
from gator_sched.health import expired
print(expired(queued_at=1000, now=1000 + 1799, timeout=1800))
print(expired(queued_at=1000, now=1000 + 1801, timeout=1800))
`)
  assertStringIncludes(r.out, "False\nTrue")
})

Deno.test("a disabled backend is not a candidate for any class", () => {
  const s = store()
  const r = py(`
from gator_sched import leases
from gator_sched.config import load
from gator_sched.policy import candidates
s = ${JSON.stringify(s)}
c = load([])
leases.set_disabled(s, "local-5090", True)
print(candidates(c, "heavy", leases.backend_states(s, c)))
print(sorted(candidates(c, "standard", leases.backend_states(s, c))))
`)
  assertStringIncludes(r.out, "[]\n['local-4090']")
})

// ===================================================================== CLI

Deno.test("resolve prints the class and its eligible set", () => {
  const s = store()
  const p = cfg("role.heavy = heavy\n")
  const r = sched(["resolve", "--store", s, "--role", "heavy", "--config", p])
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "resource=heavy")
  assertStringIncludes(r.out, "eligible=local-5090")
})

Deno.test("dispatch grants a backend and prints the decision", () => {
  const s = store()
  const p = cfg("role.heavy = heavy\nbackend.local-5090.endpoint = http://127.0.0.1:5091\n")
  const r = sched([
    "dispatch",
    "--store",
    s,
    "--slug",
    "u1",
    "--role",
    "heavy",
    "--pid",
    String(Deno.pid),
    "--config",
    p,
  ])
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "backend=local-5090")
  assertStringIncludes(r.out, "endpoint=http://127.0.0.1:5091")
  assertStringIncludes(r.out, "reason=required_backend_available")
})

Deno.test("A2: a second heavy unit is refused with exit 3 while the first holds the 5090", () => {
  const s = store()
  const p = cfg("role.heavy = heavy\n")
  const args = (slug: string) => [
    "dispatch",
    "--store",
    s,
    "--slug",
    slug,
    "--role",
    "heavy",
    "--pid",
    String(Deno.pid),
    "--config",
    p,
  ]
  assertEquals(sched(args("u1")).code, 0)
  const second = sched(args("u2"))
  assertEquals(second.code, 3, second.out)
  assertStringIncludes(second.out, "reason=waiting_for_required_backend")
  assertStringIncludes(second.out, "required_backend=local-5090")
  // The refusal must not mention the 4090 at all: it was never a possibility.
  assertEquals(second.out.includes("local-4090"), false, second.out)
})

Deno.test("release through the CLI frees the slot for the next unit", () => {
  const s = store()
  const p = cfg("role.heavy = heavy\n")
  const args = (slug: string) => [
    "dispatch",
    "--store",
    s,
    "--slug",
    slug,
    "--role",
    "heavy",
    "--pid",
    String(Deno.pid),
    "--config",
    p,
  ]
  assertEquals(sched(args("u1")).code, 0)
  assertEquals(sched(["release", "--store", s, "--slug", "u1"]).code, 0)
  assertEquals(sched(args("u2")).code, 0)
})

Deno.test("reserve toggles the interactive reservation through the CLI", () => {
  const s = store()
  const p = cfg("backend.local-4090.interactive_reservation = true\n")
  assertEquals(sched(["reserve", "--store", s, "--backend", "local-4090", "--on"]).code, 0)
  const r = sched(["status", "--store", s, "--config", p])
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, '"reserved": true')
})

Deno.test("status reports each backend's state as JSON", () => {
  const s = store()
  const r = sched(["status", "--store", s])
  assertEquals(r.code, 0, r.out)
  const doc = JSON.parse(r.out)
  assertEquals(typeof doc.backends, "object")
  assertEquals(doc.schema_version, 1)
})

Deno.test("the CLI refuses an unknown verb with exit 2", () => {
  assertEquals(sched(["rampage", "--store", store()]).code, 2)
})

Deno.test("a lease survives the process that created it, as a detached unit needs", () => {
  // gator exits immediately after launching a unit. The lease must outlive it.
  const s = store()
  const p = cfg("role.heavy = heavy\n")
  // The dispatching python process exits the moment it returns, exactly as
  // gator does; the pid recorded is the unit's, which is still alive.
  assertEquals(
    sched([
      "dispatch",
      "--store",
      s,
      "--slug",
      "u1",
      "--role",
      "heavy",
      "--pid",
      String(Deno.pid),
      "--config",
      p,
    ]).code,
    0,
  )
  assertEquals(existsSync(join(s, "sched", "leases.json")), true)
  const again = sched(["status", "--store", s, "--config", p])
  assertStringIncludes(again.out, '"active": 1')
})

Deno.test("a dispatch whose config is malformed refuses with exit 2, granting nothing", () => {
  const s = store()
  const p = cfg("backend.local-5090.endpoint = http://x/$(id)\n")
  const r = sched([
    "dispatch",
    "--store",
    s,
    "--slug",
    "u1",
    "--role",
    "heavy",
    "--pid",
    String(Deno.pid),
    "--config",
    p,
  ])
  assertEquals(r.code, 2, r.out)
  assertStringIncludes(r.out, "bad_endpoint")
  assertEquals(existsSync(join(s, "sched", "leases.json")), false)
})

Deno.test("a lease file written by an older schema is not silently trusted", () => {
  const s = store()
  py(`
from gator_sched import leases
leases.store_dir(${JSON.stringify(s)})
`)
  writeFileSync(join(s, "sched", "leases.json"), JSON.stringify({ schema_version: 99 }))
  const r = sched(["status", "--store", s])
  assertEquals(r.code, 2, r.out)
  assertStringIncludes(r.out, "schema")
})

Deno.test("an unadopted lease survives the launch grace and is reaped after it", () => {
  // pid 0 is a dispatch whose gator-unit has not adopted it yet. A crash in
  // that window must not strand the backend forever, nor free it too early.
  const r = py(`
from gator_sched import leases
now = 10_000.0
doc = {"leases": {
  "fresh": {"pid": 0, "started": now - leases.LAUNCH_GRACE + 5},
  "stale": {"pid": 0, "started": now - leases.LAUNCH_GRACE - 5},
}}
print("dropped", leases.reap(doc, now=now))
print("kept", sorted(doc["leases"]))
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "dropped ['stale']")
  assertStringIncludes(r.out, "kept ['fresh']")
})

Deno.test("a reservation on a backend that does not honour one is not reported as reserved", () => {
  // policy.candidates() ignores it there, so the state must not name it either.
  const s = store()
  const p = cfg("backend.local-4090.interactive_reservation = false\n")
  assertEquals(sched(["reserve", "--store", s, "--backend", "local-4090", "--on"]).code, 0)
  const doc = JSON.parse(sched(["status", "--store", s, "--config", p]).out)
  assertEquals(doc.backends["local-4090"].state === "reserved", false, JSON.stringify(doc))
})
