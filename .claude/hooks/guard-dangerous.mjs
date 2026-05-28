#!/usr/bin/env node
/**
 * guard-dangerous.mjs — PreToolUse hook for Claude Code (LinguaLink Online)
 *
 * Fires BEFORE a Bash/Write/Edit/MultiEdit tool call runs. If the action
 * matches a catastrophic pattern, it exits 2 to BLOCK the call and tells
 * Claude why. Exit 0 lets the action through.
 *
 * These are encodings of your existing non-negotiable rules, made
 * DETERMINISTIC (a CLAUDE.md instruction is advisory; a hook is enforced):
 *   - DDL only via the Supabase SQL editor — never through Claude Code.
 *   - Never create middleware.ts (the project uses src/proxy.ts exclusively).
 *   - No destructive SQL / filesystem / git operations from inside Claude Code.
 *
 * Robust to schema changes: rather than depending on exact stdin field names,
 * we stringify the whole event payload and test it. For these narrow,
 * catastrophic patterns the only place the text appears is the command/path,
 * so this is safe. Patterns are deliberately kept catastrophic-only to avoid
 * false positives interrupting normal work.
 */

import fs from "node:fs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const raw = readStdin();

// Fail open: a guard that crashes must never wedge the session.
if (!raw.trim()) process.exit(0);

// Skip documentation files — hook patterns false-positive on agent prompts
// that legitimately describe SQL/RLS patterns as things to look for.
try {
  const parsed = JSON.parse(raw);
  const toolInput = parsed.tool_input || {};
  const filePath = (toolInput.file_path || toolInput.path || "").replace(/\\/g, "/").toLowerCase();
  if (filePath) {
    if (
      filePath.includes("/.claude/agents/") ||
      filePath.includes("/.claude/hooks/") ||
      filePath.endsWith(".md")
    ) {
      process.exit(0);
    }
  }
} catch {
  // fall through to rule checks
}

// We test the raw payload text. Lowercase a copy for case-insensitive matching.
const haystack = raw;
const lower = raw.toLowerCase();

/** Each rule: a test against the payload + the message shown to Claude on block. */
const rules = [
  {
    hit: () => /\brm\s+-rf\b/i.test(haystack),
    msg: "Blocked: `rm -rf` is destructive and not permitted from Claude Code. Delete files individually and deliberately.",
  },
  {
    hit: () =>
      /\b(drop|truncate)\s+(table|schema|database)\b/i.test(haystack) ||
      /\bdrop\s+schema\b/i.test(haystack),
    msg: "Blocked: destructive SQL (DROP/TRUNCATE). All schema changes go through the Supabase SQL editor, reviewed by Leopold — never executed from Claude Code.",
  },
  {
    hit: () =>
      /\b(alter|create)\s+table\b/i.test(haystack) ||
      /\bcreate\s+policy\b/i.test(haystack) ||
      /\balter\s+policy\b/i.test(haystack),
    msg: "Blocked: DDL / RLS policy change detected. RULE: DDL and RLS policies are applied via the Supabase SQL editor only, never through Claude Code. Draft the SQL for Leopold to run instead.",
  },
  {
    hit: () =>
      /git\s+push\b[^\n]*(--force|-f)\b/i.test(haystack) &&
      /\bmain\b/i.test(haystack),
    msg: "Blocked: force-push to main. Never force-push the main branch.",
  },
  {
    hit: () => /(^|[\\/])middleware\.ts\b/i.test(lower),
    msg: "Blocked: creating/editing middleware.ts. This project uses src/proxy.ts exclusively — middleware.ts and proxy.ts cannot coexist.",
  },
];

for (const rule of rules) {
  if (rule.hit()) {
    process.stderr.write(rule.msg + "\n");
    process.exit(2); // block
  }
}

process.exit(0); // allow
