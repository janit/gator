import { assertEquals } from "@std/assert"
import { join } from "node:path"

const PY = join(import.meta.dirname!, "../skill/gator")

const DRIVER = `
import sys, json
sys.path.insert(0, ${JSON.stringify(PY)})
from gator_auto.rank import select
data = json.loads(sys.argv[1])
print(json.dumps(select(data["candidates"], data["priorities"])))
`

function select(candidates: unknown[], priorities: Record<string, number> = {}) {
  const { stdout } = new Deno.Command("python3", {
    args: ["-c", DRIVER, JSON.stringify({ candidates, priorities })],
  }).outputSync()
  return JSON.parse(new TextDecoder().decode(stdout))
}

const cand = (over: Record<string, unknown> = {}) => ({
  id: "c",
  source_ref: "SPEC.md#c",
  title: "t",
  task: "x".repeat(300),
  scope: ["src/**"],
  acceptance: [{ id: "A1", criterion: "works" }],
  depends_on: [],
  benefit: 3,
  clarity: 2,
  boundedness: 2,
  risk: "normal",
  rationale: "r",
  ...over,
})

// deno-lint-ignore no-explicit-any
const reasonFor = (r: any, id: string) => r.rejected.find((x: any) => x.id === id).reason

Deno.test("§9.1: substantial specified work outranks a mechanical chore", () => {
  const r = select([
    cand({ id: "rename-vars", benefit: 1, title: "Rename variables across the tree" }),
    cand({ id: "token-refresh", benefit: 3, title: "Implement token refresh" }),
  ])
  assertEquals(r.selected_id, "token-refresh")
  assertEquals(reasonFor(r, "rename-vars"), "benefit_below_threshold")
})

Deno.test("§9.1: a difficult one-file task can qualify", () => {
  const r = select([cand({ id: "ranking-algo", scope: ["src/rank.ts"], benefit: 3 })])
  assertEquals(r.selected_id, "ranking-algo")
})

Deno.test("§9.2: no eligible work yields a valid no-candidate result, not an error", () => {
  const r = select([cand({ id: "vague", clarity: 1 })])
  assertEquals(r.selected_id, null)
  assertEquals(r.rejected[0].reason, "needs_clarification")
})

Deno.test("§9.3: an unresolved dependency defers rather than being invented away", () => {
  const r = select([
    cand({ id: "second", depends_on: ["first"] }),
    cand({ id: "first", benefit: 1 }),
  ])
  assertEquals(r.selected_id, null)
  assertEquals(reasonFor(r, "second"), "unresolved_dependency")
})

Deno.test("§9.3: a candidate with no acceptance criteria is deferred", () => {
  const r = select([cand({ acceptance: [] })])
  assertEquals(r.selected_id, null)
  assertEquals(r.rejected[0].reason, "no_acceptance_criteria")
})

Deno.test("§5: risk disallowed is never selected however high the benefit", () => {
  const r = select([cand({ id: "risky", benefit: 3, risk: "disallowed" })])
  assertEquals(r.selected_id, null)
  assertEquals(r.rejected[0].reason, "risk_disallowed")
})

Deno.test("§5: explicit source priority beats benefit", () => {
  const r = select(
    [cand({ id: "high-benefit", benefit: 3 }), cand({ id: "user-first", benefit: 2 })],
    { "user-first": 1 },
  )
  assertEquals(r.selected_id, "user-first")
})

Deno.test("§5: ties break to the narrower scope, then to the stable id", () => {
  assertEquals(
    select([
      cand({ id: "wide", scope: ["src/**", "test/**", "docs/**"] }),
      cand({ id: "narrow", scope: ["src/one.ts"] }),
    ]).selected_id,
    "narrow",
  )
  assertEquals(
    select([cand({ id: "bbb", scope: ["src/**"] }), cand({ id: "aaa", scope: ["src/**"] })])
      .selected_id,
    "aaa",
  )
})

Deno.test("delta #3: clarity and boundedness are gates — only the maximum passes", () => {
  assertEquals(select([cand({ clarity: 1 })]).selected_id, null)
  assertEquals(select([cand({ boundedness: 1 })]).selected_id, null)
  assertEquals(select([cand({ clarity: 2, boundedness: 2 })]).selected_id, "c")
})

Deno.test("delta #6: the character floor is a shape check, not a quality signal", () => {
  const r = select([cand({ id: "padded", task: "do it" })])
  assertEquals(r.selected_id, null)
  assertEquals(r.rejected[0].reason, "task_below_floor")
})

Deno.test("every rejection carries an evidence-bearing rationale", () => {
  const r = select([cand({ id: "vague", clarity: 0, rationale: "the source names no outcome" })])
  assertEquals(r.rejected[0].rationale, "the source names no outcome")
})

Deno.test("§9.2: an empty candidate list is a valid no-candidate result", () => {
  const r = select([])
  assertEquals(r.selected_id, null)
  assertEquals(r.candidates, [])
  assertEquals(r.rejected, [])
})
