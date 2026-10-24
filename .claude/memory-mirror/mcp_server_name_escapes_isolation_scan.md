---
name: mcp-server-name-escapes-isolation-scan
description: 'FIXED in PR #211: agentIsolationApplies now scans the external text adaptPrompt appends after it decides — repo mcpServers keys and KB titles; appReach needed no scan, and the digest half reaches across repos'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-22T16:22:00.000Z
---

Found 2026-09-22 by Codex on PR #202 (two rounds, two instances) and VERIFIED in code, not accepted on
the report.

**The shape:** `orchestrator/dispatcher.ts:461` decides `const isolated = agentIsolationApplies(req)`
against `req.input.prompt`. `adaptPrompt` (:462-518) then makes SEVEN appends. Three carry text Haive
did not write, so a path in any of them reaches the FINAL prompt of an invocation already chosen for
isolation — the one thing that rule exists to prevent:

- `withMcpSurface` (:481) — the repository's own `.claude/mcp_settings.json` `mcpServers` KEYS, taken
  verbatim by `loadUserMcpServers` (`sandbox/mcp-surface.ts:198`) and interpolated at :383-385.
- `withGlobalKbDigest` (:512) — author-written KB entry TITLES, interpolated verbatim.
- `withAppReach` (:503) — the resolved app URL and `addHosts`.

The other four are Haive constants (`withWorktreeGitBoundary`, `withDdevGeneratedBoundary`,
`withModelCapabilityBoundary`) or `adaptPromptForCliCapabilities`, whose persona bodies are already
scanned separately and verbatim.

**FIXED 2026-09-22 in PR #211** (merge commit `689f842a`, main green), as a seventh condition on the
rule. It scans `Object.keys(req.mcpSurface?.userServers ?? {})` plus every digest entry's title and
category, and stays PURE — `resolveTaskDispatch` resolves both fields before `resolveDispatch`, so they
are already on the request. Red-to-green: the three negative cases in `agent-isolation-rule.test.ts`
failed `expected true to be false` on the unfixed rule.

Two decisions in that fix worth not re-litigating. It scans ALL user server keys, not the ones a run
renders: `reachableUserServerNames` needs the emitted-server set, which depends on render options a pure
rule has none of, and shadowing is run-time state, so isolation keyed on it would flicker between runs of
one repository. And `withAppReach` needed NO scan — traced, not assumed: it interpolates `reach.url`
alone (never `addHosts`), which is ddev's `primary_url`, scheme://host[:port] with no path component, and
a hostname cannot contain a slash. So the class was TWO appends, not three.

**The fix was not per-field, and that mattered.** "Also scan server names" then "also scan titles" is how
it was found — one Codex round each. The decision has to account for every append carrying external text.

**STILL OPEN, and it needs the live install:** the two halves have different blast radii. The MCP half is
per-repository. The digest half is NOT — `resolveGlobalKbDigest` returns stack-matching entries from the
SHARED global KB, so one entry whose TITLE names an agent path would end isolation for every dispatch on
every repo matching that stack. Safe direction (a lost context saving, never a hidden file) and the same
way the instruction scan already fails open, but if such a title exists, RENAME the entry rather than
narrow the rule. Not checkable without the stack.

**Severity while it was open, stated honestly:** the rendered lines NAME a path but never instructed the
agent to open one, so the concrete failure the rule guards against — an agent told to read a file the mask
hides — did not follow from that text alone. The invariant was broken; the harm was bounded.

**Where the coverage lives now.** The rule's own cases are in `orchestrator/agent-isolation-rule.test.ts`
(MCP server name, digest title, benign-and-absent, and the deliberately-scanned SHADOWED name).
`prompt-agent-paths.test.ts` keeps a case named "the appended external text is scanned by the RULE, not
only rendered here" — renamed from "PINS a production asymmetry" when the fix landed — and both
`mcpSurfacePrompt (agent-path-shaped server name)` and `globalKbDigestPrompt (agent-path-shaped title)`
stay in its expected `named` list, because the BUILDERS do render a path when handed such a value, which
is the thing the rule now has to see. `AGENTS.md`'s rule paragraph says SEVEN conditions.

**How to apply:** `withAppReach` has no path-shaped fixture and needs none (see the trace above). If the
rule is ever narrowed to only the rendered server names, the shadowed-name case is the one that will fail,
and its comment says why it should not be. Related: [[agent-isolation-open-items]].
