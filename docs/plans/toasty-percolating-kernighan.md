# Per-call agent isolation (PR 1)

> **LANDED 2026-09-21, in six PRs** — #191 `7deb542d`, #192 `bde5722e`, #193 `fe3148a5`, #194
> `16f8be37`, #195 `a66a79de`, #196 `0bb6fe45`. **Verification item 2 COMPLETED 2026-09-22** in #200
> (two assertions) and #202 `842012ff` (the third, the built-in prompt-builder scan). What is left is
> items 1 and 4, both of which need a live run.
>
> Item 2's own work found a PRODUCTION defect the plan had not predicted, fixed in #211 `689f842a`:
> `adaptPrompt` splices the MCP surface and the global-KB digest in AFTER `agentIsolationApplies`
> returns, and both carry text Haive did not write — a repository's own `mcpServers` keys and
> author-written KB titles — so either could put an agent path into the final prompt of an invocation
> already chosen for isolation. The rule now has a SEVENTH condition scanning those resolved values.
> That is the argument for writing the assertion rather than reasoning about it: the scan was specified
> to catch a new prompt builder, and what it actually caught was the dispatcher. Planned 2026-09-14 against `main` at `3c0a93f6` and reviewed against
> the code the same day. Built-in steps only; custom task types reach the same rule through
> `rippling-wibbling-puffin` Phase 3.1, whose companion edits are listed below and are ALREADY
> FOLDED INTO that plan — its prompt-template entry shape carries `agentPool?`, its `{{agent:<id>}}`
> section is written, and its dangling-reference rule already covers personas — so nothing is owed
> there.
>
> **RE-VERIFIED 2026-09-18 against `main` at `47d5fd2a` — three days before piece 1, so this
> records the state on that date and not today's.** Not started then: no
> `agent-definition-mask.ts`, no `agentIsolationApplies`, no `promptNamesAgentPath`, no
> `agentPool`, no `maskAgentDefinitions`/`pastedPersonaPaths`, and no
> `CONFIG_KEYS.AGENT_ISOLATION_ENABLED`. Every other file and symbol this plan names still exists,
> `dispatcher.ts` is untouched by the containment series, and Rollback still holds. Two bodies of
> work landed in between and both SHRINK what is left to build:
>
> - **The symlink-containment series (#115-#160)** put `@haive/shared/fs-safe` in the tree, and
>   `_agent-loader.ts` already reads through it. At `3c0a93f6` that file opened with
>   `readdir`/`readFile`/`pathExists`; today it is `readdirNoFollow`/`readRegularFileNoFollow`. So
>   the hand-rolled no-follow reader Decision 1 specified is one primitive call, and the link, FIFO
>   and pseudo-file cases Verification listed are already pinned in
>   `packages/shared/test/fs-safe.test.ts`.
> - **#161 (tool usage)** BUILT `agentGuidanceIds` (exported from `_retrieval-guidance.ts`),
>   `assignedPersonaIds` (`dispatcher.ts:462`, called in `buildCliSidePlan` before the rewrite) and
>   an `assignedAgentIds` field on `DispatchRequest`, `CliCommandSpec` and `SubAgentInvocation`,
>   plus `AgentMiningDispatch.personaIds`. This plan's spec fields now join an established pattern
>   instead of introducing one, and its pre-rewrite marker read already has a call site.
>
> **BUILT AND MERGED 2026-09-21, all six pieces**: #191 `7deb542d` (the retry_ai `toolProfile`
> drift, which this plan only found while auditing the dispatch path), #192 `bde5722e`
> (foundations, inert by design), #193 `fe3148a5` (the dispatch rule), #194 `16f8be37` (the exec
> mask), #195 `a66a79de` (the switch surface and docs) and #196 `0bb6fe45` (the exec-time persona
> recheck piece 4 shipped WITHOUT — see that Commit sequence entry). Piece 2's revision moved
> `resolveInvocationWorkerTree` into piece 3 and added a `picomatch` dependency that Decision 1
> explains, and three Critical-files claims were wrong and are corrected in place:
> `invocationRepoSubpath` and `resolveInvocationWorkerTree` did not exist, and
> `resolveInvocationWorkerRoot` has two callers rather than three.
>
> **RE-VERIFIED AGAIN 2026-09-21 against `main` at `9ea6f06e`, 176 commits after the last pass —
> that pass PRECEDED piece 1, so its "not started" is history and not the current state.** It
> found all six absences holding, and `agentPool` absent as a spec field (the twelve
> matches under `packages/` are `agentPoolMeasuredEnabled`/`agentPoolSafetyMb`, the unrelated RAM
> budget). Every claim was re-checked and the corrections are folded into the sections they belong
> to rather than listed here. Four change WORK rather than a line number:
>
> - `WORKER_REPO_STORAGE_ROOT` is now read by FIVE source files and TWO tests, so dispatch item 4's
>   move has seven importers to keep compiling.
> - `AGENT_GUIDANCE_PATTERN` is PRIVATE, so Decision 3's label pattern is the first exported one in
>   that module rather than a second.
> - Decision 1's four-term gate is three terms in the rewrite: `buildCliSidePlan` folds
>   `lspConfigured` into `supportsLsp` before calling it.
> - **Decision 7's drift is STILL LIVE**, so its one-line commit is still owed.
>
> Three anchors moved by one line and two files moved directory; `01b-install-plugins.ts` was never
> missing, it is under `steps/workflow/`. **Landing order is now stated** under "Commit sequence":
> this is one plan and five changes, because it is not one reviewable diff.

## Context

Every CLI invocation today loads the WHOLE list of the repository's agent definitions, while
every Haive step that uses a persona needs exactly one per invocation (or none). MEASURED
2026-09-14 with a zero-token capture (each CLI's own sandbox image, a real repo mounted
read-only, the API pointed at a local recorder):

| CLI (version) | What rides every request | Size on the test repo |
|---|---|---|
| claude-code / zai / ollama / muse / openrouter (2.1.270) | one `- name: description (Tools: …)` line per `.claude/agents` file, plus the Agent tool | 45 agents = 8,488 chars (6.5%) |
| codex (0.154.0) | name + description per `.codex/agents` role inside `spawn_agent`'s `agent_type` param | 33 roles = 7,728 chars (9%) |
| grok (1.0.31) | name + description inside `spawn_subagent`, read from `.grok/agents`, `.claude/agents` AND `.agents/agents` | 39 agents = 6,723 chars (11%) |

Definition BODIES never reach a request on any of the three. What Haive actually uses:

- Personas are pasted by Haive, one per call: 13 `agentDefinitionGuidance` calls across 10
  workflow step files (01e, 03b, 03b2, 04, 05, 08a, 08b ×2, 08c ×3, 08d, 11), plus the mining
  rosters of 03-phase-0a-discovery, 08c-code-review and 08d-adversarial-qa. None depends on the
  CLI's own listing.
- The pointer those sites emit ("if `.claude/agents/<id>.md` exists, follow it") is mostly
  ignored: 05 assigned `spec-quality-reviewer` in 27 prompts and the file was opened 0 times;
  08b assigned `test-writer` 51 times, opened once. Codex never receives the pointer at all
  (the dispatch rewrite replaces it for providers without LSP). So user edits to agent files
  rarely take effect.
- Native spawning from the listing: 2 claude `Agent` calls across 2,477 runs, and no step builds
  a sub-agent dispatch.
- No step needs a sandboxed CLI to read agent files as data, apart from the secret sweep (see
  "Steps that read agent files"), and the onboarding mining steps actively want them unread:
  `withAgentToolingDirs` (`steps/onboarding/_scope.ts`) fences every agent tooling directory out
  of their scope, by prompt text alone.

Measured levers:

- A tmpfs over `.claude/agents` drops claude's listing to the 5 built-ins, with CLAUDE.md, tools
  and the system prompt byte-for-byte the same size. Masking `.codex/agents` removes codex's
  7,728 chars; masking grok's three directories removes its 6,723.
- A tmpfs plus one definition bind-mounted inside it lists the built-ins plus exactly that agent,
  on all three CLIs (not used in PR 1 — see Out of scope).
- claude `--agent X` REPLACES the default system prompt (9,462 → 328 chars), so it is not usable;
  `--append-system-prompt` keeps it; `--agents <json>` adds and never replaces.

Intended outcome: an invocation that only reads the repository sees no repository agent
definitions unless its step says it must, the persona a step assigns reaches the model
deterministically, and an invocation that writes the tree keeps seeing the tree it writes. The
rule keys on facts every dispatch already declares, so a future step — module or custom task
type — inherits it without anyone maintaining a list of special steps.

## Decisions already fixed by the code

1. **Persona bodies are pasted only where today's pointer survives.** `adaptPromptForCliCapabilities`
   (`steps/_retrieval-guidance.ts`, whose only caller is `buildCliSidePlan`) keeps the pointer
   only for a provider with `supportsLsp && lspConfigured && projectAgentsDir && agentFileFormat`
   (**VERIFIED 2026-09-21: the rewrite itself tests three of those.** `buildCliSidePlan` folds the
   fourth in when it builds the capabilities — `dispatcher.ts:331`, `supportsLsp:
   adapter.supportsLsp && req.lspConfigured === true` — so `adaptPromptForCliCapabilities` never
   sees `lspConfigured` as a term of its own. The effective gate is the four, at the caller.)
   — today claude-code, zai, ollama, muse, openrouter and grok with a ready LSP bridge
   (`hasReadyLspBridge` is task-level, so grok's gate is claude's) — and replaces the whole marker
   with "Follow the embedded protocol below." everywhere else, on purpose: older agent files can
   carry LSP instructions a provider without the bridge cannot follow. PR 1 keeps that gate
   exactly. Inside it, the body replaces the whole marker block (Decision 3), read from that provider's OWN
   `projectAgentsDir` (`.claude/agents` for the claude family, `.grok/agents` for grok) — the file
   the pointer names today. Outside it (codex, amp, gemini, antigravity, or a capable provider
   whose bridge is not ready) nothing about the prompt changes. The body is read by FILENAME,
   `<projectAgentsDir>/<id>.md` — the exact file today's pointer names — and never looked up by the
   frontmatter `name` that `loadAgentPersonas` keys on (`steps/workflow/_agent-loader.ts:31-33`).
   The two can differ, and a lookup by `name` would silently drop the customisation that outranks
   the inline persona. **AS BUILT — this is no longer this plan's code to write.** The reader never
   follows a repository-controlled link: the worker is privileged, and an untrusted repository
   can plant `.claude/agents/peer-reviewer.md` as a symlink to `/proc/self/environ` or a host
   secret, whose bytes would be pasted into a prompt sent to the provider. When this was planned the
   reader had to close that by hand — an `O_NOFOLLOW | O_NONBLOCK` open, an exact-path check on the
   opened descriptor's `/proc/self/fd` path, an `fstat` regular-file check, and a capped read so a
   size that lies (a pseudo-file reports 0) could not slip past the budget. The symlink-containment
   series (#115-#160) has since put every one of those into `@haive/shared/fs-safe`, and
   `_agent-loader.ts` ALREADY reads through it (`readdirNoFollow`, `readRegularFileNoFollow`,
   against `readdir`/`readFile`/`pathExists` at `3c0a93f6`). So the single-file reader is
   `readTextNoFollow(<invocation tree>, '<projectAgentsDir>/<id>.md', { maxBytes })` — re-exported
   as `readRegularFileNoFollow` from `steps/onboarding/_helpers.ts` — whose contract is that the
   ANCHOR may be followed while no component of the rel ever is, that a refused or absent file
   answers `null`, and that a FIFO or device is never opened. Those properties are the primitive's
   documented guarantee and are pinned in `packages/shared/test/fs-safe.test.ts`, so this plan
   neither restates nor re-proves them. What remains its own is the SHAPE and the POLICY: reading
   one file by filename rather than the directory, and treating a refused file as missing — as is
   one `parseAgentFile` cannot parse (an unclosed frontmatter) or whose body is empty after the
   frontmatter, since pasting an empty persona is the same silent failure as a missing one. Before any read, the reader also applies the
   invocation's effective secret-mask policy to that path — the kill switch, `secret_mask_enabled`,
   the deny globs plus `secret_mask_deny_extend`, minus the carve-outs and `secret_mask_allow`,
   untracked files only (`queues/cli-exec/secret-mask.ts`) — and a file the sandbox would mask counts
   as missing: pasting it would hand the provider the very bytes the mask keeps from the agent. When
   that policy cannot be evaluated nothing is pasted, matching masking's fail-closed rule. The policy
   is extracted into a predicate the reader can call — free of DB, config and `resolvers.js` imports,
   for the same import-cycle reason `invocationRepoSubpath` moves (dispatch side, item 4).
   **What that predicate MATCHES WITH was an open gap until piece 2, and it is not free.** The policy
   is glob arrays (`computeEffectiveSecretGlobs` returns `{deny, ignore}`) and `computeSecretMasks`
   evaluates them with tinyglobby's directory SCANNER, which cannot judge one path and which this
   reader must not run. Node's own `path.matchesGlob` was MEASURED against that scanner over a
   26-path fixture and agreed on only 21: `**` will not descend into a dotted directory and `*` will
   not match a dotted basename without `dot: true`, so `**/.env` missed `.config/.env` and `**/*.pem`
   missed `.hidden.pem` — three of the five differences in the UNSAFE direction, a real secret the
   scanner hides that the predicate would have called clean and pasted into a prompt. So piece 2
   declares `picomatch` (4.0.4, pinned to the version tinyglobby itself resolves, with an ambient
   `.d.ts` because it ships no types and `@types/picomatch` is not in the lockfile) and the predicate
   uses `picomatch(globs, { dot: true })` — the same engine and option the scanner uses internally.
   `secret-mask-policy.test.ts` pins the two against each other over that fixture tree, because one
   policy evaluated by two engines is the failure this arrangement exists to avoid. The untracked
   half cannot be pure: `filterUntracked` asks `git ls-files`, so the predicate takes the tracked
   SET (or `null`, meaning git could not answer — mask more, never less) from its caller.
   The policy is checked again at exec,
   because a deny rule or the masking switch can change while the job waits in the queue:
   `buildCliSidePlan` records the repository-relative paths of the bodies it pasted on the spec
   (`CliCommandSpec.pastedPersonaPaths`), and `executeByKind`, which already resolves the secret masks
   before its per-kind switch, fails the invocation before the CLI starts when that same predicate,
   evaluated then, denies any recorded path. It asks the policy, never the mask set: the scan mounts
   only over files that still exist, so a denied file deleted after dispatch produces no mount while
   its bytes are already in the prompt, and an absent mask is not evidence of an allowed path — the
   same reason masking never reads an empty scan as a clean repository. The predicate's tracked test
   needs no file on disk, so a deleted untracked path is judged by the deny and allow globs like any
   other, and a predicate that cannot be evaluated fails closed. That is the `SecretMaskError` path a
   failed scan already takes, so the step fails loudly and a retry rebuilds the prompt under the
   current policy. No directory is scanned, and no unrelated or
   out-of-tree file is ever read. It reuses the loader's frontmatter parser (`parseAgentFile`,
   exported) and leaves `loadAgentPersonas` and its only caller, 03, untouched. Codex inlining
   (its `.codex/agents/*.toml` is rendered without LSP, and no package has a TOML parser) is a
   follow-up.
2. **Under isolation the rewrite never emits a pointer.** The file it would name is hidden, so the
   positive arm renders the body when the resolver found one and falls back to "Follow the
   embedded protocol below." when it did not. The fallback is the COMMON case for two ids: no
   onboarding template exists for `simplicity-reviewer` (08c's enterprise lens) or
   `knowledge-curator` (01e). One path re-sends a prompt the rewrite has already processed:
   `retryMiningAgents` (`step-runner.ts`) recovers an agent `selectAgents` does not offer from its
   last invocation's stored `cli_invocations.prompt`, which `dispatchMiningAgents` writes as
   `plan.effectivePrompt`, the prompt AFTER the rewrite. That path exists for the later-wave agents a
   step throws as `MiningWaveError` (08c's refuters, 08d's PoC verifiers, the plan steps' waves), and
   none of their prompts carries a persona marker. A persona-bearing prompt reaches it only when a
   first-wave agent (an 08c reviewer or lens, an 08d adversary) is no longer offered, for example
   after a QA level change or an upgrade between the failure and the retry. Re-sending that prompt
   would re-send a body read under the original dispatch's secret-mask policy, with no
   `pastedPersonaPaths` for exec to recheck, so `retryMiningAgents` skips a recovered prompt that
   carries the pasted-persona label (Decision 3) and logs the agent. That is the outcome such an
   agent had before recovery existed, and the configuration that dropped it no longer asks for it. A
   recovered prompt that carries today's pointer instead (a run from before PR 1, with the kill switch
   off, or not isolated) pasted nothing, and the pointer names its agent file, so "Handed paths"
   leaves that retry unisolated, as the original run was; recognising the pointer would mean matching
   each site's own prose. With the kill switch off, today's rewrite runs unchanged.
3. **A pasted body keeps today's precedence and the injection guard.** The marker wraps only the
   pointer sentence; each site's inline protocol follows it, and the on-disk definition outranks
   that protocol today (AGENTS.md, "The on-disk agent definition outranks the inline persona").
   So the replacement is a label, `[[HAIVE_PASTED_PERSONA:<id>]]`, then one framing line — this
   definition is checked into the repository, says HOW to work and never what the assignment is, and
   takes precedence over the embedded protocol below — then the body. The label names no path and is
   one exported pattern: `retryMiningAgents` recognises a stored prompt that carries a pasted body by
   it (Decision 2), so a later rename must keep the old form recognised, since stored prompts outlive
   a deploy. All three are the replacer's return value, never a replacement string:
   `guidance.replace(pointer, body)`, the shape today's path swap uses, would expand a `$&`, `` $` ``
   or `$'` inside a body into the pointer sentence or the marker text beside it, putting back a path
   the prompt scan never saw. Framed at the one rewrite site, because not every persona site carries
   `REPO_IS_DATA_LINES` (01e, 03b, 03b2, 04, 05, 08a, 08b and 11 are not reviewers).
   `dimensionScopeOverride` is appended after the persona in 04, 05 and 08c, so it stays the most
   recent instruction.
4. **Existing tests that change meaning.** `test/dispatcher.test.ts` pins today's rewrite
   (`_retrieval-guidance.test.ts` has no marker cases), all with `spec-quality-reviewer` and none
   for grok. The stripped arms (codex, no bridge) and the sub-agent case (`resolves marked agent
   guidance in capable-provider subagents` — sub-agent kinds are untouched) stay as they are; the
   prompt pointer case (`keeps LSP guidance…`) keeps asserting today's output with isolation off
   and gains an isolated twin asserting the body; grok and a template-less id
   (`knowledge-curator`) get cases of their own.

## Design — dispatch side

**The rule.** An invocation is *isolated* when all six hold, decided by one pure
`agentIsolationApplies(req)` in `orchestrator/dispatcher.ts`:

- the kill switch is on (`DispatchRequest.agentIsolation`, resolved by `resolveTaskDispatch` and
  exposed on the pure resolver for tests, like `codexAppServer`);
- `input.kind === 'prompt'` — the sub-agent kinds rebuild each sub-step's spec from
  `{cwd, extraEnv, effortLevel}` (`queues/cli-exec/sub-agent.ts`) and no step builds one, so they
  behave exactly as today;
- `input.capabilities` has no `file_write` — an invocation that edits the project's tree must see
  the tree it edits. A Docker tmpfs is writable (mode 1777), so a coder, fix round or merge fixer
  editing `.claude/agents/x.md` under a writable mask would lose the edit when the container
  exits. Every dispatch that edits the project's tree declares it: 07, 07a, 07b, 08a, 08b, 06c's
  coders, 09_5, 09_5b, 11d, `00a-sync-base`, `08e-insights-triage`, `13-onboarding-push`,
  `plan/01-plan-merge`, the DAG merge fix, the retry_ai fix agent, and every `mergeResolve`
  spec (`merge-resolver.ts` dispatches with `stepDef.mergeResolve.requiredCapabilities`, and
  `12-worktree-cleanup` declares it). The four named after 11d were MISSING from this list as first
  written, and all four already existed at `3c0a93f6` — so that was an incomplete enumeration
  rather than later drift. No behaviour was wrong, because the rule keys on the capability and never
  on this list; but the list is what the safety argument in the next sentence rests on, which is why
  it is corrected here. These write WITHOUT declaring it, each only into a
  Haive-owned path, found by auditing every prompt that tells an agent to edit or write files:
  `01e-external-kb-sync` and `11-phase-8-learning` edit `KB_DIR` in place, `09_3-qa-review` writes
  the knowledge-base files its corrected answers cite (under `KB_DIR`), and
  `08-knowledge-acquisition` and `09_2-qa-resolve` stage bodies under `.haive/kb-draft/`
  (`_kb-body-file.ts`). None of them writes an agent directory. The safety does not rest on that
  list being complete: the mask is read-only (exec side, item 3), so any write that reaches a masked
  directory fails loudly instead of vanishing with the container. `resolveDispatch` reads only
  `subagents` and `vision` from that list, so keying on it changes no provider selection;
- `input.capabilities` has no `subagents` — a dispatch that may spawn native sub-agents keeps the
  catalog it spawns from. That capability already restricts dispatch to adapters with
  `supportsSubagents` (`resolveDispatch`: the claude family, grok and antigravity), each of which
  reads a markdown agent directory, and no built-in step declares it, so this changes nothing for
  PR 1's steps;
- neither the prompt nor the selected provider's project instructions name an agent directory or a
  file inside one (see "Handed paths" and "Project instructions" below);
- the step did not declare `agentPool: '*'`.

In practice that isolates the 08c reviewers and lenses, the 08d adversaries, 08c2, 03's mining
roster, 04, 05, 01e, 01f, 03b, 03b2, 11, 11f, the DAG per-issue reviewer, issue advisor and
replanner, and onboarding's read-only mining (08, 09-qa) — each only while neither its prompt nor
the repository's instructions name an agent directory or a file inside one — while 08a, 08b and the
DAG coders declare `file_write` and are not isolated.

**Handed paths.** A prompt that names an agent directory, or a file inside one, must be able to open
it. The path can come from a review change set that includes an edited agent definition, an outside
commit that touched one, a template value, a persona body that points at another definition or at
the whole directory, or a user who types one into a task description, a form hint or a plan-chat
message ("review everything in `.claude/agents/`"). Where such a path can enter a
prompt is open-ended, so the check is made once, over the prompt itself, rather than where lists
are rendered. `agentIsolationApplies` runs a pure `promptNamesAgentPath(text, workdir)` (beside the
agent-directory union), which removes nothing itself, over two inputs. The first is the dispatch
prompt with Haive's persona-marker blocks removed by the caller, since their pointers name
`.claude/agents/<id>.md` by construction; the span removed is exactly the span the rewrite replaces
(Decision 3), so text inside a marker-shaped block of the prompt, even one a user forged, never
reaches the model and cannot name a file for it to open. The second is every persona body the
re-resolve carries, scanned VERBATIM, marker-shaped blocks included: the rewrite inserts a body as
its replacer's return value after `AGENT_GUIDANCE_PATTERN` has matched, and
`String.prototype.replace` never rescans what a replacer returns, so a marker block inside a body
reaches the model as written, pointer path and all. The helper splits the text into path tokens, strips a leading `./` and the sandbox
workdir prefix (`SANDBOX_WORKDIR`, `/haive/workdir/`, passed in by worker-side callers because shared
cannot import it), and matches a token that IS an agent directory or lies inside one, anchored on
whole segments from the root the way `isDeniedPath` is: `.claude/agents/`, `.claude/agents` and
`.claude/agents/x.md` all count, while `.claude` and `docs/.claude/agents/x.md` do not. A match counts
as `agentPool: '*'` for that invocation. Directory mentions count because an empty masked directory
is the same silent failure as a hidden file, and they cost almost nothing: searched across all of
`packages/worker/src`, only two built-in prompts name an agent directory outside persona markers,
06_5's prior-setup warning and 09_5's note on where agents live. 09_5 declares `file_write` and is
not isolated anyway, and 06_5 keeps today's view (Steps that read agent files). No prompt
interpolates `projectAgentsDir`; its other uses are host-side git paths and write targets.
A mining retry that re-sends a stored prompt (Decision 2) scans it again: a stored pointer keeps that
retry unisolated, and a stored prompt carrying a pasted body is not re-sent at all. Nothing has to
ride in the prompt, and a future step inherits the rule with nothing to wire.

**Project instructions.** The prompt is not all a CLI reads: it loads the repository's own instruction
file itself, after it starts, and that file can send the agent to a definition the mask would hide.
MEASURED on the dev install on 2026-09-15 across every repository's root instruction files (27
`CLAUDE.md`, 26 `AGENTS.md`, 10 `GEMINI.md`): none `@`-imports an agent path, and Haive's own chain
names none (`CLAUDE.md` and `GEMINI.md` are a lone `@AGENTS.md`, and the project-info, cli-rules and
RTK regions onboarding writes into `AGENTS.md` name no agent directory), but one repository's
`AGENTS.md` carries a legacy workflow's standing instruction, "FIRST: Read your full agent definition
from .claude/agents/{agent-name}.md". So the decision also scans the selected provider's instructions
with the same `promptNamesAgentPath` rule. The entry point is the adapter's own `rulesFile`, which
onboarding already writes by (`CLAUDE.md` for the claude family, `GEMINI.md` for gemini, `AGENTS.md`
for codex, amp, antigravity and grok). For an `import`-mode `rulesFileMode` the scan also follows every
`@` reference that resolves to a file inside the tree, relative to the file that makes it, so the
`CLAUDE.md` → `@AGENTS.md` chain is covered; `native` readers do not expand `@` references, so theirs
are not followed. A match counts as `agentPool: '*'`, like a handed path. The files are only scanned,
never pasted, so a scan returns a verdict and no bytes: each file is opened non-blocking, must resolve
to a regular file inside the invocation's tree, and is read up to a cap, and a link is followed only
when its target stays inside that tree. An absent file names nothing. A file that cannot be read that
way, or a chain past five levels of imports or 1 MiB in total, leaves the invocation unisolated —
today's behaviour, and the direction a context control fails in, so a truncated scan can never hide a
referenced file. Not covered: instruction files a CLI loads beyond that entry point — nested
per-directory files it reads once it works in that directory, CLI-specific extras such as
`CLAUDE.local.md`, and the user-level files it reads from its home (`~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`), which live in the per-task auth volumes (Out of scope).

1. **The declaration.** `LlmInvocationSpec.agentPool?: '*'` (`step-engine/step-definition.ts`,
   beside `toolProfile`). `'*'` is the only value PR 1 needs (see "Steps that read agent files");
   pools naming specific agents are out of scope. It is passed as `DispatchRequest.agentPool` by
   the one site that dispatches a step's own llm spec, `resolveLlmPhase` in `step-runner.ts`
   (which also serves loop passes and fix rounds). The retry_ai fix agent always declares
   `file_write`, so it needs none.
2. **Marker ids.** A pure `agentGuidanceIds(prompt)`, exported beside `AGENT_GUIDANCE_PATTERN`,
   reads them before the rewrite.
3. **Bodies are read after the provider is chosen.** `resolveTaskDispatch` already builds a plan,
   does async work for the SELECTED provider (the codex app-server probe) and re-resolves.
   Persona bodies take the same shape: once `plan` exists, if `agentIsolationApplies(resolved)`,
   `plan.adapter` passes the gate (`supportsLsp`, `lspConfigured`, a catalog `projectAgentsDir`
   with `agentFileFormat: 'markdown'`) and the prompt has marker ids, read `<id>.md` for each
   marker id from that ONE directory in the invocation's tree (by filename, per Decision 1). The
   project-instruction verdict ("Project instructions" above), the persona bodies and the codex
   app-server verdict are all gathered BEFORE re-resolving, the instruction scan first because a match
   ends isolation and leaves no built-in body to read, and `resolveDispatch` runs a second time only
   when one of them is new, carrying them together (`{ ...resolved, instructionsNameAgentPath,
   agentBodies, codexAppServer }`). Early returns would each skip the others the moment Phase 3.1
   resolves template personas on codex, losing the persona, the verdict or the first steerable
   dispatch's probe. The provider cannot change on that second pass, because none of these inputs
   changes which provider `tryBuildPlan` accepts, and when nothing is found the first
   plan's fallback text is already right. That is PR 1's gate
   for built-in markers, whose inline protocol always follows them. Phase 3.1 widens it only for
   template markers, which have none, and tells the two apart by syntax: a template persona renders
   as a marker of its own (Companion, item 2), so the kind rides in the prompt on every dispatch
   path. Pasted bodies share
   one budget per prompt, `MAX_PERSONA_BODY_BYTES` (64 KiB in total, a guard rail above the largest
   definition measured, 24,694 bytes), counted in marker order from each opened file's `fstat`
   size, with the read itself capped at what is left plus one byte (Decision 1). A body that would
   exceed what is left, by its `fstat` size or by a capped read that returns more than that size
   claimed, is never pasted and never truncated, since a cut persona reads as a complete one: a built-in marker falls back to its
   inline protocol and records an `agent_persona.oversized` task event naming the file and its
   size, and a template marker fails the dispatch with that reason.
4. **The tree is the one cli-exec will mount.** `ctx.repoPath` is always the repository root,
   while cli-exec mounts the invocation's worktree. The subpath rule inside
   `resolveInvocationRepoMount` (`queues/cli-exec/resolvers.ts`: a local-path repo binds its root
   read-only; otherwise the `worktreeRel` override, else
   `.haive/worktrees/<worktreeDirName(worktreeBranch)>`, else the root) is extracted into a pure
   `invocationRepoSubpath(...)` that returns `undefined` for a local-path repo. It moves, with
   `resolveInvocationWorkerRoot` and `WORKER_REPO_STORAGE_ROOT`, into
   `repo/worktree-git-boundary.ts` and is re-exported from `resolvers.ts`, so the secret and
   `#ddev-generated` masks keep their imports. The dispatcher cannot import `resolvers.ts`
   directly: that file reaches the dispatcher back through `task-queue.ts` →
   `step-engine/index.ts` → `step-runner.ts`. `worktree-git-boundary.ts` already holds the
   predicate prompt and mount share (`invocationUsesWorktreeGitBoundary`) and imports nothing
   from cli-exec. A new async `resolveInvocationWorkerTree(db, taskId, worktreeRel)` beside it
   loads the task (`repositoryId`, `worktreeBranch`, `userId`) and repo (`storagePath`,
   `localPath`), and runs only on the project-instruction and persona paths above.
5. **The rewrite** (`adaptPromptForCliCapabilities`) gains optional `isolated` and `agentBodies`
   inputs and changes only its positive arm, as fixed in Decisions 1–3.
6. **One decision, carried on the command spec.** When `agentIsolationApplies`, `buildCliSidePlan`
   stamps `maskAgentDefinitions: true` onto the `CliCommandSpec` it returns. Separately, and whether
   or not the invocation is isolated, it records `pastedPersonaPaths` for every body the rewrite
   pasted, for the exec-time secret-mask recheck (Decision 1): PR 1 pastes only under isolation, but
   Phase 3.1 pastes template personas outside it (Companion, item 2), and exec rechecks whatever
   paths are recorded, whether or not it masks anything. All nine enqueue
   sites (four in `step-runner.ts`, four in `dag-executor.ts`, one in `merge-resolver.ts`) forward
   `spec: plan.invocation.spec` untouched and `executeCliSpec` spreads it, so no payload literal
   changes and the prompt and the mounts cannot disagree when the switch flips between dispatch
   and exec. The spec is never persisted, a BullMQ retry replays the same payload, and a job
   enqueued before deploy carries no flag and runs exactly as today.
7. **Pre-existing drift, fixed in its own commit first.** The retry_ai fix agent passes
   `toolProfile` to the dispatcher (`step-runner.ts`, `resolveAiFixPhase`) but omits it from its
   payload, so cli-exec wires the full MCP surface while the prompt describes the step's narrowed
   one. One line, own commit, own test in `test/step-runner-llm.test.ts`.
   **VERIFIED STILL LIVE 2026-09-21:** `resolveAiFixPhase` (`step-runner.ts:903`) passes
   `toolProfile: stepDef.llm?.toolProfile` at `:982`, while its enqueue payload at `:1039-1050`
   carries `invocationId`, `taskId`, `taskStepId`, `userId`, `cliProviderId`, `effortLevel`, `kind`,
   `spec` and `timeoutMs` — and no `toolProfile`. Worth noting this fix is NOT agent isolation: it is
   a mismatch this plan happened to find, which is why it lands first and alone. Its agent always
   declares `file_write` (`capabilities: ['tool_use', 'file_write']` at `:980`), so it is never
   isolated either way.

## Design — exec side

1. **Which directories.** Every repo-level agent directory any supported CLI reads, not only the
   dispatched provider's: `projectAgentsDir` from `CLI_PROVIDER_CATALOG` (`.claude/agents`,
   `.codex/agents`, `.gemini/agents`, `.agents/agents`, `.grok/agents`). The union is required:
   grok reads `.claude/agents` and `.agents/agents` besides its own. One exported constant derived
   from the catalog, so a new provider joins it automatically. The `-legacy` quarantine siblings
   (`unmanagedAgentsDir`) stay visible.
2. **Only directories that exist.** A mount over a missing path makes Docker create the
   mountpoint inside the repo volume, root-owned, and that stub outlives the container
   (`sandbox/sandbox-runner.ts` records the same hazard for files). So the builder `lstat`s each
   candidate under the invocation's worker-side root (`resolveInvocationWorkerRoot`) and masks
   only a real directory whose realpath lies inside that root. A candidate that is, or sits under, a
   repository-controlled symlink is left unmasked (failing open, item 6), because a mount
   destination that traverses such a link is not a path to hand Docker. The builder reads no file
   content, so no race can leak bytes through it (the persona reader is the one place one could, and
   it checks the descriptor it opened, Decision 1), but a race can leave a stub. A directory deleted
   or renamed between the check and container start — a window holding `resolveAppReach`,
   `resolveMcpExtraFiles` with its pre-warm and `executeCliSpec`'s own setup — is a missing mount
   target again. On a volume repository Docker creates it, and any parent that went with it, empty and
   root-owned, where it outlives the container and refuses every uid-1000 writer. A local-path
   repository is mounted read-only (`resolveInvocationRepoMount`), so there the container fails to
   start instead (runc's `mkdir` of the missing destination returns `EROFS`) and the invocation fails
   loudly, leaving nothing behind. So the builder
   records the `dev`/`ino` of each masked directory and each ancestor below the root from the
   `lstat`s it already makes, and once the run returns, whether or not it succeeded, `executeByKind`
   removes, deepest first, every recorded path that is now an empty, root-owned directory with a
   different identity. `rmdir` cannot remove content; a directory the terminal or IDE recreated is
   owned by uid 1000 and stays, and one that anything filled is not empty and stays. A worker that
   dies mid-run leaves its stub behind, empty and invisible to git, and later builds mask it as the
   real directory it now is; uid-1000 writes into that one path fail until it is removed. The
   opposite race is accepted, not closed: a candidate absent at the check and created before the CLI
   reads it stays unmasked for that run, which is today's behaviour and item 6's fail-open result,
   with nothing left behind. Revalidating just before container creation only narrows that window,
   since every CLI reads its agent directories inside the container once it exists, and masking
   absent candidates is worse than the race: it would create directories for CLIs a repository does
   not use on every isolated run, and on a read-only local-path mount no such mountpoint can be
   created, so an isolated invocation on almost any local-path repository would fail to start.
3. **A read-only tmpfs mount.** `DockerVolumeMount` (`sandbox/docker-runner.ts`) has only volume
   and bind forms. It gains `tmpfs?: true`, rendered as
   `--mount type=tmpfs,destination=<target>[,readonly]` by a branch placed BEFORE the
   `subpath`/`-v` split, which would otherwise render a source-less entry as `-v :<target>`. The
   mask sets `readOnly`, so a write that reaches a masked directory from an invocation without
   `file_write` fails loudly instead of vanishing with the container.
4. **Mounted where the uploads mount already is.** In `executeByKind`'s `cli`/`agent_mining` branch
   (`queues/cli-exec/exec-core.ts`), beside `resolveTaskUploadsMount`, the masks are appended to
   `authMounts`. That array already carries a non-auth entry (the uploads mount),
   `assertNoAuthVolumeNesting` checks only `kind: 'auth'` entries, and the codex app-server
   fallback's recursive `executeCliSpec` call forwards it, so the `codex exec` re-run is masked
   too. No new parameter is threaded anywhere. The same branch wraps that `executeCliSpec` call in a
   `finally` running item 2's stub cleanup, which therefore also follows the fallback's re-run, and
   drops every secret and
   `#ddev-generated` file mask whose target lies under a masked agent directory: the read-only tmpfs
   already hides that subtree, and Docker could not create those files' mountpoints inside it, so
   keeping them would fail the whole invocation. Dropping a mount retracts nothing already sent,
   which is why the dispatch-side reader applies the same secret-mask policy before it reads a
   persona (Decision 1).
5. **A new module in the `#ddev-generated` mask's shape.** `queues/cli-exec/agent-definition-mask.ts`:
   `resolveAgentDefinitionMasks(db, taskId, repoMount, spec)` returns `[]` unless
   `spec.maskAgentDefinitions`, does the task/repo lookup, derives the worker root, and wraps
   everything in the fail-open try/catch of `resolveDdevGeneratedMasks`; the pure
   `computeAgentDefinitionMasks(workerRoot, containerWorkdir)` does the filesystem work, returning the
   mounts with the identities item 2 records, and `removeAgentMaskStubs(records, runtimeUid = 0)` is
   the cleanup. The fixture-tree tests call both, the second with the test's own uid, since an
   unprivileged test cannot create a root-owned directory. `steps/workflow/01b-install-plugins.ts`
   builds its own mask list for plugin installs, which load no agents — unchanged. (VERIFIED
   2026-09-21: it assembles `mounts` at `:205` from `resolveAuthMounts` plus the secret and gitfile
   masks, so it never reaches the `authMounts` seam item 4 appends to. It is under `steps/workflow/`,
   not `steps/onboarding/` where its `01b` prefix suggests.)
6. **Fails OPEN, unlike secret masking.** This is a context control, not a confidentiality one: a
   stat that throws logs a warning and masks nothing, a stub cleanup that throws logs and leaves the
   path, and the persona body was already pasted at
   dispatch, so the run is only as noisy as it is today. That is the `#ddev-generated` mask's rule,
   not `SecretMaskError`'s.
7. **Not covered.** User-level agent directories (`~/.claude/agents` and friends) live inside the
   per-task auth volumes, where a nested mount is exactly what `assertNoAuthVolumeNesting`
   refuses; none exist on the dev install. The sub-agent kinds are untouched (see the rule).

## Steps that read agent files

Every prompt naming an agent directory was checked (onboarding, onboarding-upgrade, workflow):

- **06_5-agent-discovery** — the worker pastes everything the step needs (the predefined list and
  imported bundle bodies). Its prompt warns about the one thing an agent directory gives it: a PRIOR
  setup's files, which MEASURED twice got an agent declined as "already owned" by a workflow this
  system never runs. That warning names `.claude/agents/`, so the path scan leaves 06_5 unisolated:
  it keeps today's view, with the warning still the mitigation it is today. Rewording a measured
  prompt to win back isolation for one step is not worth it in PR 1.
- **08-knowledge-acquisition, 09-qa, 09_5, 09_5b** — `loadMiningScopeExcludeGlobs` always adds
  `AGENT_TOOLING_DIRS` (the constant now lives in `_scope-seed.ts`, which `_scope.ts` imports;
  `withAgentToolingDirs` is still in `_scope.ts` at `:194`, added after a KB miner was handed 34 of
  Haive's own generated agent definitions as project source), and `scopeInstructionLines` enforces
  it by prompt text alone ("Do NOT open, read, grep, list, sample or crawl them"). 08 and 09-qa are
  isolated, so the agents half of that rule becomes enforced; 09_5 and 09_5b write skills
  (`file_write`) and keep today's view, which their prompts already fence ("AGENTS … NOT your
  concern here").
- **11-final-review, 07_5-verify-files, 07-generate-files, 12-post-onboarding, the onboarding-upgrade
  steps** — host-side reads and writes; no CLI reads the files. A retry_ai fix for a failed 07_5
  declares `file_write`, so it sees the directories it has to repair.
- **Any step whose prompt names an agent directory or a file inside one** — a change set (08c, 08c2, 08d,
  the DAG per-issue reviewer), external drift (01e, 01f), `changedPaths` (11f), `filesTouched` (11),
  a template value or user-typed text alike. That invocation sees the real tree (dispatch side,
  "Handed paths").
- **07_7-secret-sweep — declares `agentPool: '*'`.** It sweeps committed secrets across the whole
  tree and writes nothing, and agent definitions are committed files, so hiding them would
  silently shrink a security control's coverage. The cost is known and already handled: Haive's
  own 45 agent files are full of deliberate scope-narrowing text the sweeper once reported as fake
  credentials, which `REPO_IS_DATA_ONE_CLASS_LINES` (`steps/_untrusted-repo.ts`) now covers.

## Kill switch

- `CONFIG_KEYS.AGENT_ISOLATION_ENABLED` = `'config:sandbox:agentIsolationEnabled'`, default `'true'`
  in `DEFAULT_CONFIG` (`packages/shared/src/config/config.service.ts`), seeded by `setnx`, so it
  needs no migration. **AS BUILT in piece 2**, declared beside `SECRET_MASK_ENABLED` and with no
  reader yet, which is what makes that commit inert.
- Read ONCE, in `resolveTaskDispatch`, shaped like `resolveCodexAppServerVerdicts`: a failed read
  means off, which is today's behaviour. Exec never reads it — the decision rides
  `spec.maskAgentDefinitions`, which is also what keeps the 30 s per-process config cache from
  splitting one invocation's prompt and mounts across a flip.
- GET/PUT `/admin/config/agent-isolation` with `{ enabled: boolean }` in
  `packages/api/src/routes/admin.ts`, shaped like the steering pair (already behind
  `requireAdmin`), and a Card in the `execution` tab of `packages/web/src/app/(app)/admin/page.tsx`
  after the codex app-server card, whose copy it follows: a run already queued keeps its decision.
  `SECRET_MASK_ENABLED` is not the model — it has no API or UI exposure at all.
- Default ON: measured on three CLIs with the rest of the request unchanged, and off restores
  today's behaviour for every new invocation.

## Critical files

- **Dispatch:** `packages/worker/src/orchestrator/dispatcher.ts` (`agentIsolationApplies` with its
  prompt path scan, the switch read, the post-selection project-instruction scan and body read, the
  spec flag), `step-engine/steps/_retrieval-guidance.ts`
  (the positive arm and the exported pasted-persona label pattern — `agentGuidanceIds` is ALREADY
  BUILT and exported there by #161, which also added `assignedPersonaIds` at `dispatcher.ts:462`,
  called from `buildCliSidePlan` BEFORE the rewrite with the comment this plan's marker read needs;
  reuse both rather than adding a second pre-rewrite read),
  `step-engine/steps/workflow/_agent-loader.ts` (export
  `parseAgentFile`, still private at `:55`; a filename-keyed single-file reader, which is now one
  `readTextNoFollow` call plus the secret-mask policy check — see Decision 1, AS BUILT. The
  primitive is re-exported as `readRegularFileNoFollow` from `steps/onboarding/_helpers.ts:167`,
  which this loader already imports, and `loadAgentPersonas` — `export async function` at `:18` —
  keys personas on the frontmatter `name` at `:33`),
  `queues/cli-exec/secret-mask.ts` (its
  effective policy extracted as a dependency-free single-path predicate; it exports only
  `SecretMaskError`, `resolveSecretMasks`, `computeSecretMasks` and `listTrackedFiles` today, so the
  predicate is still to be carved out), `step-engine/step-definition.ts`
  (`LlmInvocationSpec.agentPool`, beside `AgentMiningDispatch.personaIds` that #161 added),
  `step-engine/step-runner.ts` (`resolveLlmPhase` passes `agentPool`; `retryMiningAgents` skips a
  recovered prompt carrying the pasted-persona label; the retry_ai `toolProfile` fix is its own
  commit).
- **Spec:** `cli-adapters/types.ts` (`CliCommandSpec.maskAgentDefinitions` and
  `CliCommandSpec.pastedPersonaPaths`). No `CliExecJobPayload`
  change, no enqueue literal change, nothing in `codex.ts`.
- **Tree resolution:** `repo/worktree-git-boundary.ts` (the moved `resolveInvocationWorkerRoot` /
  `WORKER_REPO_STORAGE_ROOT`, plus a NEW `invocationRepoSubpath`),
  `queues/cli-exec/resolvers.ts` (re-exports; `resolveInvocationRepoMount`
  — `export async function` at `resolvers.ts:502` — calls `invocationRepoSubpath`).
  **Neither `invocationRepoSubpath` nor `resolveInvocationWorkerTree` EXISTS yet — both are this
  plan's to write, and an earlier draft of this bullet listed them as though they already lived in
  that module.** MEASURED 2026-09-21: zero matches for either name anywhere in `packages/worker/src`.
  `invocationRepoSubpath` is the subpath rule currently INLINE in `resolveInvocationRepoMount`
  (`resolvers.ts:560-575`), extracted and moved in piece 2, where `resolveInvocationRepoMount` becomes
  its first caller — so it is never dead code. `resolveInvocationWorkerTree` belongs to PIECE 3, not
  piece 2: its only callers are the project-instruction and persona paths, so landing it in the
  foundations commit would add an unused async function to a commit whose contract is that nothing
  reads the switch yet.
  **The move is WIDER than planned, and wider again than the last pass recorded.**
  `resolveInvocationWorkerRoot` sits at `resolvers.ts:647` and has TWO callers
  that did not exist when this was written — `secret-mask.ts:99` and `ddev-generated-mask.ts:92`.
  **Not three:** `ripgrep-config.ts` only NAMES it, in a comment at `:13` saying its two branches
  mirror it, and neither imports nor calls it — an earlier pass counted that mention as a caller.
  MEASURED 2026-09-21, `WORKER_REPO_STORAGE_ROOT` is read in FIVE source files — `resolvers.ts`,
  `exec-core.ts`, `ripgrep-config.ts`, `repo-mirrors.ts` and `queues/task-queue.ts` — plus TWO
  tests, `ripgrep-config.test.ts` and `test/secret-mask-resolve.test.ts`. So the re-export has seven
  importers to keep compiling, not the five the earlier count implied, and `repo-mirrors.ts` and
  `task-queue.ts` are both new to that list. A re-export alone does NOT satisfy them: `export { X }
  from` creates no local binding, so `ensureRepoMountWritable` (two uses of
  `WORKER_REPO_STORAGE_ROOT` in the same file) needs the import as well — `resolvers.ts` already
  uses exactly that import-plus-re-export pair for `HOST_REPO_ROOT`, which is the shape to copy.
- **Exec:** `queues/cli-exec/agent-definition-mask.ts` (NEW), `queues/cli-exec/exec-core.ts`
  (append to `authMounts`; fail before the CLI starts when the policy predicate then denies a pasted
  persona path, whether or not the file still exists; remove a race's mount stubs in a `finally`
  once the run returns),
  `sandbox/docker-runner.ts` (tmpfs branch).
- **Steps:** `step-engine/steps/onboarding/07_7-secret-sweep.ts` (`agentPool: '*'`). No prompt
  renderer changes: the prompt path scan covers every step.
- **Shared:** beside `packages/shared/src/cli-providers/catalog.ts` (the agent-directory union and
  `promptNamesAgentPath`),
  `packages/shared/src/config/config.service.ts` (key and default).
- **API and web:** `packages/api/src/routes/admin.ts`, `packages/web/src/app/(app)/admin/page.tsx`.
- **Docs:** `AGENTS.md` → Sandbox, a paragraph beside "Secret-file masking" and "Worktree gitfile
  masking": what is hidden, from which invocations, why it fails open, why the persona reader never
  follows a repository-controlled link, and the measured listing costs.
- **Tests:** `test/dispatcher.test.ts` (isolated twins, grok, a template-less id, one re-resolve
  carrying the instruction verdict, persona bodies and a codex verdict, project instructions (a
  `CLAUDE.md` whose `@AGENTS.md` names `.claude/agents/` and a codex `AGENTS.md` naming one both
  leave the invocation unisolated, as does an unreadable or over-cap chain, while a lone
  `@AGENTS.md` naming nothing stays isolated), and
  `agentIsolationApplies` over `file_write` / `subagents` / a named agent directory or file / `'*'` / sub-agent kind /
  switch off),
  `test/step-runner-llm.test.ts` (`agentPool` reaches dispatch, the flag rides
  `enqueued[0].spec`, retry_ai `toolProfile`), `test/step-runner-mining-retry.test.ts` (a recovered
  prompt carrying the pasted-persona label is skipped, one without it is still re-dispatched), NEW
  `test/agent-definition-mask.test.ts` (fixture
  tree, including a secret file mask under a masked agent directory, a pasted persona path that
  is denied by exec time, including one whose file was deleted first, and stub cleanup: a masked directory swapped for an empty one after
  the build is removed, while one that was filled or kept its identity stays), a NEW docker-runner argv test (no mount form has one today), NEW
  `test/agent-listing-capture.ts`.

## Commit sequence

**One plan, five changes, because this is not one reviewable diff.** It spans the dispatcher, a new
exec module, a module move with seven importers, a mount form, a config key, an admin route, a web
card, an `AGENTS.md` section and ten-plus test targets. `docs/plans/README.md` and the repo's own
review rule both say to split rather than push that as a single change, and the batch is reviewed by
hand afterwards, so each piece below is independently green and revertible:

1. **The `toolProfile` drift** (Decision 7). One line plus its test, and deliberately first: it is a
   pre-existing mismatch this plan merely found, not agent isolation, so it should not be reviewed as
   part of one.
2. **Foundations, no behaviour change.** The `worktree-git-boundary.ts` move with its re-exports
   (`WORKER_REPO_STORAGE_ROOT`, `resolveInvocationWorkerRoot`, and the newly extracted
   `invocationRepoSubpath`, whose first caller is `resolveInvocationRepoMount`), the secret-mask
   policy predicate carved out of `secret-mask.ts` — which brings `picomatch` 4.0.4 and an ambient
   `.d.ts` with it, see Decision 1 — `parseAgentFile` exported, the `tmpfs` form on
   `DockerVolumeMount`, and `CONFIG_KEYS.AGENT_ISOLATION_ENABLED` with its default.
   Everything compiles and every path behaves exactly as today; nothing reads the switch yet.
   **`resolveInvocationWorkerTree` is NOT in this piece** — it is new, async, and its only callers
   are piece 3's, so putting it here would add an unused function to the commit that promises none.
   The dependency is the one thing here that is not inert: adding a direct `picomatch` retires the
   lockfile's stale `picomatch@4.0.5` and moves `lint-staged` and `vite` to `4.0.7` inside the `^4`
   range they already permitted. MEASURED: a bare `--lockfile-only` install with no package.json
   change produces an EMPTY diff, so that churn is caused by the declaration rather than pre-existing
   drift; pinning `4.0.7` instead is worse, because it drags tinyglobby's own
   `fdir@6.5.0(picomatch@4.0.4)` up with it and so changes the SCANNER the predicate must agree with.
3. **The dispatch rule.** `agentIsolationApplies`, `promptNamesAgentPath`, the project-instruction
   scan, the persona reader, the rewrite's positive arm, `LlmInvocationSpec.agentPool`, the spec
   fields, and `07_7-secret-sweep` declaring `'*'`. **AS BUILT**, with three departures worth
   knowing. The instruction scan, the persona reader, the kill-switch read and the mask policy live
   in a NEW `orchestrator/agent-isolation.ts` rather than inside `dispatcher.ts` as Critical files
   says: that file is already ~500 lines and the async half is testable on its own against a fixture
   tree. `agentIsolationApplies` itself stays pure, in `dispatcher.ts`, beside the request it reads.
   `promptNamesAgentPath` DUPLICATES the whole-segment primitive that `classifyReadPath`
   (`cli-executor/tool-usage.ts`) already has — shared cannot import worker, so the two anchorings
   are kept identical by comment and by test rather than by sharing code; consolidating them is a
   follow-up, not this piece. And `agent_persona.oversized` is recorded by a direct
   `schema.taskEvents` insert, because `appendEvent` lives in `task-queue.ts`, which the dispatcher
   cannot import for the same cycle reason `invocationRepoSubpath` moved.
4. **The exec mask.** `agent-definition-mask.ts`, the `authMounts` append, the dropped secret and
   `#ddev-generated` file masks, and the stub cleanup in a `finally`. **AS BUILT**, with two
   departures — and note that it SHIPPED INCOMPLETE: Decision 1's exec-time recheck of
   `pastedPersonaPaths` was not written, so that field had one writer and zero readers while two
   comments asserted the recheck happened. Piece 6 (`assertPastedPersonasStillAllowed` in
   `queues/cli-exec/secret-mask.ts`, called from `executeByKind` before `executeCliSpec`) is what
   closes it. The dispatch-to-exec `spec` forwarding was VERIFIED intact across all nine enqueue
   sites at the same time — eight pass `plan.invocation.spec`, the step-summary pass at
   `step-runner.ts:2828` passes `invocation.spec`, and `exec-core.ts` reads it back at `:439`/`:531`
   — so `maskAgentDefinitions` does arrive and the mask does engage. `realpathNoFollow` does NOT exist in `@haive/shared/fs-safe` and was dropped rather
   than added: every primitive there already refuses a link in any component of the rel and verifies
   the held inode through `/proc/self/fd`, so `lstatNoFollow` answering `symlink` for the entry is
   the whole containment check this module needs, and resolving a realpath alongside it would be a
   second mechanism that must agree with the first. Stub cleanup calls `removeNoFollow` with
   `recursive` UNSET, which fails `ENOTEMPTY` exactly as `rmdir` does — so "a stub that now holds
   something is no longer a stub" is the primitive's behaviour rather than an emptiness test written
   here, and an already-absent path answers `false` instead of throwing. The `maskFiles` filter runs
   on a LOCAL binding inside the `cli`/`agent_mining` branch, never on the shared array, because
   `subagent_sequential` consumes that one unchanged and the sub-agent kinds are never isolated.
5. **Switch surface and docs.** The admin GET/PUT pair shaped on `codex-app-server`
   (`api/src/routes/admin.ts:719`/`:744`), the web card, the `AGENTS.md` paragraph, and the capture
   harness.

**Whether 3 and 4 are one change or two is a judgement, not a preference.** It is recorded here
rather than left to whoever picks this up. Split, there is a window between them where the prompt has
narrowed and the mounts have not: an isolated invocation whose prompt names no agent file while the
directories are still visible. That is the SAFE direction, by exec item 6's own reasoning — leaving
the files visible only restores today's listing — and each piece is large enough to deserve its own
review. Folding them keeps prompt and mounts in step at every commit, at the cost of one large diff.
Default to splitting; fold them if the reviewer would rather have one atomic behaviour change than
two reviewable ones.

## Verification

Every claim in Context was measured by capturing the first model request with no network and no
tokens; the same method proves this change, so it becomes a checked-in harness instead of session
scratch.

1. **Capture harness** — new `packages/worker/test/agent-listing-capture.ts`, run inside the worker
   container like `test/model-report-discover.ts` and through the same production path:
   `createSandboxSpawner` with network policy `none`, the mounts `computeAgentDefinitionMasks`
   returns, and a node recorder shipped as a `SandboxExtraFile` and started ahead of the CLI in the
   same container. The recorder stores each request body and answers 400 (grok also needs 200 for
   `GET /models` and `GET /api-key`, or it exits "Not signed in"); the CLI is pointed at it with
   `ANTHROPIC_BASE_URL` (claude), `-c model_provider` plus
   `-c model_providers.cap={…wire_api="responses"}` (codex) or `XAI_API_BASE_URL` (grok). Per CLI,
   against a fixture repo:
   - masked → no repository agent names in the request, only the CLI's built-ins;
   - an isolated claude-family prompt carrying a persona marker → the framed body is in the
     request and the listing is still built-ins only;
   - unmasked → the request is byte-identical to today's;
   - a write into a masked directory fails — `readonly` on a tmpfs mount is the one piece of the
     mount the earlier captures did not exercise;
   - an untracked deny-listed file inside a masked agent directory still lets the container start,
     because its file mask is dropped rather than stacked under the read-only tmpfs;
   - an agent directory removed after the masks are built and before the container starts comes
     back root-owned, as exec side item 2 predicts, and is gone again once the run returns;
   - a fixture repository with a distinct sentinel in each candidate instruction file (`CLAUDE.md`,
     `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, and a copy in a nested directory) shows which of
     them each CLI puts in its first request, checked against its `rulesFile` and that file's imports.
2. **DONE** — #200 landed the catalog and `invocationRepoSubpath` assertions; #202 landed the
   built-in-prompt-builder scan as `packages/worker/src/step-engine/steps/prompt-agent-paths.test.ts`,
   which boots the production registry and scans 186 built prompts across every dispatch path (llm,
   loop by role x truncation-retry x history x detect-variant, mining, `MiningWaveError` waves, the
   direct `resolveTaskDispatch` calls no registry step owns, and the blocks spliced in after the
   decision). Thirteen prompts legitimately name a path, each with its reason recorded; three sources
   stay unreachable and are asserted BY NAME because `selectAgents` needs a live database there. Two
   things that file learned the hard way are worth carrying into any similar harness: a permissive
   proxy stand-in reaches only a builder's DEFAULT arm, and an assertion written to bound a gap will
   hide it unless it names what it tolerates.

   Unit tests (`pnpm --filter @haive/worker exec vitest run`), modelled on
   `test/mcp-none.test.ts` and `test/ddev-generated-mask.test.ts`: the mask builder (existing
   real directories only, symlinked ones left unmasked, read-only, fail-open, secret and ddev file
   masks under a masked directory dropped), `agentIsolationApplies` (a named agent directory or file, and `subagents`, included; the pointer inside a prompt's persona marker does not count, while the same marker-shaped block inside a pasted body does and keeps the invocation unmasked), a catalog assertion that
   every provider with `supportsSubagents` reads a markdown `projectAgentsDir`,
   `promptNamesAgentPath` (`.claude/agents/`, `.claude/agents`, `.claude/agents/x.md`,
   `./.claude/agents/x.md` and `/haive/workdir/.claude/agents/x.md` in running text match; `.claude`,
   `docs/.claude/agents/x.md` and `.claude/agents-old/x.md` do not; among built-in prompt builders,
   with persona markers removed the way `agentIsolationApplies` removes them, every match is an explicit
   list entry, so a new one fails the test and becomes a conscious decision — the criterion is the
   EXPLICITNESS, not a count. As built the list holds 13, and each is a decision rather than a leak:
   `06_5-agent-discovery`, whose prose legitimately points at prior-setup agent files and which declares
   `requiredCapabilities: []`, so this scan IS what disables its isolation; `09_5-skill-generation` in six
   variants (llm, both loop roles, both truncation-retry roles and its four-agent mining fan-out), moot
   because it declares `file_write` and is excluded two conditions earlier; `11-final-review`'s no-agents
   variant, where the path arrives in DATA rather than a template — it serialises its findings and the
   `no-agents` finding interpolates the agent directory it is reporting as empty; and two fixtures that
   exist to exercise the SEVENTH condition (a repository-shaped MCP server name and a KB digest title),
   which are positives by construction. Planned as "only 06_5 and 09_5", which was right for the three
   paths this plan knew about and wrong once the scan reached the wave, data-carried and post-decision
   ones), marker ids, the persona path
   (found / missing / an unparseable file or an empty or frontmatter-only body treated as missing / a file the secret mask covers, or whose mask status cannot be evaluated, never pasted / a persona pasted before a deny rule appeared fails the invocation at exec, including one whose file was deleted before exec / the link, FIFO, pseudo-file and out-of-tree cases DELEGATED to `packages/shared/test/fs-safe.test.ts`, which already pins them for the primitive this reader now calls — a symlinked or out-of-tree `<id>.md`, an agent directory swapped for a symlink, a FIFO that does not block, a pseudo-file reporting size 0 — so they are asserted once, where the guarantee lives / oversized alone or over the per-prompt budget together / a frontmatter `name` that differs from the filename / an oversized unrelated file that is never read / a body naming another agent file / a body containing `$&`, `` $` `` or `$'` pasted literally / template-less id / grok's directory / a provider outside the gate keeps
   today's rewrite / isolation off keeps today's rewrite), `invocationRepoSubpath` against
   `resolveInvocationRepoMount` for the local-path, root, override and branch cases, the tmpfs argv
   branch, `retryMiningAgents` skipping a recovered prompt that carries the pasted-persona label while
   still re-dispatching one without it, and `07_7-secret-sweep` declaring `'*'`.
3. **Typecheck and smokes:** `pnpm typecheck`, then in the worker container `smoke:workflow`,
   `smoke:dag-review` and `smoke:fix-loop` — the paths that dispatch personas, reviewers, DAG roles
   and fix rounds — pass unchanged.
4. **Live check** on the dev stack with a claude-code provider: one workflow task through 08c. In
   `cli_invocations.stream_log`, `init.agents` holds only the built-ins for 05 and the 08c
   reviewers and still holds the repository's agents for 07 (`file_write`); where the task has a
   ready LSP bridge, the reviewers' `cli_invocations.prompt` carries their persona bodies.
5. **Admin toggle in the browser** (Chrome DevTools MCP, per the project rule for front-end
   changes): the card loads the stored value, a flip survives a reload, and the next dispatched
   invocation follows it.

## Rollback

Additive and switch-gated, with no schema or data change. Turning the kill switch off restores
today's behaviour for every NEW invocation: no agent-directory mounts and the old pointer rewrite.
Reverting the commits removes it entirely; the helpers moved into `worktree-git-boundary.ts` stay
re-exported from `resolvers.ts`, so the revert touches no importer. Nothing persisted depends on
it — an invocation row written with isolation on reads identically with it off, and mining recovery
skips a stored prompt carrying the pasted-persona label whichever way the switch is set. After a
revert, recovery re-sends stored prompts as it does today, pasted bodies included.

## Companion: the agents declaration in `rippling-wibbling-puffin`

PR 1 builds the rule for built-in steps. A custom task type reaches it with no code change as long
as its synthesized steps declare the same facts, so the modular task-types plan carries them.
Folded IN PLACE into `docs/plans/rippling-wibbling-puffin.md` (no amendment section, per
`docs/plans/README.md`). Its half-A companion (`rippling-wibbling-puffin-agent-a233cf7f9b59974f6`)
stores only `stepIds: string[]` and needs nothing.

1. **Phase 3.1 prompt-template step.** The entry shape gains `agentPool?: '*'`, which
   `synthesizeStepDefinition` copies to the synthesized `llm.agentPool`. The entry's
   `requiredCapabilities` already say the rest. `file_write`, for a template that writes, keeps the
   real tree. `subagents`, for a template that wants the model to spawn repository agents, keeps
   the catalog AND restricts dispatch to sub-agent-capable adapters, every one of which reads a
   markdown agent directory — so such a template never lands on amp (no agent directory), codex or
   gemini. `agentPool: '*'` is only for a template that reads agent files as data, and it leaves
   provider eligibility alone.
2. **`{{agent:<id>}}` tokens.** `buildPrompt` renders a token as a marker of its own,
   `[[HAIVE_TEMPLATE_PERSONA:<id>]]`, never as PR 1's `agentDefinitionGuidance` block, and Phase 3.1
   widens PR 1's resolver for that syntax only, because PR 1's LSP gate exists to protect an embedded
   fallback a template persona does not have. The distinction has to reach dispatch, where the tree
   is known, while a built-in marker keeps its gate and fallback, so it rides in the prompt itself
   rather than in a `DispatchRequest` field every dispatch path would have to carry. The rewrite
   handles both kinds in ONE `replace` over a pattern matching either, since a second pass would
   rescan the bodies the first inserted. A token id must match
   the marker grammar (`[a-z0-9-]+`): the composer refuses any other id at save, task-create refuses
   it with a named reason, and `agentDefinitionGuidance` and the template marker's renderer both
   assert it, so no caller can emit a marker the rewrite would leave unparsed. Save and task-create
   run in the api, which cannot import the worker's private patterns, so the id grammar is one
   `@haive/shared` constant that the api's checks and both marker patterns are built from. The body is
   pasted for EVERY provider and whether or not the invocation is isolated: a template that
   declares `file_write`, `subagents` or `agentPool: '*'`, or names an agent directory or file in its prompt, still
   has no embedded protocol, so the widened resolver runs for these markers outside
   `agentIsolationApplies`, and every body it pastes is recorded in `pastedPersonaPaths` for the
   exec-time recheck (dispatch side, item 6), isolated or not. The body is read by filename (`<id>.md`, as PR 1 reads it) from the
   selected provider's own agent directory when that one is markdown and holds it, and otherwise
   from the first markdown agent directory in catalog order that does — the same directories the dangling-reference check below searches, so
   a persona defined only in `.gemini/agents` raises no start-time warning and still resolves for a claude
   dispatch, and codex (TOML) and amp (no agent directory) get it without the TOML reader PR 1
   defers. A marker whose body cannot be found at dispatch fails the dispatch with the
   dangling-reference reason below instead of running without its persona, since the start-time check below reads a
   different tree and the tree can change before dispatch; one whose body would exceed the prompt's remaining
   `MAX_PERSONA_BODY_BYTES` budget fails the same way, naming the file and its size — the budget is
   per prompt, counted in order of appearance across both marker kinds, so many tokens cannot add up
   past it. Template text needs nothing of its own: the prompt path scan (dispatch side, "Handed
   paths") sees interpolated values and static text like any other prompt text, a template marker
   names no path, and the bodies pasted for it are scanned verbatim, marker-shaped text included,
   since the rewrite never rescans what it inserts.
3. **Dangling references.** Extended to personas, with one difference from missing steps: whether a
   persona resolves depends on the tree the invocation will mount, and task-create cannot know that
   tree, since `01-worktree-setup` picks its base only when it runs (a synced base, its form's
   `baseBranch`, the current branch or `main`) and a worktree holds tracked files only. So
   task-create REFUSES only what no tree can fix, an id outside the marker grammar (item 2).
   Everything else is checked twice by PR 1's reader. When the worker starts the task
   (`handleStartTask`, beside its `task.running` event, which a task-level retry runs again), it reads
   the repository as checked out and records one `agent_persona.unresolved` task event, naming the
   step and the agent, for each persona the reader cannot use there: no `<id>.md` in any markdown
   agent directory, a symlink, an out-of-tree path, an unparseable file, an empty body, a file the
   secret mask covers, or a body past the per-prompt `MAX_PERSONA_BODY_BYTES` budget in marker order.
   That warning reaches the Activity tab the way `codex_app_server.unavailable` does and never blocks
   the start: a check that cannot run logs, records nothing and leaves the decision to dispatch. It runs in
   the worker because the reader and the secret-mask policy are worker code the api must not import;
   sharing the reader is also what keeps the warning and the dispatch from disagreeing about anything
   but the tree. Dispatch is the authoritative check and fails loudly with the same reason ("step
   `<slug>` needs agent `drupal7-developer`, which this repository does not define"). Refusing before
   dispatch would block a persona that exists only on the base the task actually branches from,
   which is the stance `AGENTS.md` records for onboarding and `computePlanReady`: a rule strict
   enough to choose must not refuse. A definition that exists only as `.codex/agents/<id>.toml`
   counts as absent until a TOML reader exists. Built-in steps never warn or fail this way, since
   their personas always have an inline fallback.
4. **Creator mode.** The generated candidate entry may use tokens and `agentPool`; the generating
   turn is handed the persona catalog Haive's onboarding templates install (id + description).
   Authoring is global, so no single repository's own agents apply; a repository-specific persona
   typed by hand is warned about when a task starts and checked authoritatively at dispatch by the
   dangling-reference rule, and the admin reviews the pick in the composer like any other field.
5. **Net-new infrastructure, Critical files, Verification.** Item 6 (`synthesizeStepDefinition`)
   and the Phase 3 and Shared critical-files lines name the field, the token, the start-time check in
   `handleStartTask` and the shared id grammar constant. Phase 3 verification gains a prompt-template
   step using `{{agent:peer-reviewer}}` whose captured request contains that persona's body and no
   other repository agent, a persona the checked-out repository lacks that warns at start and fails
   its dispatch, one defined only on the base `01-worktree-setup` branches from that warns at start
   and still runs, a codex dispatch that pastes a template marker's body while a built-in step in
   the same task keeps its fallback sentence, and a `file_write` template, which is not isolated,
   whose persona file a deny rule covers by exec time failing before the CLI starts.
6. **Header blockquote.** Records the dependency: Phase 3.1's agent handling needs this plan's
   rule, which ships first and independently.

`docs/plans/README.md` carries a status row for this plan (SHIPPED, six PRs) and a cross-plan
dependency bullet: `rippling-wibbling-puffin` Phase 3.1 builds on this plan's per-invocation agent
isolation.

## Out of scope (each measured or found in review, each its own change)

- **A default deny of the native sub-agent tool.** Claude's `--disallowedTools Agent` removed
  13,018 chars on 2.1.270, but AGENTS.md's openrouter note says the binary still sends the trailing
  agent-type message under it. So first a capture with the deny and no mask, asserting the `tools`
  list and that message separately; then correct AGENTS.md and
  `docker/openrouter-compat-proxy/hoist.mjs` with the version (the proxy stays either way). The
  deny must skip a dispatch that declares `subagents` (`resolveDispatch` picked a
  sub-agent-capable adapter for it) and one already running with `disableTools` on an adapter that
  honours it (`--tools ''` removes Agent, and `--tools ''` combinations have been fatal before),
  and grok stays out of it (next bullet).
- **grok's existing mining deny costs five tools beyond `spawn_subagent`.** `grok.ts` forwards
  mining's `['Agent']` as `--disallowed-tools`, and its comment says that "drops
  `spawn_subagent`"; measured, it removes six tools (18,315 chars), including the two that read and
  kill background shell commands. The `disallowedTools` doc in `cli-adapters/types.ts` still says
  non-claude adapters ignore the option. A separate fix, plus both comments.
- **Pools naming specific agents.** A step that wants to spawn one named agent natively would need
  that definition copied back inside the masked directory — a mount nested under a tmpfs that was
  measured only as a plain bind, never as the wrappers-volume subpath production uses. No built-in
  step spawns natively; build it, with that measurement, when one does.
- **codex keeps `spawn_agent` and its "primary agent in a team" prompt.** Masking removes only the
  roles listing. None of `features.multi_agent_v2=false` (what Haive sets), `--disable
  multi_agent`, `-c features.multi_agent=false`, collaboration modes off, or a different model
  removed the tool on 0.154.0, and `agents.max_threads=0` is rejected. Separate investigation.
- **Usage telemetry and the unused-agent report** (`cli_invocations.tool_usage`, backfill, stats
  tab). Separate plan; this one only makes the decision exist for it to record. **SHIPPED as #161:**
  `cli-executor/tool-usage.ts` carries `agents.assigned` and `assignedAgentIdsOf(spec)` (`:512`),
  fed by the `assignedAgentIds` spec field, so the record this plan defers to already exists and is
  waiting on the isolation decision to describe.
- **Skills listing** (16 skills bundled in the claude binary load on every run;
  `--disable-slash-commands` also hides repo skills). Separate.
- **Per-CLI rendered AGENTS.md overlay** (rules per CLI instead of the merged block). Optional,
  separate.
- **Onboarding upgrade does not restore the CLAUDE.md `@AGENTS.md` import**, so claude-family
  CLIs lose AGENTS.md after an upgrade (measured: claude reads AGENTS.md only through that import).
  A bug, separate fix.
- **03's persona loader reads a hardcoded `.claude/agents`**, so a repo onboarded only for codex,
  gemini or grok most likely gives 03 zero personas (inferred from 07's per-provider write targets,
  not measured).
- **gemini and antigravity**: their agent directories are in the mask list, but neither has a built
  image or a run on the dev install, so their behaviour is unmeasured.
- **User text shaped like a persona marker is rewritten as one, today.** `AGENT_GUIDANCE_PATTERN`
  matches `[[HAIVE_AGENT_DEFINITION:<id>]]` blocks wherever they appear, so a task description that
  forges one already has its inner text replaced before PR 1. The path scan skips exactly the span
  the rewrite replaces, so the two stay consistent; tracking marker provenance through prompt
  assembly would be its own change. Phase 3.1's template marker inherits the same property: text
  forging one is resolved as a template persona, pasting that body or failing the dispatch with the
  dangling-reference reason, which is loud and confined to the task whose text carries it.
- **The secret and `#ddev-generated` file masks have the same stub race** that exec side item 2
  closes for agent directories. Both resolve their targets before the container starts
  (`secret-mask.ts` scans the tree, `ddev-generated-mask.ts` `stat`s each file), so a file deleted
  in that window comes back as an empty root-owned file that outlives the container, and the app
  runtime, which mounts the same tree unmasked, then reads it in place of a missing one. The same
  identity-checked cleanup would cover them with `unlink` in place of `rmdir`; a separate change,
  since those masks predate this plan.
- **Instruction files beyond the entry point.** The isolation decision scans the selected provider's
  `rulesFile` and its `@` imports ("Project instructions"), not nested per-directory instruction
  files a CLI reads once it works in that directory, not CLI-specific extras such as
  `CLAUDE.local.md`, and not the user-level files a CLI reads from its home, so an agent reference
  that lives only there is hidden. The capture harness records which of the repository-side files each
  CLI actually loads (Verification, item 1), so that gap is sized by measurement before anyone widens
  the scan. The user-level files are left out on measurement. MEASURED on the dev install on
  2026-09-15 across all 63 CLI auth volumes: 11 user-level instruction files exist, every one Haive's
  own RTK global patch (an 8-byte `CLAUDE.md` or a 26-byte codex `AGENTS.md`), none naming an agent
  path, and no user-authored global instructions at all. They live in Docker volumes, so reading one
  at dispatch costs a helper container per read (`readVolumeFile` runs `docker run … cat`), and the
  per-task copy a CLI mounts is only made at exec (`ensureTaskAuthVolumes`). When a user-level
  reference does turn up, the cheap shape is at exec: the auth-volume helper records, when it
  populates the task's copy and beside the fingerprint it already records, whether the copied
  instructions name an agent path, and exec DROPS the agent-definition masks for that invocation,
  never adds one. That is the one safe direction for prompt and mounts to disagree, since an isolated
  prompt names no agent file and leaving the files visible only restores today's listing.
