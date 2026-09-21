import { assertEquals } from "@std/assert"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

Deno.test("the installer copies the controller and its package", () => {
  const home = mkdtempSync(join(tmpdir(), "gator-home-"))
  mkdirSync(join(home, ".claude", "skills"), { recursive: true })

  const { code, stderr } = new Deno.Command("deno", {
    args: ["run", "-A", join(import.meta.dirname!, "../scripts/install.ts")],
    env: { HOME: home, PATH: Deno.env.get("PATH")! },
  }).outputSync()
  assertEquals(code, 0, new TextDecoder().decode(stderr))

  const skill = join(home, ".claude", "skills", "gator")
  for (
    const f of [
      "SKILL.md",
      "gator",
      "gator-unit",
      "gator-auto.py",
      "gator-record.py",
      "gator-sched.py",
    ]
  ) {
    assertEquals(existsSync(join(skill, f)), true, `${f} installed`)
  }
  for (const f of ["__init__.py", "commands.py", "plan.py", "planner.py", "rank.py", "repo.py"]) {
    assertEquals(existsSync(join(skill, "gator_auto", f)), true, `gator_auto/${f} installed`)
  }
  // The scheduler is a second package beside the controller. Without it every
  // feed fails at dispatch, so it is worth asserting rather than trusting the
  // directory walk to keep finding it.
  for (const f of ["__init__.py", "config.py", "health.py", "leases.py", "policy.py"]) {
    assertEquals(existsSync(join(skill, "gator_sched", f)), true, `gator_sched/${f} installed`)
  }
  // The canonical copy on PATH needs both packages too, or `gator` breaks the
  // moment this checkout moves.
  assertEquals(existsSync(join(home, ".local", "share", "gator", "gator_auto", "rank.py")), true)
  assertEquals(existsSync(join(home, ".local", "share", "gator", "gator_sched", "policy.py")), true)
})

Deno.test("an installed gator can schedule a unit from the canonical copy", () => {
  // The end-to-end shape the installer exists for: the copy on PATH, with no
  // repository checkout beside it, still resolves its own scheduler package.
  const home = mkdtempSync(join(tmpdir(), "gator-home-"))
  mkdirSync(join(home, ".claude", "skills"), { recursive: true })
  new Deno.Command("deno", {
    args: ["run", "-A", join(import.meta.dirname!, "../scripts/install.ts")],
    env: { HOME: home, PATH: Deno.env.get("PATH")! },
  }).outputSync()

  // A role is mapped to a class by configuration; unmapped it takes the default.
  // Pass a file, so this proves the whole path rather than only the fallback.
  const resources = join(home, "resources")
  writeFileSync(resources, "role.heavy = heavy\n")

  const sched = join(home, ".local", "share", "gator", "gator-sched.py")
  const { code, stdout } = new Deno.Command("python3", {
    args: [sched, "resolve", "--store", home, "--role", "heavy", "--config", resources],
  }).outputSync()
  const out = new TextDecoder().decode(stdout)
  assertEquals(code, 0, out)
  assertEquals(out.includes("resource=heavy"), true, out)
  assertEquals(out.includes("eligible=local-5090"), true, out)
})

Deno.test("the installer makes the entry points executable", () => {
  const home = mkdtempSync(join(tmpdir(), "gator-home-"))
  mkdirSync(join(home, ".claude", "skills"), { recursive: true })
  new Deno.Command("deno", {
    args: ["run", "-A", join(import.meta.dirname!, "../scripts/install.ts")],
    env: { HOME: home, PATH: Deno.env.get("PATH")! },
  }).outputSync()

  for (
    const f of ["gator", "gator-unit", "gator-auto.py", "gator-record.py", "gator-sched.py"]
  ) {
    const mode = Deno.statSync(join(home, ".local", "share", "gator", f)).mode!
    assertEquals((mode & 0o111) !== 0, true, `${f} is executable`)
  }
})
