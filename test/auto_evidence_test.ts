// The pilot of 2026-09-20 could not diagnose its own failures: the raw planner
// response was discarded, the prompt collected only the winner, and "found
// nothing" was indistinguishable from "rejected everything". These are the
// tests for closing that.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, repo, run } from "./harness.ts"

function specRepo(): string {
  const dir = repo("echo hi")
  writeFileSync(join(dir, "SPEC.md"), "# Spec\n\n## Thing\n\nDo the thing.\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "spec")
  return dir
}

function planner(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "gator-pl-")), "p.sh")
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\n${body}\n`)
  chmodSync(p, 0o755)
  return `bash ${p}`
}

const emits = (s: string) => `cat <<'JSONEOF'\n${s}\nJSONEOF`

const cand = (over: Record<string, unknown> = {}) => ({
  id: "c",
  source_ref: "SPEC.md#thing",
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

const plan = (dir: string, cmd: string, env: Record<string, string> = {}) =>
  run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_PLANNER_CMD: cmd,
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
    ...env,
  })

// ------------------------------------------- gap 1: keep the raw response

Deno.test("EVIDENCE: the raw planner response is kept beside the plan", () => {
  const dir = specRepo()
  const body = JSON.stringify({ candidates: [cand()] })
  const r = plan(dir, planner(emits("thinking out loud...\n" + body)))
  assertEquals(r.code, 0, r.out)
  const id = JSON.parse(r.out).plan_id

  const raw = Deno.readTextFileSync(join(dir, ".gator", "auto", "plans", `${id}.raw.txt`))
  assertStringIncludes(raw, "thinking out loud")
  assertStringIncludes(raw, "candidates")
})

Deno.test("EVIDENCE: a response that fails validation is still kept", () => {
  // This is the case that matters: when the plan cannot be built there is no
  // plan to file the evidence under, and that is exactly when it is needed.
  const dir = specRepo()
  const r = plan(dir, planner(emits('{"candidates":[{"id":"x","worker_cmd":"rm -rf /"}]}')))
  assertEquals(r.code, 0, r.out)
  const p = JSON.parse(r.out)
  // The candidate is unusable, so it is reported and can never be selected.
  assertEquals(p.selected_id, null)
  assertEquals(p.rejected[0].reason, "candidate_unknown_field")

  const last = Deno.readTextFileSync(join(dir, ".gator", "auto", "last-response.txt"))
  assertStringIncludes(last, "worker_cmd")
})

Deno.test("EVIDENCE: a response that is not JSON at all is kept", () => {
  const dir = specRepo()
  const r = plan(dir, planner(`echo "I would refactor the auth module, I think."`))
  assertEquals(r.code, 2)
  const last = Deno.readTextFileSync(join(dir, ".gator", "auto", "last-response.txt"))
  assertStringIncludes(last, "refactor the auth module")
})

Deno.test("EVIDENCE: kept responses are not world-readable", () => {
  const dir = specRepo()
  plan(dir, planner(emits(JSON.stringify({ candidates: [cand()] }))))
  const mode = Deno.statSync(join(dir, ".gator", "auto", "last-response.txt")).mode!
  assertEquals(mode & 0o077, 0, "the response may quote the source; 0600")
})

// ------------------------- gap 2: every item considered, with its rejection

Deno.test("EVIDENCE: ineligible candidates are reported, not dropped", () => {
  const dir = specRepo()
  const body = JSON.stringify({
    candidates: [
      cand({ id: "good", benefit: 3 }),
      cand({ id: "chore", benefit: 1, source_ref: "SPEC.md#chore" }),
      cand({ id: "vague", clarity: 1, source_ref: "SPEC.md#vague" }),
    ],
  })
  const r = plan(dir, planner(emits(body)))
  assertEquals(r.code, 0, r.out)
  const p = JSON.parse(r.out)
  assertEquals(p.selected_id, "good")
  // deno-lint-ignore no-explicit-any
  const reasons = Object.fromEntries(p.rejected.map((x: any) => [x.id, x.reason]))
  assertEquals(reasons.chore, "benefit_below_threshold")
  assertEquals(reasons.vague, "needs_clarification")
})

Deno.test("EVIDENCE: the prompt asks for every item considered, rated", () => {
  const dir = specRepo()
  const d = mkdtempSync(join(tmpdir(), "gator-pl-"))
  const p = join(d, "p.sh")
  const promptFile = join(d, "prompt.txt")
  writeFileSync(
    p,
    `#!/usr/bin/env bash\ncat > ${promptFile}\n${
      emits(JSON.stringify({ candidates: [cand()] }))
    }\n`,
  )
  chmodSync(p, 0o755)
  plan(dir, `bash ${p}`)

  const prompt = Deno.readTextFileSync(promptFile)
  assertStringIncludes(prompt, "every")
  assertStringIncludes(prompt, "Do not pre-select")
})

// ----------------- gap 3: "found nothing" is not "rejected everything"

Deno.test("EVIDENCE: rejecting everything is distinct from finding nothing", () => {
  const dir = specRepo()
  const none = plan(dir, planner(emits('{"candidates": []}')))
  assertEquals(none.code, 0, none.out)
  assertEquals(JSON.parse(none.out).outcome, "no_items")

  const all = plan(dir, planner(emits(JSON.stringify({ candidates: [cand({ clarity: 0 })] }))))
  assertEquals(all.code, 0, all.out)
  assertEquals(JSON.parse(all.out).outcome, "none_eligible")

  const ok = plan(dir, planner(emits(JSON.stringify({ candidates: [cand()] }))))
  assertEquals(JSON.parse(ok.out).outcome, "selected")
})

Deno.test("EVIDENCE: finding nothing says so, and points at the response", () => {
  const dir = specRepo()
  const r = run(dir, ["auto", "plan", "--from", "SPEC.md"], {
    GATOR_PLANNER_CMD: planner(emits('{"candidates": []}')),
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "no work items at all")
  assertStringIncludes(r.out, "last-response.txt")
})

Deno.test("EVIDENCE: rejecting everything reads differently from finding nothing", () => {
  const dir = specRepo()
  const r = run(dir, ["auto", "plan", "--from", "SPEC.md"], {
    GATOR_PLANNER_CMD: planner(emits(JSON.stringify({ candidates: [cand({ clarity: 0 })] }))),
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertStringIncludes(r.out, "Considered 1")
  assertStringIncludes(r.out, "none eligible")
})

// ------------------------------------- only selectable items need a full task

Deno.test("EVIDENCE: the prompt does not tie task length to the rating", () => {
  // Tried on 2026-09-20: "write the full task only for items you rate as
  // selectable". It made rating something selectable *more work*, and the
  // ratings moved — correct selections went 3 of 4 to 1 of 4 while latency
  // did not improve. Never couple the effort a rating costs to the rating.
  const dir = specRepo()
  const d = mkdtempSync(join(tmpdir(), "gator-pl-"))
  const p = join(d, "p.sh")
  const promptFile = join(d, "prompt.txt")
  writeFileSync(
    p,
    `#!/usr/bin/env bash\ncat > ${promptFile}\n${
      emits(JSON.stringify({ candidates: [cand()] }))
    }\n`,
  )
  chmodSync(p, 0o755)
  plan(dir, `bash ${p}`)

  const prompt = Deno.readTextFileSync(promptFile)
  assertEquals(prompt.includes("only for items you rate as selectable"), false)
  assertStringIncludes(prompt, "Do not pre-select")
})
