import { assertEquals } from "@std/assert"
import { join } from "node:path"

const PY = join(import.meta.dirname!, "../skill/gator")

const DRIVER = `
import sys, json
sys.path.insert(0, ${JSON.stringify(PY)})
from gator_auto.plan import validate_candidates
from gator_auto.repo import Refusal
try:
    out = validate_candidates(json.loads(sys.argv[1]), {})
    print(json.dumps({"ok": True, "n": len(out)}))
except Refusal as r:
    print(json.dumps({"ok": False, "code": r.code}))
except Exception as e:
    print(json.dumps({"ok": False, "code": "planner_invalid_json", "detail": str(e)}))
`

function validate(payload: string) {
  const { stdout } = new Deno.Command("python3", { args: ["-c", DRIVER, payload] }).outputSync()
  return JSON.parse(new TextDecoder().decode(stdout))
}

const ok = {
  candidates: [{
    id: "refresh-flow",
    source_ref: "SPEC.md#token-refresh",
    title: "Implement token refresh",
    task: "x".repeat(300),
    scope: ["src/auth/**", "test/auth/**"],
    acceptance: [{ id: "A1", criterion: "Expired refresh tokens are rejected" }],
    depends_on: [],
    benefit: 3,
    clarity: 2,
    boundedness: 2,
    risk: "normal",
    rationale: "stated in the source",
  }],
}

// deno-lint-ignore no-explicit-any
const mutate = (f: (c: any) => void) => {
  const copy = JSON.parse(JSON.stringify(ok))
  f(copy.candidates[0])
  return JSON.stringify(copy)
}

Deno.test("§9.4: a well-formed plan validates", () => {
  assertEquals(validate(JSON.stringify(ok)).ok, true)
})

Deno.test("§9.4: invalid JSON fails closed", () => {
  assertEquals(validate("{not json").ok, false)
})

Deno.test("§9.4: an unknown field fails closed", () => {
  const r = validate(mutate((c) => c.worker_cmd = "rm -rf /"))
  assertEquals(r.ok, false)
  assertEquals(r.code, "candidate_unknown_field")
})

Deno.test("§9.4: duplicate ids fail closed", () => {
  const two = JSON.parse(JSON.stringify(ok))
  two.candidates.push(JSON.parse(JSON.stringify(ok.candidates[0])))
  const r = validate(JSON.stringify(two))
  assertEquals(r.ok, false)
  assertEquals(r.code, "candidate_duplicate_id")
})

Deno.test("§9.4: a scope escaping the repository fails closed", () => {
  for (const bad of ["../../etc/**", "/etc/passwd", ".git/**", ".gator/**", "**", "/", "*"]) {
    const r = validate(mutate((c) => c.scope = [bad]))
    assertEquals(r.ok, false, `scope ${bad} must be refused`)
  }
})

Deno.test("§9.4: an empty scope fails closed", () => {
  assertEquals(validate(mutate((c) => c.scope = [])).code, "candidate_bad_scope")
})

Deno.test("§9.4: an out-of-range score fails closed", () => {
  assertEquals(validate(mutate((c) => c.benefit = 9)).code, "candidate_bad_score")
  assertEquals(validate(mutate((c) => c.clarity = -1)).code, "candidate_bad_score")
  assertEquals(validate(mutate((c) => c.boundedness = 3)).code, "candidate_bad_score")
})

Deno.test("§9.4: an unknown risk value fails closed", () => {
  assertEquals(validate(mutate((c) => c.risk = "fine, trust me")).code, "candidate_bad_risk")
})

Deno.test("§9.4: a shell-injecting id fails closed", () => {
  assertEquals(validate(mutate((c) => c.id = "a; rm -rf /")).code, "candidate_bad_id")
  assertEquals(validate(mutate((c) => c.id = "../../escape")).code, "candidate_bad_id")
  assertEquals(validate(mutate((c) => c.id = "$(whoami)")).code, "candidate_bad_id")
})

Deno.test("§9.4: a missing required field fails closed", () => {
  assertEquals(validate(mutate((c) => delete c.acceptance)).code, "candidate_missing_field")
})

Deno.test("§9.4: more than 20 candidates fails closed", () => {
  const many = {
    candidates: Array.from({ length: 21 }, (_, i) => ({ ...ok.candidates[0], id: `c${i}` })),
  }
  assertEquals(validate(JSON.stringify(many)).code, "too_many_candidates")
})

Deno.test("§9.4: a dependency on an unknown candidate fails closed", () => {
  assertEquals(validate(mutate((c) => c.depends_on = ["ghost"])).code, "unknown_dependency")
})

Deno.test("§9.4: a non-object top level fails closed", () => {
  assertEquals(validate("[]").ok, false)
  assertEquals(validate('"a string"').ok, false)
  assertEquals(validate('{"candidates": "not a list"}').ok, false)
})
