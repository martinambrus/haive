---
name: haive-mcp-config-is-per-task-not-per-invocation
description: 'Volume-backed CLIs (codex, grok, gemini) share ONE MCP config per (task, provider), so any two concurrent invocations with different profiles race — SHELVED 2026-09-18, mechanism refuted, reopening condition inside'
metadata:
  node_type: memory
  type: project
  originSessionId: 7b103635-8824-4e07-9760-f6a4061bf2b8
  modified: 2026-09-19T14:49:18.806Z
---

**Known structural gap, raised by Codex on PR #100 and deliberately deferred to a later branch.**

For `gemini`, `codex`, `grok` and `antigravity` the MCP config is written INTO the per-task auth
volume (`volume-merge` / `cli-merge` / `volume-write` in `sandbox/mcp-config.ts`), because the path
sits inside the auth mount and bind-mounting over it is destructive both ways. Only the claude
family's `bind` delivery is per-invocation. So those four share ONE config per (task, provider),
and `exec-core` writes it immediately before starting each container — which makes the effective
rule "last writer before container start wins", for every pair of concurrent invocations, not just
for the step-summary pass.

Two consequences, both real:

- A `toolProfile: 'none'` invocation cannot be isolated. The step-summary pass is excluded by
  PURPOSE from `resolveMcpExtraFiles` rather than declaring the profile there, precisely because
  the `'none'` branch CLEARS the shared config and the recap is unlinked from the step machine —
  by the time it runs, that file belongs to whatever step is now running. The cost of that choice
  is that a recap on those four providers still inherits persisted `filesystem`, `git` and
  user-defined servers, which need no Haive proxy file to start.
- The window is not small. The npm pre-warm sits BETWEEN the config write and the container
  start and can run to a 240s budget, so "clear it and let the next invocation re-apply" is not
  a safe repair.

**Why the obvious fixes do not work:** per-scope serialization (added in `37231660`) removes
interleaved writes but cannot choose the ORDER. Clearing on the summary trades a recap's tools for
a real step's tools, which is the worse direction.

**SHELVED by the user's decision, 2026-09-18 — do not start this work, and do not re-probe.** The
plan lives at `docs/plans/mcp-per-invocation-config.md`, whose status blockquote and archive row in
`docs/plans/README.md` both record SHELVED alongside BLOCKED and carry the reopening condition
below; the mechanism refutation is PR #166 and the shelve note the commit after it. The race is
real and documented; what does not exist is a way to fix it that is worth its cost.

**Reopening condition, checkable:** codex or grok ships (a) a config-FILE pointer per invocation — a
`--config-file <path>` or `--mcp-config <path>` equivalent to what the claude family already has —
or (b) any flag that scopes MCP servers for one run, or (c) REPLACE semantics for `mcp_servers` on
`-c` / `-p`. Until one of those appears, relocating the config home is the only mechanism and it
discards cross-invocation state. Re-read the verdicts below before assuming a new CLI version
changed anything, then test only the one thing that would have changed.

**How to apply — PROBED EXHAUSTIVELY 2026-09-18 against the live binaries in their own sandbox
images. EVERY CHEAP LEVER IS CLOSED. Only home relocation works, and it is destructive.** Measured
verdicts, so nobody re-runs these:

- `-c mcp_servers={}` — **MERGES, cannot narrow.** A `config.toml` holding `[mcp_servers.fromfile]`
  still reports `MCP servers 1` under the empty override. An earlier version of this note called
  this lever the answer after testing it against an EMPTY home, where an override can only ever
  demonstrate ADDITION. That was the wrong experiment.
- `-c mcp_servers={other={...}}` — **MERGES.** File's one server plus the override's one gives
  `MCP servers 2`.
- `-p/--profile <name>` — **MERGES.** `codex mcp list -p narrow` lists both the base file's server
  and the profile's. (Note `--profile` is rejected by `codex doctor`; it only applies to runtime
  commands and `codex mcp`, so test it through one of those.)
- `--tools` / `--disallowed-tools` — **grok only, and "Built-in tools" only** per its own help, so
  they cannot reach MCP servers. codex has neither flag.
- codex feature flags — 140 of them, **none gates MCP loading** (`enable_mcp_apps`,
  `mcp_2026_07_28`, `non_prefixed_mcp_tool_names` etc. are unrelated).
- grok — **no config override of any kind.** Its `-c` is `--continue`. Full flag list enumerated.

So the ONLY route is a **config-home environment variable** (`CODEX_HOME`, `GROK_HOME` — both
confirmed to relocate discovery). It is NOT free, and an earlier version of this note wrongly said
it was: the home it redirects holds the CREDENTIALS too
(`codex doctor` reports config.toml, sqlite home and every state DB under `CODEX_HOME`, and
`catalog.ts` lists `authConfigPaths: ['~/.codex']`), so a per-invocation home has to be SEEDED with
auth before the CLI can work — which is the auth-volume copy this note originally proposed, just
scoped smaller. Two costs to design around: `task-auth-volume.ts` performs that copy by running a
HELPER CONTAINER (`cp -a /src/. /dst/`) wrapped in fingerprint-before-copy logic that exists to
avoid recording a stale credential hash, so a third per-invocation layer means one helper container
per invocation inside the machinery whose whole subject is credential lifetime; and a per-invocation
home would ride `InvokeOpts.extraEnv` (which `mergedEnv` spreads last), so the callers would have to
be widened to set it. (The adapters' `envInjection()` hook this note used to cite was never called
and was removed on 2026-09-19.) The env vars themselves are confirmed:

- **codex → `CODEX_HOME`.** MEASURED: `codex doctor` with `CODEX_HOME=/tmp` reports `sqlite home
/tmp (dir)`, `config.toml /tmp/config.toml`, `✓ config loaded` and — decisively —
  `configuration scope: invocation config`. Pointed at a path that does not exist it fails loudly
  (`CODEX_HOME points to "…", but that path does not exist`), so the dir must be created first.
- **grok → `GROK_HOME`**, and NOT `XDG_CONFIG_HOME`. MEASURED by isolating them against
  `grok inspect`: default prints `Config Sources └ User: /root/.grok/config.toml`; with
  `GROK_HOME=/tmp` it prints `User: (none)`; with `XDG_CONFIG_HOME=/tmp` it is unchanged.
- **antigravity → no home override found.** Neither `AGY_HOME` nor `GEMINI_HOME` moved it;
  `agy mcp list` still returned the server from the default location under both.
- **gemini → UNMEASURABLE on this install.** No gemini sandbox image exists and no gemini row is in
  `cli_providers`, so any fix for it would ship unverified. Scope accordingly and say so.

So the race can be closed PER PROVIDER for codex and grok, rather than all-or-nothing.

**A SEPARATE, WORSE DEFECT found while probing: Haive writes antigravity's MCP config to a path
antigravity never reads.** `mcp-config.ts` (the `antigravity` case of `buildMcpConfigForCli`) writes
`~/.gemini/antigravity-cli/mcp_config.json`. MEASURED: `agy mcp add probe /bin/true` creates
`/root/.gemini/config/mcp_config.json` (`docker diff`), `agy mcp list` reads that straight back, and
a `find` of `~/.gemini` after a real add shows NO `antigravity-cli/` directory at all. The decisive
test — a server placed ONLY at Haive's path — answers `No MCP servers configured.` So every
antigravity run has been getting no MCP servers whatever, which is total rather than a concurrency
window. That settles the "confirm the actual read path during MCP testing" NOTE in that file.
**The fix is the PATH ONLY — the shape is fine, MEASURED.** agy writes `{command, disabled}` while
`serversToJsonObject` emits `{command, args, env?, timeout?}` and never `disabled`, which looked like
a second defect; but a well-formed Haive-shaped file placed at agy's real read path lists as
`haiveshape  stdio  enabled  /bin/true`, so agy accepts `args` and treats a missing `disabled` as
enabled. So it is a one-line path change in `buildMcpConfigForCli`'s antigravity case, plus a test.

The narrower mitigation this note used to suggest measuring first is still unmeasured and still
worth it independently: mount the repo READ-ONLY for a `step_summary` invocation — the recap reads
nothing, and that removes the "could modify the worktree" half regardless of which servers survive.

Related: [[haive-task-auth-volume-no-refresh]] is the other defect in the same volume.
