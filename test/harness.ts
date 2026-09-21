// Shared test harness. Every test file outside gator_test.ts imports from here;
// gator_test.ts keeps its own copy so the legacy suite stays untouched.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const SCRIPT = join(import.meta.dirname!, "../skill/gator/gator")
export const LONG_TASK = "x".repeat(300)
export const workerPath = new Map<string, string>()

export function git(cwd: string, ...args: string[]) {
  const { success, stderr } = new Deno.Command("git", { args, cwd }).outputSync()
  if (!success) throw new Error(new TextDecoder().decode(stderr))
}

/** Like gator_test.ts's repo(), but the repository directory can be named. */
export function repoNamed(worker: string, dirName: string): string {
  const parent = mkdtempSync(join(tmpdir(), "gator-parent-"))
  const dir = join(parent, dirName)
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
  writeFileSync(join(dir, "base.txt"), "base\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "base")

  // The stub lives outside the repo, so the caller's tree stays clean.
  const bin = mkdtempSync(join(tmpdir(), "gator-worker-"))
  writeFileSync(join(bin, "worker.sh"), worker)
  chmodSync(join(bin, "worker.sh"), 0o755)
  workerPath.set(dir, join(bin, "worker.sh"))
  return dir
}

export const repo = (worker: string) => repoNamed(worker, "plain")

export function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const { code, stdout, stderr } = new Deno.Command(SCRIPT, {
    args,
    cwd: dir,
    env: {
      // A developer's own resources file may configure a classifier. The suite
      // must never send task text to it, so the default is no file at all.
      GATOR_RESOURCES: "/dev/null",
      GATOR_ROLE_heavy: "stub/model",
      GATOR_WORKER_CMD: `bash ${workerPath.get(dir)}`,
      GATOR_COOLDOWN: "0",
      GATOR_POLL: "0.2",
      ...env,
    },
  }).outputSync()
  const d = new TextDecoder()
  return { code, out: d.decode(stdout) + d.decode(stderr) }
}

export const feed = (
  dir: string,
  title: string,
  scope = "src/**",
  env: Record<string, string> = {},
  task?: string,
) =>
  run(
    dir,
    // The task text is deduplicated per repository, so a second unit in the
    // same repo needs distinct text. Default to the title plus padding.
    ["feed", "--title", title, "--scope", scope, "--task", task ?? `${title} ${LONG_TASK}`],
    env,
  )

export const waitForUnit = (dir: string, env: Record<string, string> = {}) =>
  run(dir, ["wait"], env)
