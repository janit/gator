#!/usr/bin/env -S deno run -A
// Installs the gator skill into whichever hosts are present. The skill is one
// SKILL.md plus two scripts, and every host that reads `skills/<name>/SKILL.md`
// takes it unchanged.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const repoRoot = join(import.meta.dirname!, "..")
const src = join(repoRoot, "skill", "gator")

// The skill is no longer a fixed list of files: the auto controller ships as a
// package directory beside the scripts. Walk it instead of naming every file,
// so adding a module does not mean remembering to edit the installer.
const SKIP = new Set(["__pycache__", ".pytest_cache"])

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP.has(entry) || entry.endsWith(".pyc")) continue
    const full = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(full).isDirectory()) out.push(...walk(full, rel))
    else out.push(rel)
  }
  return out
}

const files = walk(src)

// Entry points the shell invokes directly; everything else is imported.
const EXECUTABLE = new Set([
  "gator",
  "gator-unit",
  "gator-auto.py",
  "gator-record.py",
  "gator-sched.py",
])

function install(destDir: string) {
  for (const name of files) {
    const dest = join(destDir, name)
    mkdirSync(join(dest, ".."), { recursive: true })
    copyFileSync(join(src, name), dest)
    if (EXECUTABLE.has(name)) chmodSync(dest, 0o755)
  }
}

const targets = [
  { host: "OpenCode", dir: join(homedir(), ".config", "opencode", "skill", "gator") },
  { host: "Claude Code", dir: join(homedir(), ".claude", "skills", "gator") },
  { host: "Pi", dir: join(homedir(), ".pi", "skills", "gator") },
]

let installed = 0
for (const { host, dir } of targets) {
  // Only install where the host's config directory already exists; creating one
  // for a tool that is not installed would be litter.
  const parent = join(dir, "..", "..")
  if (!existsSync(parent)) {
    console.log(`skipped ${host} (no ${parent})`)
    continue
  }
  mkdirSync(dir, { recursive: true })
  install(dir)
  console.log(`installed ${host} → ${dir}`)
  installed++
}

if (installed === 0) console.error("no supported host config directory found")

// `gator` on PATH, so a repository needs no symlink of its own. The command
// resolves its own real path, so the helper beside it is found through the link.
// A canonical copy, so the command keeps working if this checkout moves or goes
// away. The host skill directories get their own copies for discovery.
const libDir = join(homedir(), ".local", "share", "gator")
mkdirSync(libDir, { recursive: true })
install(libDir)
console.log(`installed ${libDir}`)

const binDir = join(homedir(), ".local", "bin")
if (existsSync(binDir)) {
  const onPath = (Deno.env.get("PATH") ?? "").split(":").includes(binDir)
  const link = join(binDir, "gator")
  try {
    if (existsSync(link)) unlinkSync(link)
    // The command resolves its own real path, so the helper beside the
    // canonical copy is found through this link.
    symlinkSync(join(libDir, "gator"), link)
    console.log(`linked ${link}${onPath ? "" : "  (note: not on your PATH)"}`)
  } catch (err) {
    console.error(`could not link ${link}: ${err instanceof Error ? err.message : err}`)
  }

  // v0.1.0 also linked `g8r`. Take it away again rather than leaving a stale
  // alias behind, but only if it is ours.
  const stale = join(binDir, "g8r")
  try {
    if (existsSync(stale) && Deno.readLinkSync(stale) === join(libDir, "gator")) {
      unlinkSync(stale)
      console.log(`removed ${stale}`)
    }
  } catch { /* not a link of ours; leave it alone */ }
} else {
  console.log(`no ${binDir}; add ${join(libDir, "gator")} to your PATH yourself`)
}

console.log(`
Run it as \`gator\` from any git repository.

Roles live in a file rather than the environment, so no model id is in the code
and no shell profile has to be edited:

  ~/.config/gator/roles        heavy = yeti/DeepSeek-V4-Flash
  .gator/roles                 per-repository override

The same file carries worker_cmd, where %PROVIDER% and %MODEL% are substituted
from the role's model reference. Keep API keys out of it: the command appears in
process arguments, which other local users can read. Use the worker's own
environment variable or config file for the key.
`)
