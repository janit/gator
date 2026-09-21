// Where scope enforcement meets the scheduler.
//
// Neither branch could have written these: scope enforcement landed on main
// while the scheduler was being built beside it, and the merge is the first
// time a unit's scope has had to survive being dispatched by a scheduler
// rather than spawned directly.
//
// The queued path is the one that can silently lose it. A queued unit is
// launched later, by a different process, from a JSON record — so its scope
// has to travel in that record or arrive empty, and an empty scope checks
// nothing while still reporting success.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { feed, repo, waitForUnit } from "./harness.ts"
import { cfg, py } from "./sched_harness.ts"

const ONE_GPU = `
backend.local-5090.endpoint = http://127.0.0.1:5091
backend.local-5090.capacity = 1
backend.local-5090.weight = 1.6
role.heavy = heavy
role.default = standard
`

const storeOf = (dir: string) => join(dir, ".gator")

function hold(dir: string, slug: string, backend: string) {
  const r = py(`
from gator_sched import leases
print(leases.acquire(${JSON.stringify(storeOf(dir))}, ${JSON.stringify(slug)},
                     ${JSON.stringify(backend)}, ${Deno.pid}, {}, capacity=1))
`)
  assertEquals(r.out.trim(), "True", r.out)
}

function release(dir: string, slug: string) {
  py(`
from gator_sched import leases
leases.release(${JSON.stringify(storeOf(dir))}, ${JSON.stringify(slug)})
`)
}

const strays = () => repo(`echo out > outside.txt`)

Deno.test("SCHED+SCOPE: a directly dispatched unit still has its scope enforced", () => {
  const dir = strays()
  const env = { GATOR_RESOURCES: cfg(ONE_GPU), GATOR_VERIFY: "true" }
  feed(dir, "direct", "src/**", env)
  const w = waitForUnit(dir, env)
  assertStringIncludes(w.out, "out_of_scope")
  assertEquals(existsSync(join(dir, "outside.txt")), false, "nothing merged")
})

Deno.test("SCHED+SCOPE: scope travels in the queue record", () => {
  const dir = strays()
  const env = { GATOR_RESOURCES: cfg(ONE_GPU), GATOR_VERIFY: "true" }
  hold(dir, "squatter", "local-5090")

  const r = feed(dir, "queued", "src/**", env)
  assertStringIncludes(r.out, "QUEUED")

  const q = JSON.parse(readFileSync(join(storeOf(dir), "queued.queued.json"), "utf8"))
  assertEquals(q.scope, "src/**", "a scope that does not reach the queue is lost")
})

Deno.test("SCHED+SCOPE: a unit dispatched off the queue is still held for straying", () => {
  // The whole point: queue it, free the backend, let the drain launch it, and
  // check the scope it was given at feed time is still the one it is judged
  // against several processes later.
  const dir = strays()
  const env = { GATOR_RESOURCES: cfg(ONE_GPU), GATOR_VERIFY: "true" }
  hold(dir, "squatter", "local-5090")
  assertStringIncludes(feed(dir, "later", "src/**", env).out, "QUEUED")

  release(dir, "squatter")
  const w = waitForUnit(dir, env)
  assertStringIncludes(w.out, "out_of_scope")
  assertEquals(existsSync(join(dir, "outside.txt")), false, "the queued unit merged anyway")
})

Deno.test("SCHED+SCOPE: a queued unit that stays in scope still merges", () => {
  // The negative control: if the mechanism above rejected everything it would
  // pass the tests above and be useless.
  const dir = repo(`mkdir -p src && echo ok > src/new.ts`)
  const env = { GATOR_RESOURCES: cfg(ONE_GPU), GATOR_VERIFY: "true" }
  hold(dir, "squatter", "local-5090")
  assertStringIncludes(feed(dir, "good", "src/**", env).out, "QUEUED")

  release(dir, "squatter")
  const w = waitForUnit(dir, env)
  assertStringIncludes(w.out, "merged")
  assertEquals(existsSync(join(dir, "src", "new.ts")), true)
})
