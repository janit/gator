import { assertEquals } from "@std/assert"
import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
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
  for (const f of ["SKILL.md", "gator", "gator-unit", "gator-auto.py", "gator-record.py"]) {
    assertEquals(existsSync(join(skill, f)), true, `${f} installed`)
  }
  for (const f of ["__init__.py", "commands.py", "plan.py", "planner.py", "rank.py", "repo.py"]) {
    assertEquals(existsSync(join(skill, "gator_auto", f)), true, `gator_auto/${f} installed`)
  }
  // The canonical copy on PATH needs the package too, or `gator auto` breaks
  // the moment this checkout moves.
  assertEquals(existsSync(join(home, ".local", "share", "gator", "gator_auto", "rank.py")), true)
})

Deno.test("the installer makes the entry points executable", () => {
  const home = mkdtempSync(join(tmpdir(), "gator-home-"))
  mkdirSync(join(home, ".claude", "skills"), { recursive: true })
  new Deno.Command("deno", {
    args: ["run", "-A", join(import.meta.dirname!, "../scripts/install.ts")],
    env: { HOME: home, PATH: Deno.env.get("PATH")! },
  }).outputSync()

  for (const f of ["gator", "gator-unit", "gator-auto.py", "gator-record.py"]) {
    const mode = Deno.statSync(join(home, ".local", "share", "gator", f)).mode!
    assertEquals((mode & 0o111) !== 0, true, `${f} is executable`)
  }
})
