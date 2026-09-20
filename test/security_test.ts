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

Deno.test("SEC-5: the flood is not buffered — peak memory stays bounded", () => {
  // The refusal alone is not evidence: the first attempt at this fix still
  // held 1.16 GB to produce it, because killing the shell left the pipeline
  // it had started writing into the pipe. Measure, do not assume.
  const flood = join(mkdtempSync(join(tmpdir(), "gator-flood-")), "f.sh")
  writeFileSync(
    flood,
    `#!/usr/bin/env bash
cat >/dev/null
head -c 400000000 /dev/zero | tr '\0' 'x'
`,
  )
  Deno.chmodSync(flood, 0o755)

  const NL = String.fromCharCode(10)
  const probe = `
import resource, sys
sys.path.insert(0, ${JSON.stringify(join(import.meta.dirname!, "../skill/gator"))})
from gator_auto.planner import invoke
from gator_auto.repo import Refusal
try:
    invoke("bash ${flood}", "prompt", 60)
    print("NOREFUSAL")
except Refusal as r:
    print(r.code)
print(int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024))
`
  const { stdout } = new Deno.Command("python3", { args: ["-c", probe] }).outputSync()
  const [code, mb] = new TextDecoder().decode(stdout).trim().split(NL)
  assertEquals(code, "planner_output_too_large")
  assertEquals(
    Number(mb) < 200,
    true,
    `peak RSS was ${mb} MB rejecting a 400 MB flood; it must not be buffered`,
  )
})

// ======================================== finding 6: terminal-escape injection

Deno.test("SEC-6: control characters in planner strings are refused", () => {
  const dir = specRepo()
  const esc = String.fromCharCode(27)
  const hostile = JSON.stringify({
    candidates: [{
      id: "looks-fine",
      source_ref: "SPEC.md#x",
      title: `Harmless${esc}[2K\rFORGED`,
      task: "x".repeat(300),
      scope: ["src/**"],
      acceptance: [{ id: "A1", criterion: "ok" }],
      depends_on: [],
      benefit: 3,
      clarity: 2,
      boundedness: 2,
      risk: "normal",
      rationale: "r",
    }],
  })
  const p = join(mkdtempSync(join(tmpdir(), "gator-pl-")), "p.sh")
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\ncat <<'J'\n${hostile}\nJ\n`)
  Deno.chmodSync(p, 0o755)

  const r = run(dir, ["auto", "plan", "--from", "SPEC.md", "--json"], {
    GATOR_PLANNER_CMD: `bash ${p}`,
    GATOR_VERIFY: "true",
    GATOR_PLAN_COOLDOWN: "0",
  })
  assertEquals(r.code, 2)
  assertStringIncludes(r.out, "candidate_control_characters")
  assertEquals(r.out.includes(esc), false, "no escape reaches the terminal")
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
