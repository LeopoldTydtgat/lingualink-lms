#!/usr/bin/env node
/**
 * quality-gate.mjs — Stop hook for Claude Code (LinguaLink Online)
 *
 * Fires ONCE when Claude Code finishes a turn (not on every edit).
 * Runs the TypeScript compiler in no-emit mode across the whole project.
 * If there are type errors, it exits with code 2 — which Claude Code treats
 * as "do not stop, here is what is wrong" and feeds stderr back to Claude so
 * it keeps working until the code typechecks clean.
 *
 * Why a Stop hook and not PostToolUse:
 *   PostToolUse fires after EVERY file edit. Running tsc dozens of times per
 *   turn is painfully slow. Stop runs once, at the end — the right place for
 *   a whole-project typecheck.
 *
 * Why Node and not bash:
 *   This repo is developed on Windows/PowerShell. A .sh script would not run.
 *   Node is already installed (it is a Next.js project) and is cross-platform.
 *
 * Loop-guard:
 *   The hook input includes stop_hook_active. When Claude is already being
 *   kept alive by a previous Stop-hook block, we do NOT block again — otherwise
 *   a genuinely unfixable error would loop forever. We surface the errors but
 *   let Claude stop, so you (Leopold) can step in.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, derived from this file's own location (.claude/hooks/quality-gate.mjs)
// rather than process.cwd() — the hook can be spawned with an unpredictable cwd.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Read the JSON event Claude Code sends on stdin.
let event = {};
try {
  const raw = readStdin();
  if (raw.trim()) event = JSON.parse(raw);
} catch {
  // If we cannot parse the event, fail open (do not block) — a broken hook
  // must never wedge the whole session.
  process.exit(0);
}

// Loop-guard: if we are already inside a Stop-hook continuation, don't re-block.
if (event.stop_hook_active) {
  process.exit(0);
}

// Run the TypeScript compiler. `npx tsc --noEmit` uses the project's own
// tsconfig.json, so path aliases (@/...) and Next.js settings are respected.
const result = spawnSync("npx", ["tsc", "--noEmit"], {
  encoding: "utf8",
  shell: true, // needed on Windows so `npx` resolves
  cwd: repoRoot,
});

const output = `${result.stdout || ""}${result.stderr || ""}`.trim();

if (result.status === 0) {
  // Clean. Exit 0 silently (Claude Code does not show stdout on exit 0).
  process.exit(0);
}

// Type errors found. Exit 2 so Claude Code feeds this back and keeps working.
process.stderr.write(
  "TypeScript typecheck FAILED. Fix every error below before finishing.\n" +
    "These are real type errors caught by `tsc --noEmit`, not warnings.\n\n" +
    output +
    "\n"
);
process.exit(2);
