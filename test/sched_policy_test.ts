// Policy: which backends a unit may use, and which of those it should use.
//
// These are the invariant tests. The spec's section 21 asks for its checklist
// to be asserted rather than documented, so each test here is named for the
// invariant it defends and fails loudly if the heavy guarantee erodes.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { cfg, py } from "./sched_harness.ts"

// ============================================================ eligibility (I1)

Deno.test("I1: heavy is eligible for the 5090 alone, out of the box", () => {
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import eligible
print(eligible(load([]), "heavy"))
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "['local-5090']")
})

Deno.test("I3: a busy 5090 leaves a heavy unit with no candidate, idle 4090 notwithstanding", () => {
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import candidates, BackendState
c = load([])
state = {"local-5090": BackendState(active=1), "local-4090": BackendState(active=0)}
print(candidates(c, "heavy", state))
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "[]")
})

Deno.test("I3: an unhealthy 5090 leaves a heavy unit with no candidate", () => {
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import candidates, BackendState
c = load([])
state = {"local-5090": BackendState(healthy=False), "local-4090": BackendState()}
print(candidates(c, "heavy", state))
`)
  assertStringIncludes(r.out, "[]")
})

Deno.test("I7: an unknown resource class yields no candidates, failing closed", () => {
  // Class names can reach here from configuration and from a --resource flag.
  // An unrecognised one must never mean "anything goes".
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import eligible
c = load([])
print(eligible(c, "../../etc/passwd"))
print(eligible(c, ""))
print(eligible(c, "STANDARD"))
`)
  assertEquals(r.out.trim().split("\n").filter((l) => l === "[]").length, 3, r.out)
})

Deno.test("class resolution follows override, then role map, then default", () => {
  const p = cfg("role.heavy = heavy\nrole.default = standard\n")
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import resolve_class
c = load([${JSON.stringify(p)}])
print(resolve_class(c, "heavy"))
print(resolve_class(c, "unmapped"))
print(resolve_class(c, "heavy", override="standard"))
`)
  assertStringIncludes(r.out, "heavy\nstandard\nstandard")
})

Deno.test("a standard unit sees both local GPUs when both are free", () => {
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import candidates, BackendState
c = load([])
state = {"local-4090": BackendState(), "local-5090": BackendState()}
print(sorted(candidates(c, "standard", state)))
`)
  assertStringIncludes(r.out, "['local-4090', 'local-5090']")
})

// ================================================================ scoring (I2)

Deno.test("I5: an idle 5090 beats a busy 4090 for standard work", () => {
  const p = cfg("backend.local-4090.capacity = 2\nbackend.local-5090.capacity = 2\n")
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import choose, BackendState
c = load([${JSON.stringify(p)}])
state = {"local-4090": BackendState(active=1), "local-5090": BackendState(active=0)}
print(choose(c, "standard", state, work_tokens=4000))
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "local-5090")
  assertStringIncludes(r.out, "lower_expected_completion_time")
})

Deno.test("I2: declaring the 4090 a million times faster does not win it a heavy unit", () => {
  const p = cfg("backend.local-4090.weight = 1000.0\nbackend.local-5090.weight = 0.001\n")
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import choose, BackendState
c = load([${JSON.stringify(p)}])
state = {"local-4090": BackendState(), "local-5090": BackendState()}
print(choose(c, "heavy", state, work_tokens=100000))
`)
  assertStringIncludes(r.out, "local-5090")
})

Deno.test("I2: over 500 random weightings, heavy never selects the 4090", () => {
  const r = py(`
import random
from gator_sched.config import ResourceConfig, Backend
from gator_sched.policy import choose, BackendState
random.seed(20260920)
violations = []
for _ in range(500):
    c = ResourceConfig()
    for ident in ("local-4090", "local-5090"):
        b = Backend(ident)
        b.weight = random.uniform(0.001, 1000.0)
        b.capacity = random.randint(1, 4)
        c.backends[ident] = b
    state = {i: BackendState(active=random.randint(0, 1)) for i in c.backends}
    pick, _reason = choose(c, "heavy", state, work_tokens=random.randint(0, 10 ** 6))
    if pick not in (None, "local-5090"):
        violations.append(pick)
print("violations", len(violations))
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "violations 0")
})

Deno.test("a queued heavy unit reports that it waits for its required backend", () => {
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import choose, BackendState
c = load([])
state = {"local-5090": BackendState(active=1), "local-4090": BackendState()}
print(choose(c, "heavy", state))
`)
  assertStringIncludes(r.out, "waiting_for_required_backend")
})

Deno.test("an unrunnable standard unit is distinguished from an unrunnable heavy one", () => {
  // Two eligible backends, neither free: the unit is not waiting on any one
  // required backend, so the reason must not claim that it is.
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import choose, BackendState
c = load([])
state = {"local-5090": BackendState(active=1), "local-4090": BackendState(active=1)}
print(choose(c, "standard", state))
`)
  assertStringIncludes(r.out, "no_eligible_backend")
})

Deno.test("a single free eligible backend reports why it was the only choice", () => {
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import choose, BackendState
c = load([])
print(choose(c, "heavy", {"local-5090": BackendState()}))
print(choose(c, "standard", {"local-4090": BackendState(active=1), "local-5090": BackendState()}))
`)
  assertStringIncludes(r.out, "required_backend_available")
  assertStringIncludes(r.out, "only_eligible_backend")
})

Deno.test("scoring is deterministic: equal backends break the tie by name, not by chance", () => {
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import choose, BackendState
c = load([])
state = {"local-4090": BackendState(), "local-5090": BackendState()}
picks = {choose(c, "standard", state, work_tokens=1000)[0] for _ in range(50)}
print(sorted(picks))
`)
  assertEquals(r.out.trim().split("\n").pop()?.includes(","), false, r.out)
})

// ============================================================== precedence

const CLASSIFIER_ON = "classifier.endpoint = http://127.0.0.1:1/v1\nclassifier.model = m\n"

/** resolve() with a counting fake classifier; prints the verdict and how often it was asked. */
function resolveWith(
  text: string,
  override = "",
  verdict = '{"class": "standard", "p_standard": 0.9}',
) {
  const r = py(`
import json
from gator_sched.config import load
from gator_sched.policy import resolve
calls = []
def ask():
    calls.append(1)
    return ${verdict}
v = resolve(load([${JSON.stringify(cfg(text))}]), "heavy", ${
    JSON.stringify(override)
  } or None, ask=ask)
print(json.dumps(v, sort_keys=True))
print(len(calls))
`)
  assertEquals(r.code, 0, r.out)
  const [v, calls] = r.out.trim().split("\n")
  return { verdict: JSON.parse(v), calls: Number(calls) }
}

Deno.test("precedence 1: an override wins and the classifier is not asked", () => {
  const r = resolveWith("role.heavy = heavy\n" + CLASSIFIER_ON, "standard")
  assertEquals(r.verdict, { class: "standard", source: "override" })
  assertEquals(r.calls, 0)
})

Deno.test("precedence 2: a role mapping wins and the classifier is not asked", () => {
  const r = resolveWith("role.heavy = heavy\n" + CLASSIFIER_ON)
  assertEquals(r.verdict, { class: "heavy", source: "role" })
  assertEquals(r.calls, 0)
})

Deno.test("precedence 3: an explicit role.default is an operator statement the model cannot override", () => {
  const r = resolveWith("role.default = heavy\n" + CLASSIFIER_ON)
  assertEquals(r.verdict, { class: "heavy", source: "role_default" })
  assertEquals(r.calls, 0)
})

Deno.test("precedence 4: with nothing configured above it, the classifier answers once", () => {
  const r = resolveWith(CLASSIFIER_ON)
  assertEquals(r.verdict, { class: "standard", source: "classifier", p_standard: 0.9 })
  assertEquals(r.calls, 1)
})

Deno.test("precedence 4: a classifier abstention is heavy, and says so", () => {
  const r = resolveWith(CLASSIFIER_ON, "", '{"class": "heavy", "abstained": "timeout"}')
  assertEquals(r.verdict, { class: "heavy", source: "classifier", abstained: "timeout" })
})

Deno.test("precedence 5: with the classifier off, the built-in default answers", () => {
  const r = resolveWith("")
  assertEquals(r.verdict, { class: "standard", source: "default" })
  assertEquals(r.calls, 0)
})

Deno.test("a configured classifier with no way to ask is a programming error, not a silent default", () => {
  const r = py(`
from gator_sched.config import load
from gator_sched.policy import resolve
try:
    resolve(load([${JSON.stringify(cfg(CLASSIFIER_ON))}]), "heavy")
    print("resolved")
except ValueError:
    print("refused")
`)
  assertEquals(r.out.trim(), "refused")
})
