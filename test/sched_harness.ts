// Shared harness for the scheduler tests, alongside the existing harness.ts.
//
// The gator_sched package is driven through `python3 -c` the way
// test/security_test.ts drives the planner. There is no Python test runner in
// this project, and adding one to exercise a handful of pure functions would
// cost more than it returns.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const PKG = join(import.meta.dirname!, "../skill/gator")
export const SCHED = join(PKG, "gator-sched.py")

/** Run a snippet with skill/gator on sys.path. */
export function py(body: string): { code: number; out: string } {
  const src = `import sys\nsys.path.insert(0, ${JSON.stringify(PKG)})\n${body}`
  const { code, stdout, stderr } = new Deno.Command("python3", { args: ["-c", src] })
    .outputSync()
  const d = new TextDecoder()
  return { code, out: d.decode(stdout) + d.decode(stderr) }
}

/** Write a resources file and return its path. */
export function cfg(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "gator-res-")), "resources")
  writeFileSync(path, text)
  return path
}

/** A fresh, empty .gator-style store directory. */
export function store(): string {
  return mkdtempSync(join(tmpdir(), "gator-store-"))
}

/** Invoke the scheduler CLI directly. */
export function sched(args: string[]): { code: number; out: string } {
  const { code, stdout, stderr } = new Deno.Command("python3", { args: [SCHED, ...args] })
    .outputSync()
  const d = new TextDecoder()
  return { code, out: d.decode(stdout) + d.decode(stderr) }
}

/** Invoke the scheduler CLI with `input` on stdin. Sync, via a file redirect. */
export function schedStdin(args: string[], input: string): { code: number; out: string } {
  const file = join(mkdtempSync(join(tmpdir(), "gator-stdin-")), "in")
  writeFileSync(file, input)
  const { code, stdout, stderr } = new Deno.Command("bash", {
    args: ["-c", 'exec python3 "$0" "$@" < "$GATOR_TEST_STDIN"', SCHED, ...args],
    env: { GATOR_TEST_STDIN: file },
  }).outputSync()
  const d = new TextDecoder()
  return { code, out: d.decode(stdout) + d.decode(stderr) }
}

export const STUB = join(import.meta.dirname!, "fixtures/classifier_stub.py")

/**
 * Start the stand-in classifier endpoint. It is a separate process on purpose:
 * `py()` and `run()` block the Deno event loop, so a server inside this process
 * could never answer them.
 */
export async function classifierStub(mode: string) {
  const log = join(mkdtempSync(join(tmpdir(), "gator-stub-")), "requests.jsonl")
  const child = new Deno.Command("python3", {
    args: [STUB, mode, log],
    stdout: "piped",
    stderr: "null",
  }).spawn()
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) throw new Error("classifier stub exited before announcing its port")
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  await child.stdout.cancel()
  return {
    url: `http://127.0.0.1:${text.trim()}/v1`,
    // deno-lint-ignore no-explicit-any
    requests(): { path: string; body: any }[] {
      if (!existsSync(log)) return []
      return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    },
    async stop() {
      child.kill()
      await child.status
    },
  }
}
