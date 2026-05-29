---
description: After fixing a bug in one portal, sweep the other two portals + shared code for the same pattern. Read-only audit; reports only, never fixes.
---

Use the code-reviewer subagent. Cross-portal audit task.

I just fixed a bug. Find every other place the same pattern exists across the codebase before I commit.

## Method

1. Ask me (if not stated): which portal was the fix in, and what was the buggy pattern.
2. Determine the OTHER portals to sweep:
   - Fix in `(dashboard)/` → sweep `(student)/student/` and `(admin)/admin/`
   - Fix in `(student)/student/` → sweep `(dashboard)/` and `(admin)/admin/`
   - Fix in `(admin)/admin/` → sweep `(dashboard)/` and `(student)/student/`
3. Always also sweep shared code: `src/lib/`, `src/components/`, `src/app/api/`, `src/proxy.ts`.
4. Use `rg` (ripgrep) to find the pattern. Read each match in full — not just the matching line.
5. For each match, decide: same bug, similar but safe, or unrelated.

## Output

Report only. Do NOT fix anything. Format:

**CONFIRMED — same bug**
- file:line — what's wrong, why it's the same pattern

**LIKELY — needs review**
- file:line — looks similar, requires human judgement

**SAFE — pattern present but correct in context**
- file:line — one-line reason it's not a bug here

**CLEAN** — if no other instances found, say so plainly.

Stop after the report. I'll decide what to fix next.
