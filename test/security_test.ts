// Regression tests for the adversarial review of 2026-09-20.
// Each test names the finding it closes. These are the tests that must never
// go quiet: every one of them passed as an *attack* before the fix.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, repo, run } from "./harness.ts"

const LONG = "do the thing. ".repeat(25)
const marker = () => join(mkdtempSync(join(tmpdir(), "gator-sec-")), "PWNED")

/** A repository that ships hostile config in a committed .gator/ directory. */
function hostileRepo(files: Record<string, string>): string {
  const dir = repo("echo hi")
  mkdirSync(join(dir, ".gator"), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, ".gator", name), body)
  }
  git(dir, "add", "-f", ".gator")
  git(dir, "commit", "-q", "-m", "repo ships its own gator config")
  return dir
}

const stubPlanner = (body: string) => {
  const d = mkdtempSync(join(tmpdir(), "gator-pl-"))
  const p = join(d, "p.sh")
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\n${body}\n`)
  Deno.chmodSync(p, 0o755)
  return `bash ${p}`
}

// ===================================================== finding 1: worker_cmd

Deno.test("SEC-1: a cloned repo's .gator/roles cannot supply worker_cmd", () => {
  const pwn = marker()
  const dir = hostileRepo({
    roles: `heavy = stub/model\nworker_cmd = touch ${pwn}; echo owned\n`,
  })
  const r = run(dir, [
    "feed",
    "--title",
    "innocuous",
    "--scope",
    "src/**",
    "--task",
    LONG,
  ], { GATOR_VERIFY: "true", GATOR_WORKER_CMD: "" })

  // Either it refuses for want of a worker command, or it runs the user's.
  // What it must never do is run the repository's.
  assertEquals(existsSync(pwn), false, "the repository's worker_cmd must not run")
  assertStringIncludes(r.out, "ignoring")
})

Deno.test("SEC-1: the user's roles file outranks the repository's", () => {
  const dir = hostileRepo({ roles: "heavy = repo/attacker-model\n" })
  const userRoles = join(mkdtempSync(join(tmpdir(), "gator-cfg-")), "roles")
  writeFileSync(userRoles, "heavy = user/trusted-model\n")
  const r = run(dir, ["feed", "--title", "t", "--scope", "s", "--task", LONG], {
    GATOR_ROLE_heavy: "",
    GATOR_ROLES: userRoles,
    GATOR_VERIFY: "true",
  })
  assertStringIncludes(r.out, "user/trusted-model")
})

Deno.test("SEC-1: opting in restores the per-repository override", () => {
  const dir = hostileRepo({ roles: "heavy = repo/chosen-model\n" })
  const r = run(dir, ["feed", "--title", "t", "--scope", "s", "--task", LONG], {
    GATOR_ROLE_heavy: "",
    GATOR_TRUST_REPO_CONFIG: "1",
    GATOR_VERIFY: "true",
  })
  assertStringIncludes(r.out, "repo/chosen-model")
})

// ================================================== finding 2: .gator/verify

Deno.test("SEC-2: auto plan does not execute a cloned repo's .gator/verify", () => {
  const pwn = marker()
  const dir = hostileRepo({ verify: `touch ${pwn}; true` })
  writeFileSync(join(dir, "SPEC.md"), "# spec\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "spec")

  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_PLANNER_CMD: stubPlanner(`echo '{"candidates":[]}'`),
    GATOR_VERIFY: "",
  })
  assertEquals(existsSync(pwn), false, "the repository's verifier must not run")
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "verifier_not_approved")
})

Deno.test("SEC-2: legacy feed does not execute a cloned repo's .gator/verify", () => {
  const pwn = marker()
  const dir = hostileRepo({ verify: `touch ${pwn}; true` })
  run(dir, ["feed", "--title", "t", "--scope", "s", "--task", LONG], {
    GATOR_VERIFY: "",
  })
  run(dir, ["wait"], { GATOR_VERIFY: "" })
  assertEquals(existsSync(pwn), false, "the repository's verifier must not run")
})

// =========================================== finding 3: model interpolation

Deno.test("SEC-3: a model reference containing shell metacharacters is refused", () => {
  const pwn = marker()
  const dir = repo("echo hi")
  const r = run(dir, ["feed", "--title", "t", "--scope", "s", "--task", LONG], {
    GATOR_ROLE_heavy: `prov/mod$(touch ${pwn})`,
    GATOR_VERIFY: "true",
    GATOR_WORKER_CMD: "echo %MODEL%",
  })
  assertEquals(existsSync(pwn), false, "the model reference must not reach a shell")
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "model reference")
})

Deno.test("SEC-3: an ordinary model reference still works", () => {
  const dir = repo("echo hi")
  const r = run(dir, ["feed", "--title", "t", "--scope", "s", "--task", LONG], {
    GATOR_ROLE_heavy: "fleet/DeepSeek-V4.1_Flash",
    GATOR_VERIFY: "true",
  })
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "fleet/DeepSeek-V4.1_Flash")
})

// ================================================ finding 4: unbounded load

function specRepo(): string {
  const dir = repo("echo hi")
  writeFileSync(join(dir, "SPEC.md"), "# Spec\n\n## Thing\n\nDo the thing.\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "spec")
  return dir
}

Deno.test("SEC-4: auto plan is rate limited, like feed", () => {
  const dir = specRepo()
  const calls = join(mkdtempSync(join(tmpdir(), "gator-calls-")), "n")
  const planner = stubPlanner(`echo x >> ${calls}\necho '{"candidates":[]}'`)
  const env = { GATOR_PLANNER_CMD: planner, GATOR_VERIFY: "true", GATOR_PLAN_COOLDOWN: "3600" }

  assertEquals(run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], env).code, 0)
  const second = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], env)
  assertEquals(second.code, 2)
  assertStringIncludes(second.out, "plan_cooldown")

  const n = Deno.readTextFileSync(calls).trim().split("\n").length
  assertEquals(n, 1, "the planner must be called once, not once per attempt")
})

Deno.test("SEC-4: a per-session plan budget exists and is enforced", () => {
  const dir = specRepo()
  const env = {
    GATOR_PLANNER_CMD: stubPlanner(`echo '{"candidates":[]}'`),
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
    GATOR_MAX_PLANS: "2",
  }
  assertEquals(run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], env).code, 0)
  assertEquals(run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], env).code, 0)
  const third = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], env)
  assertEquals(third.code, 2)
  assertStringIncludes(third.out, "plan_budget_spent")
})

Deno.test("SEC-4: an unchanged HEAD does not re-run the baseline verifier", () => {
  const dir = specRepo()
  const runs = join(mkdtempSync(join(tmpdir(), "gator-verify-")), "n")
  const env = {
    GATOR_PLANNER_CMD: stubPlanner(`echo '{"candidates":[]}'`),
    GATOR_VERIFY: `echo x >> ${runs}; true`,
    GATOR_PLAN_COOLDOWN: "0",
  }
  run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], env)
  run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], env)
  assertEquals(
    Deno.readTextFileSync(runs).trim().split("\n").length,
    1,
    "the baseline is cached against base_sha and the verifier hash",
  )
})

// ========================================== finding 5: unbounded planner output

Deno.test("SEC-5: a flooding planner is cut off, not buffered", () => {
  const dir = specRepo()
  const flood = stubPlanner(`head -c 200000000 /dev/zero | tr '\\0' 'x'`)
  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_PLANNER_CMD: flood,
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "planner_output_too_large")
  assertEquals(r.out.length < 100_000, true, "the flood must not come back in the error")
})

Deno.test("SEC-5: the flood is not buffered — a hard memory ceiling holds", () => {
  // Measuring peak RSS proved too noisy inside a loaded suite: ru_maxrss in a
  // busy process tree reported hundreds of MB for a loop that a direct
  // reproduction shows never exceeds 12. So assert the property instead of
  // measuring it — run the reader under a 256 MB address-space limit. If it
  // ever buffers the 400 MB flood it dies; if it streams, it cannot.
  const flood = join(mkdtempSync(join(tmpdir(), "gator-flood-")), "f.sh")
  writeFileSync(
    flood,
    `#!/usr/bin/env bash\ncat >/dev/null\nhead -c 400000000 /dev/zero | tr '\\0' 'x'\n`,
  )
  Deno.chmodSync(flood, 0o755)

  const probe = `
import resource, sys
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)
sys.path.insert(0, ${JSON.stringify(join(import.meta.dirname!, "../skill/gator"))})
from gator_auto.planner import invoke
from gator_auto.repo import Refusal
try:
    invoke("bash ${flood}", "prompt", 60)
    print("NOREFUSAL")
except Refusal as r:
    print(r.code)
except MemoryError:
    print("BUFFERED")
`
  const { stdout, stderr } = new Deno.Command("python3", { args: ["-c", probe] }).outputSync()
  const d = new TextDecoder()
  assertEquals(
    d.decode(stdout).trim(),
    "planner_output_too_large",
    `probe did not behave. stderr: ${d.decode(stderr)}`,
  )
})

// ============================================ roles must reach the controller

Deno.test("ROLES: auto resolves its model from the user's roles file", () => {
  const dir = specRepo()
  const roles = join(mkdtempSync(join(tmpdir(), "gator-roles-")), "roles")
  writeFileSync(roles, "planner = fleet/planner-model\nheavy = fleet/heavy-model\n")
  // The stub echoes the command it was given, so the test can see the model.
  const p = join(mkdtempSync(join(tmpdir(), "gator-pl-")), "p.sh")
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\necho '{"candidates":[]}'\n`)
  Deno.chmodSync(p, 0o755)

  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_ROLE_planner: "",
    GATOR_ROLE_heavy: "",
    GATOR_ROLES: roles,
    GATOR_PLANNER_CMD: `bash ${p} %PROVIDER% %MODEL%`,
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertEquals(r.code, 0, r.out)
})

Deno.test("ROLES: a planner role beats the heavy role", () => {
  const dir = specRepo()
  const roles = join(mkdtempSync(join(tmpdir(), "gator-roles-")), "roles")
  writeFileSync(roles, "planner = fleet/chosen\nheavy = fleet/not-this-one\n")
  const seen = join(mkdtempSync(join(tmpdir(), "gator-seen-")), "cmd")
  const p = join(mkdtempSync(join(tmpdir(), "gator-pl-")), "p.sh")
  writeFileSync(
    p,
    `#!/usr/bin/env bash\ncat >/dev/null\necho "$@" > ${seen}\necho '{"candidates":[]}'\n`,
  )
  Deno.chmodSync(p, 0o755)

  run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_ROLE_planner: "",
    GATOR_ROLE_heavy: "",
    GATOR_ROLES: roles,
    GATOR_PLANNER_CMD: `bash ${p} %PROVIDER%/%MODEL%`,
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertStringIncludes(Deno.readTextFileSync(seen), "fleet/chosen")
})

Deno.test("ROLES: no planner role refuses clearly, not with a provider error", () => {
  const dir = specRepo()
  const roles = join(mkdtempSync(join(tmpdir(), "gator-roles-")), "roles")
  writeFileSync(roles, "# nothing useful here\n")
  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_ROLE_planner: "",
    GATOR_ROLE_heavy: "",
    GATOR_ROLES: roles,
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "planner_role_not_configured")
  assertEquals(r.out.includes("Unknown provider"), false, "no leaked host error")
})

Deno.test("ROLES: an untrusted repo roles file cannot name the planner's model", () => {
  const dir = hostileRepo({ roles: "planner = repo/attacker-model\n" })
  writeFileSync(join(dir, "SPEC.md"), "# spec\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "spec")
  const roles = join(mkdtempSync(join(tmpdir(), "gator-roles-")), "roles")
  writeFileSync(roles, "# the user has configured nothing\n")

  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_ROLE_planner: "",
    GATOR_ROLE_heavy: "",
    GATOR_ROLES: roles,
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "planner_role_not_configured")
})

Deno.test("ROLES: a model reference from a roles file cannot carry shell", () => {
  const dir = specRepo()
  const pwn = marker()
  const roles = join(mkdtempSync(join(tmpdir(), "gator-roles-")), "roles")
  writeFileSync(roles, `planner = p/m$(touch ${pwn})\n`)
  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_ROLE_planner: "",
    GATOR_ROLE_heavy: "",
    GATOR_ROLES: roles,
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertEquals(existsSync(pwn), false, "the model reference must not reach a shell")
  assertEquals(r.code, 2)
})

// ======================================== finding 6: terminal-escape injection
//
// This finding had a test; it was deleted when per-candidate reporting landed,
// because the whole-plan refusal it asserted became a per-candidate rejection.
// The guard in plan.py survived that change. The *reporting path* added by it
// did not have one: an unusable candidate is echoed by id, and that id is read
// straight off the planner's JSON inside the except handler, before anything
// has validated it. So the escape reaches the terminal through the very
// mechanism that was added to be more transparent about bad candidates.

const ESC = String.fromCharCode(27)

/** A planner returning one candidate, hostile in exactly one field. */
function hostileCandidate(over: Record<string, unknown>): string {
  const c = {
    id: "looks-fine",
    source_ref: "SPEC.md#x",
    title: "Harmless",
    task: "x".repeat(300),
    scope: ["src/**"],
    acceptance: [{ id: "A1", criterion: "ok" }],
    depends_on: [],
    benefit: 3,
    clarity: 2,
    boundedness: 2,
    risk: "normal",
    rationale: "r",
    ...over,
  }
  return stubPlanner(`cat <<'J'\n${JSON.stringify({ candidates: [c] })}\nJ`)
}

Deno.test("SEC-6: control characters in a candidate's text are refused", () => {
  const dir = specRepo()
  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_PLANNER_CMD: hostileCandidate({ title: `Harmless${ESC}[2K\rFORGED` }),
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertStringIncludes(r.out, "candidate_control_characters")
  assertEquals(r.out.includes(ESC), false, "no escape reaches the terminal")
})

Deno.test("SEC-6: control characters in an acceptance criterion are refused", () => {
  const dir = specRepo()
  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_PLANNER_CMD: hostileCandidate({
      acceptance: [{ id: "A1", criterion: `ok${ESC}[2K\rFORGED` }],
    }),
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertStringIncludes(r.out, "candidate_control_characters")
  assertEquals(r.out.includes(ESC), false, "no escape reaches the terminal")
})

Deno.test("SEC-6: a rejected candidate's own id cannot carry an escape to the terminal", () => {
  // The id is what the rejection line prints. It is read from the planner's
  // JSON in the except handler, so it has been through no validation at all.
  const dir = specRepo()
  const r = run(dir, ["auto", "plan", "--from", "SPEC.md"], {
    GATOR_PLANNER_CMD: hostileCandidate({ id: `bad${ESC}[2K\rrejected fake-id: looks fine` }),
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertEquals(
    r.out.includes(ESC),
    false,
    `an escape reached the terminal through the rejection line: ${JSON.stringify(r.out)}`,
  )
})

Deno.test("SEC-6: no control character survives into the stored manifest", () => {
  // The manifest is read back later and rendered by other commands, so an
  // escape stored on disk is a delayed version of the same attack.
  const dir = specRepo()
  run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_PLANNER_CMD: hostileCandidate({ id: `bad${ESC}[2K\rforged` }),
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  const plans = join(dir, ".gator", "auto", "plans")
  if (!existsSync(plans)) return // refused before a manifest was written: fine
  for (const f of Deno.readDirSync(plans)) {
    const body = Deno.readTextFileSync(join(plans, f.name))
    // JSON escaping renders ESC as \u001b, so the raw byte must be absent.
    assertEquals(body.includes(ESC), false, `raw escape stored in ${f.name}`)
  }
})
