// The classifier as a user meets it: through `gator feed`.
//
// These run the real gator script against the stand-in endpoint. The resource
// files here deliberately map no role and set no role.default, because any
// operator statement outranks the classifier and would stop it being asked.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { feed, repo, run, waitForUnit } from "./harness.ts"
import { cfg, classifierStub, py } from "./sched_harness.ts"

const GPUS = `
backend.local-4090.endpoint = http://127.0.0.1:4091
backend.local-4090.capacity = 1
backend.local-5090.endpoint = http://127.0.0.1:5091
backend.local-5090.capacity = 1
`
const classified = (url: string, extra = "") =>
  GPUS + `classifier.endpoint = ${url}\nclassifier.model = stub-model\nclassifier.timeout = 1\n` +
  extra

const storeOf = (dir: string) => join(dir, ".gator")

// deno-lint-ignore no-explicit-any
const record = (dir: string, slug: string): any =>
  JSON.parse(readFileSync(join(storeOf(dir), `${slug}.record.json`), "utf8"))

function hold(dir: string, slug: string, backend: string) {
  const r = py(`
from gator_sched import leases
print(leases.acquire(${JSON.stringify(storeOf(dir))}, ${JSON.stringify(slug)},
                     ${JSON.stringify(backend)}, ${Deno.pid}, {}, capacity=1))
`)
  assertEquals(r.out.trim(), "True", r.out)
}

function release(dir: string, slug: string) {
  const r = py(`
from gator_sched import leases
leases.release(${JSON.stringify(storeOf(dir))}, ${JSON.stringify(slug)})
`)
  assertEquals(r.code, 0, r.out)
}

async function setup(mode: string, extra = "") {
  const stub = await classifierStub(mode)
  const dir = repo(`echo work > out.txt`)
  const env = { GATOR_RESOURCES: cfg(classified(stub.url, extra)), GATOR_VERIFY: "true" }
  return { stub, dir, env }
}

Deno.test("feed: a confident standard is demoted, and the record says who decided", async () => {
  const { stub, dir, env } = await setup("standard")
  try {
    const r = feed(dir, "c1", "**", env)
    assertEquals(r.code, 0, r.out)
    assertStringIncludes(r.out, "resource=standard (classifier standard p_standard=0.95)")
    waitForUnit(dir, env)
    const doc = record(dir, "c1")
    assertEquals(doc.resource.class, "standard")
    assertEquals(doc.resource.source, "classifier")
    assertEquals(doc.resource.classifier, "standard p_standard=0.95")
    assertEquals(stub.requests().length, 1)
    assertStringIncludes(stub.requests()[0].body.messages[0].content, "Title: c1")
  } finally {
    await stub.stop()
  }
})

Deno.test("feed: a heavy verdict runs on the 5090", async () => {
  const { stub, dir, env } = await setup("heavy")
  try {
    const r = feed(dir, "c2", "**", env)
    assertStringIncludes(r.out, "resource=heavy (classifier heavy p_standard=0.03)")
    assertStringIncludes(r.out, "backend=local-5090")
    waitForUnit(dir, env)
  } finally {
    await stub.stop()
  }
})

Deno.test("feed: a queued unit is classified once, across feed and drain", async () => {
  const { stub, dir, env } = await setup("heavy")
  try {
    hold(dir, "squatter", "local-5090")
    const r = feed(dir, "c3", "**", env)
    assertStringIncludes(r.out, "QUEUED")
    assertStringIncludes(r.out, "resource=heavy (classifier heavy p_standard=0.03)")
    release(dir, "squatter")
    const d = run(dir, ["drain"], env)
    assertStringIncludes(d.out, "DISPATCHED")
    assertEquals(stub.requests().length, 1)
    waitForUnit(dir, env)
    assertEquals(record(dir, "c3").resource.backend, "local-5090")
  } finally {
    await stub.stop()
  }
})

Deno.test("feed: with the jaws full the unit is still classified before it queues", async () => {
  const { stub, dir, env } = await setup("standard")
  try {
    const r = feed(dir, "c4", "**", { ...env, GATOR_MAX_CONCURRENT: "0" })
    assertStringIncludes(r.out, "QUEUED")
    assertEquals(record(dir, "c4").resource.source, "classifier")
    assertEquals(record(dir, "c4").resource.class, "standard")
    assertEquals(stub.requests().length, 1)
  } finally {
    await stub.stop()
  }
})

Deno.test("feed: a classifier timeout keeps the unit heavy, says so, and stays bounded", async () => {
  const { stub, dir, env } = await setup("timeout")
  try {
    const start = performance.now()
    const r = feed(dir, "c5", "**", env)
    assertEquals(performance.now() - start < 8000, true)
    assertEquals(r.code, 0, r.out)
    assertStringIncludes(r.out, "classifier abstained (timeout) — kept at heavy")
    assertStringIncludes(r.out, "resource=heavy")
    waitForUnit(dir, env)
    assertEquals(record(dir, "c5").resource.classifier, "abstained:timeout")
  } finally {
    await stub.stop()
  }
})

Deno.test("feed: an invalid classifier config refuses before anything is created", async () => {
  const { stub, dir, env } = await setup("standard", "classifier.threshold = 0.4\n")
  try {
    const r = feed(dir, "c6 broken", "**", env)
    assertEquals(r.code, 2, r.out)
    assertStringIncludes(r.out, "bad_threshold")
    const refs = new Deno.Command("git", {
      args: ["show-ref", "--verify", "--quiet", "refs/heads/gator/c6-broken"],
      cwd: dir,
    }).outputSync()
    assertEquals(refs.success, false)
    assertEquals(existsSync(join(storeOf(dir), "worktrees", "c6-broken")), false)
    assertEquals(stub.requests().length, 0)
  } finally {
    await stub.stop()
  }
})

Deno.test("feed: an untrusted repository cannot point task text at its own classifier", async () => {
  const stub = await classifierStub("standard")
  try {
    const dir = repo(`echo work > out.txt`)
    mkdirSync(storeOf(dir), { recursive: true })
    writeFileSync(join(storeOf(dir), "resources"), classified(stub.url))
    const env = { GATOR_RESOURCES: cfg(GPUS), GATOR_VERIFY: "true" }
    const r = feed(dir, "c7", "**", env)
    assertEquals(r.code, 0, r.out)
    assertStringIncludes(r.out, "ignoring repository-supplied")
    assertEquals(stub.requests().length, 0)
    waitForUnit(dir, env)
    assertEquals(record(dir, "c7").resource.source, "default")
  } finally {
    await stub.stop()
  }
})

Deno.test("feed: an explicit --resource skips the classifier entirely", async () => {
  const { stub, dir, env } = await setup("standard")
  try {
    const r = feed(dir, "c8", "**", { ...env, GATOR_RESOURCE: "heavy" })
    assertStringIncludes(r.out, "resource=heavy backend=")
    assertEquals(stub.requests().length, 0)
    waitForUnit(dir, env)
    assertEquals(record(dir, "c8").resource.source, "override")
  } finally {
    await stub.stop()
  }
})

Deno.test("status shows who decided the class", async () => {
  const { stub, dir, env } = await setup("standard")
  try {
    feed(dir, "c9", "**", env)
    waitForUnit(dir, env)
    const s = run(dir, ["status", "--no-merge"], env)
    assertStringIncludes(s.out, 'source=classifier classifier="standard p_standard=0.95"')
  } finally {
    await stub.stop()
  }
})

// `wait` (with no --no-merge) finalises a ready unit itself: it merges the
// branch and renames its `.done` marker to `.reported` before returning. A
// later plain `gator status` would find the unit already reported and print
// nothing more for it, so the only place finalise's own resource line can be
// observed is in the output of the call that ran finalise — this `wait`.
Deno.test("a merged unit still shows who decided the class", async () => {
  const { stub, dir, env } = await setup("standard")
  try {
    const r = feed(dir, "c10", "**", env)
    assertEquals(r.code, 0, r.out)
    const w = waitForUnit(dir, env)
    assertStringIncludes(w.out, 'source=classifier classifier="standard p_standard=0.95"')
  } finally {
    await stub.stop()
  }
})

Deno.test("feed: an empty resource class from config is refused, not silently re-resolved", () => {
  const dir = repo(`echo work > out.txt`)
  const env = { GATOR_RESOURCES: cfg(GPUS + "role.default = \n"), GATOR_VERIFY: "true" }
  const r = feed(dir, "c11", "**", env)
  assertEquals(r.code, 2, r.out)
  assertStringIncludes(r.out, "the scheduler named no resource class for this unit")
})

Deno.test("a queued unit's status line carries res_detail", async () => {
  const { stub, dir, env } = await setup("heavy")
  try {
    hold(dir, "squatter2", "local-5090")
    const r = feed(dir, "c12", "**", env)
    assertStringIncludes(r.out, "QUEUED")
    const s = run(dir, ["status", "--no-merge"], env)
    assertStringIncludes(s.out, 'UNIT "c12" → queued')
    const line = s.out.split("\n").find((l) => l.includes('UNIT "c12" → queued'))
    assertStringIncludes(line ?? "", "source=classifier")
  } finally {
    release(dir, "squatter2")
    await stub.stop()
  }
})
