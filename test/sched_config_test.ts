// Resource configuration: backends, classes, and the role-to-class mapping.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { cfg, py } from "./sched_harness.ts"

Deno.test("I1: with no configuration at all, heavy is eligible for the 5090 alone", () => {
  const r = py(`
from gator_sched.config import load
c = load([])
print(c.classes["heavy"])
print(c.classes["standard"])
print(c.default_class)
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "['local-5090']")
  assertStringIncludes(r.out, "['local-4090', 'local-5090']")
  assertStringIncludes(r.out, "standard")
})

Deno.test("dotted backend keys parse without the regex over-matching a neighbour", () => {
  // A shell `grep -E "^backend.local-5090.endpoint"` treats each dot as "any
  // character". Parsing in Python is what makes these keys safe to use.
  const p = cfg(`
backend.local-5090.endpoint = http://127.0.0.1:5091
backend.local-5090.capacity = 1
backend.local-5090.weight = 1.6
backend.local-4090.endpoint = http://127.0.0.1:4091
backend.local-4090.interactive_reservation = true
backendXlocal-5090Xendpoint = http://evil.invalid
`)
  const r = py(`
from gator_sched.config import load
c = load([${JSON.stringify(p)}])
b = c.backends["local-5090"]
print(b.endpoint, b.capacity, b.weight)
print(c.backends["local-4090"].interactive_reservation)
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "http://127.0.0.1:5091 1 1.6")
  assertStringIncludes(r.out, "True")
})

Deno.test("an earlier file wins per key, and merges rather than replacing wholesale", () => {
  const hi = cfg("backend.local-5090.weight = 9.0\n")
  const lo = cfg("backend.local-5090.weight = 1.6\nbackend.local-5090.capacity = 3\n")
  const r = py(`
from gator_sched.config import load
c = load([${JSON.stringify(hi)}, ${JSON.stringify(lo)}])
print(c.backends["local-5090"].weight, c.backends["local-5090"].capacity)
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "9.0 3")
})

Deno.test("a backend id carrying shell metacharacters is refused", () => {
  // The id is substituted into a command string, so it is a name and not an
  // expression — the same rule check_model applies to a model reference.
  const p = cfg("backend.evil;rm -rf /.endpoint = http://x\n")
  const r = py(`
from gator_sched.config import load, ConfigError
try:
    load([${JSON.stringify(p)}])
    print("ACCEPTED")
except ConfigError as e:
    print(e.code)
`)
  assertStringIncludes(r.out, "bad_backend_id")
})

Deno.test("an endpoint carrying a command substitution is refused", () => {
  const p = cfg("backend.local-5090.endpoint = http://x/$(id)\n")
  const r = py(`
from gator_sched.config import load, ConfigError
try:
    load([${JSON.stringify(p)}])
    print("ACCEPTED")
except ConfigError as e:
    print(e.code)
`)
  assertStringIncludes(r.out, "bad_endpoint")
})

Deno.test("configured class eligibility replaces the built-in default", () => {
  const p = cfg("class.heavy.eligible = local-5090,fleet\n")
  const r = py(`
from gator_sched.config import load
print(load([${JSON.stringify(p)}]).classes["heavy"])
`)
  assertStringIncludes(r.out, "['local-5090', 'fleet']")
})

Deno.test("role mapping and the default class resolve through role_map", () => {
  const p = cfg("role.heavy = heavy\nrole.review = remote\nrole.default = standard\n")
  const r = py(`
from gator_sched.config import load
c = load([${JSON.stringify(p)}])
print(c.role_map["heavy"], c.role_map["review"], c.default_class)
`)
  assertStringIncludes(r.out, "heavy remote standard")
})

Deno.test("comments, blank lines and one layer of quotes are stripped as roles does", () => {
  const p = cfg(`
# a comment line
backend.local-5090.endpoint = "http://127.0.0.1:5091"   # trailing comment

role.heavy = 'heavy'
`)
  const r = py(`
from gator_sched.config import load
c = load([${JSON.stringify(p)}])
print(c.backends["local-5090"].endpoint)
print(c.role_map["heavy"])
`)
  assertStringIncludes(r.out, "http://127.0.0.1:5091")
  assertStringIncludes(r.out, "heavy")
})

Deno.test("a missing file is skipped rather than failing the load", () => {
  const r = py(`
from gator_sched.config import load
print(load(["/nonexistent/gator/resources"]).classes["heavy"])
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "['local-5090']")
})

// ============================================================ classifier

const CLASSIFIER = "classifier.endpoint = http://127.0.0.1:8086/v1\nclassifier.model = m\n"

/** Load one resources file and report either its classifier or the refusal code. */
function loadClassifier(text: string): string {
  const r = py(`
from gator_sched.config import ConfigError, load
try:
    c = load([${JSON.stringify(cfg(text))}]).classifier
    print("off" if c is None else "on %s %s %s %s" % (c.endpoint, c.model, c.threshold, c.timeout))
except ConfigError as e:
    print("refused", e.code)
`)
  assertEquals(r.code, 0, r.out)
  return r.out.trim()
}

Deno.test("no classifier keys means the classifier is off", () => {
  assertEquals(loadClassifier("role.heavy = heavy\n"), "off")
})

Deno.test("a configured classifier parses, with the conservative defaults", () => {
  assertEquals(
    loadClassifier(
      "classifier.endpoint = http://127.0.0.1:8086/v1/\nclassifier.model = Qwen3.8-27B\n",
    ),
    "on http://127.0.0.1:8086/v1 Qwen3.8-27B 0.75 5",
  )
})

Deno.test("threshold and timeout are read when given", () => {
  assertEquals(
    loadClassifier(CLASSIFIER + "classifier.threshold = 0.9\nclassifier.timeout = 2\n"),
    "on http://127.0.0.1:8086/v1 m 0.9 2",
  )
})

Deno.test("a threshold at or below one half is refused: demotion would become the default", () => {
  for (const t of ["0.5", "0.2", "1.5", "nan"]) {
    assertEquals(
      loadClassifier(CLASSIFIER + `classifier.threshold = ${t}\n`),
      "refused bad_threshold",
    )
  }
  assertEquals(loadClassifier(CLASSIFIER + "classifier.threshold = high\n"), "refused bad_number")
})

Deno.test("a timeout outside 1..60 seconds is refused", () => {
  for (const t of ["0", "61", "-1"]) {
    assertEquals(loadClassifier(CLASSIFIER + `classifier.timeout = ${t}\n`), "refused bad_timeout")
  }
  assertEquals(loadClassifier(CLASSIFIER + "classifier.timeout = soon\n"), "refused bad_number")
})

Deno.test("a half-configured classifier is refused, not silently switched off", () => {
  assertEquals(
    loadClassifier("classifier.endpoint = http://127.0.0.1:8086/v1\n"),
    "refused bad_classifier",
  )
  assertEquals(loadClassifier("classifier.model = m\n"), "refused bad_classifier")
  assertEquals(loadClassifier("classifier.threshold = 0.9\n"), "refused bad_classifier")
})

Deno.test("a misspelt classifier key is refused rather than ignored", () => {
  assertEquals(loadClassifier(CLASSIFIER + "classifier.treshold = 0.9\n"), "refused bad_classifier")
})

Deno.test("the classifier endpoint must be a plain http(s) URL", () => {
  for (const e of ["file:///etc/passwd", "http://x/$(id)", "127.0.0.1:8086"]) {
    assertEquals(
      loadClassifier(`classifier.endpoint = ${e}\nclassifier.model = m\n`),
      "refused bad_endpoint",
    )
  }
})

Deno.test("the classifier model must be a name, not an expression", () => {
  assertEquals(
    loadClassifier("classifier.endpoint = http://127.0.0.1:8086/v1\nclassifier.model = m;rm\n"),
    "refused bad_classifier",
  )
})

Deno.test("an explicit role.default is told apart from the built-in default", () => {
  const r = py(`
from gator_sched.config import load
print(load([]).default_explicit, load([${
    JSON.stringify(cfg("role.default = heavy\n"))
  }]).default_explicit)
`)
  assertEquals(r.code, 0, r.out)
  assertEquals(r.out.trim(), "False True")
})

Deno.test("resolution_inputs names what a recommendation was computed from", () => {
  const p = cfg("role.review = remote\nrole.default = standard\n" + CLASSIFIER)
  const r = py(`
import json
from gator_sched.config import load, resolution_inputs
print(json.dumps(resolution_inputs(load([${JSON.stringify(p)}])), sort_keys=True))
print(json.dumps(resolution_inputs(load([])), sort_keys=True))
`)
  assertEquals(r.code, 0, r.out)
  const [full, empty] = r.out.trim().split("\n").map((l) => JSON.parse(l))
  assertEquals(full, {
    classifier: { endpoint: "http://127.0.0.1:8086/v1", model: "m", threshold: 0.75 },
    default_class: "standard",
    role_map: { review: "remote" },
  })
  assertEquals(empty, { role_map: {} })
})
