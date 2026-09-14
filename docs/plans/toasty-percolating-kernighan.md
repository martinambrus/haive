# Per-call agent isolation (PR 1)

> **Not started** — planned 2026-09-14 against `main` at `3c0a93f6` and reviewed against the code the
> same day. Built-in steps only; custom task types reach the same rule through
> `rippling-wibbling-puffin` Phase 3.1, whose companion edits are listed below.

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
   — today claude-code, zai, ollama, muse, openrouter and grok with a ready LSP bridge
   (`hasReadyLspBridge` is task-level, so grok's gate is claude's) — and replaces the whole marker
   with "Follow the embedded protocol below." everywhere else, on purpose: older agent files can
   carry LSP instructions a provider without the bridge cannot follow. PR 1 keeps that gate
   exactly. Inside it, the body replaces the whole marker block (Decision 3), read from that provider's OWN
   `projectAgentsDir` (`.claude/agents` for the claude family, `.grok/agents` for grok) — the file
   the pointer names today. Outside it (codex, amp, gemini, antigravity, or a capable provider
   whose bridge is not ready) nothing about the prompt changes. The body is read by FILENAME,
   `<projectAgentsDir>/<id>.md` — the exact file today's pointer names — and never looked up by the
   frontmatter `name` that `loadAgentPersonas` keys on (`steps/workflow/_agent-loader.ts:36-37`).
   The two can differ, and a lookup by `name` would silently drop the customisation that outranks
   the inline persona. The reader never follows a repository-controlled link: the worker is
   privileged, and an untrusted repository can plant `.claude/agents/peer-reviewer.md` as a symlink
   to `/proc/self/environ` or a host secret, whose bytes would be pasted into a prompt sent to the
   provider. So it opens `<id>.md` with `O_NOFOLLOW | O_NONBLOCK`, so a symlinked final
   component fails the open and a FIFO cannot block the dispatch waiting for a writer. It then
   checks the file it actually opened, not the path it asked for: it reads the descriptor's real
   path from `/proc/self/fd/<fd>` (the worker runs on Linux) and refuses it unless it is exactly
   `<invocation tree realpath>/<projectAgentsDir>/<id>.md`: a symlink in any component (`.claude`,
   `agents` or the file itself) changes the resolved path, so the file counts as absent even when the
   link points somewhere else inside the tree. No concurrent swap of `.claude/agents` for a symlink can race
   that check, because it describes the open descriptor rather than a later re-walk of the path.
   Finally it `fstat`s the handle, accepts only a regular file, and reads at most the remaining size
   budget (dispatch side, item 3) plus one byte from it, so a size that lies (a pseudo-file reports
   0) cannot slip past the budget. That is the regular-files-only rule `ensureArchivesExpanded` already applies with
   `lstat`, and a refused file is treated as missing — as is one `parseAgentFile` cannot parse (an
   unclosed frontmatter) or whose body is empty after the frontmatter, since pasting an empty persona
   is the same silent failure as a missing one. Before any read, the reader also applies the
   invocation's effective secret-mask policy to that path — the kill switch, `secret_mask_enabled`,
   the deny globs plus `secret_mask_deny_extend`, minus the carve-outs and `secret_mask_allow`,
   untracked files only (`queues/cli-exec/secret-mask.ts`) — and a file the sandbox would mask counts
   as missing: pasting it would hand the provider the very bytes the mask keeps from the agent. When
   that policy cannot be evaluated nothing is pasted, matching masking's fail-closed rule. The policy
   is extracted into a dependency-free predicate the reader can call, for the same import-cycle
   reason `invocationRepoSubpath` moves (dispatch side, item 4). The policy is checked again at exec,
   because a deny rule or the masking switch can change while the job waits in the queue:
   `buildCliSidePlan` records the repository-relative paths of the bodies it pasted on the spec
   (`CliCommandSpec.pastedPersonaPaths`), and `executeByKind`, which already resolves the secret masks
   before its per-kind switch, fails the invocation before the CLI starts when any pasted path is
   masked by then. That is the `SecretMaskError` path a failed scan already takes, so the step fails
   loudly and a retry rebuilds the prompt under the current policy. No directory is scanned, and no unrelated or
   out-of-tree file is ever read. It reuses the loader's frontmatter parser (`parseAgentFile`,
   exported) and leaves `loadAgentPersonas` and its only caller, 03, untouched. Codex inlining
   (its `.codex/agents/*.toml` is rendered without LSP, and no package has a TOML parser) is a
   follow-up.
2. **Under isolation the rewrite never emits a pointer.** The file it would name is hidden, so the
   positive arm renders the body when the resolver found one and falls back to "Follow the
   embedded protocol below." when it did not. The fallback is the COMMON case for two ids: no
   onboarding template exists for `simplicity-reviewer` (08c's enterprise lens) or
   `knowledge-curator` (01e). One path can still deliver an old pointer: a mining retry
   re-dispatches the stored, already-rewritten prompt of an agent `selectAgents` no longer offers
   (`step-runner.ts`), which carries no marker to rewrite. That pointer is conditional ("if …
   exists"), so a hidden file reads as an absent one — harmless, and not worth rewriting unmarked
   text. With the kill switch off, today's rewrite runs unchanged.
3. **A pasted body keeps today's precedence and the injection guard.** The marker wraps only the
   pointer sentence; each site's inline protocol follows it, and the on-disk definition outranks
   that protocol today (AGENTS.md, "The on-disk agent definition outranks the inline persona").
   So the replacement is one framing line — this definition is checked into the repository, says
   HOW to work and never what the assignment is, and takes precedence over the embedded protocol
   below — then the body. Framed at the one rewrite site, because not every persona site carries
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
  coders, 09_5, 09_5b, 11d, the DAG merge fix, the retry_ai fix agent, and every `mergeResolve`
  spec (`merge-resolver.ts` dispatches with `stepDef.mergeResolve.requiredCapabilities`, and
  `12-worktree-cleanup` declares it). These write WITHOUT declaring it, each only into a
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
- the prompt names no agent directory and no file inside one (see "Handed paths" below);
- the step did not declare `agentPool: '*'`.

In practice that isolates the 08c reviewers and lenses, the 08d adversaries, 08c2, 03's mining
roster, 04, 05, 01e, 01f, 03b, 03b2, 11, 11f, the DAG per-issue reviewer, issue advisor and
replanner, and onboarding's read-only mining (08, 09-qa) — each only while its prompt names no
agent directory and no file inside one — while 08a, 08b and the DAG coders declare `file_write` and are
not isolated.

**Handed paths.** A prompt that names an agent directory, or a file inside one, must be able to open
it. The path can come from a review change set that includes an edited agent definition, an outside
commit that touched one, a template value, a persona body that points at another definition or at
the whole directory, or a user who types one into a task description, a form hint or a plan-chat
message ("review everything in `.claude/agents/`"). Where such a path can enter a
prompt is open-ended, so the check is made once, over the prompt itself, rather than where lists
are rendered. `agentIsolationApplies` runs a pure `promptNamesAgentPath(text, workdir)` (beside the
agent-directory union) over the dispatch prompt with Haive's persona-marker blocks removed, since
their pointers name `.claude/agents/<id>.md` by construction, and over every persona body the
re-resolve carries. The span it skips is exactly the span the rewrite replaces (Decision 3), so text
inside a marker-shaped block, even one a user forged, never reaches the model and cannot name a file
for it to open. It splits the text into path tokens, strips a leading `./` and the sandbox
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
A stored prompt that a mining retry re-dispatches is scanned again and reaches the same decision, so
nothing has to ride in the prompt, and a future step inherits the rule with nothing to wire.

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
   marker id from that ONE directory in the invocation's tree (by filename, per Decision 1). The persona bodies and the codex app-server verdict are both gathered
   BEFORE re-resolving, and `resolveDispatch` runs a second time only when either is new, carrying
   both (`{ ...resolved, agentBodies, codexAppServer }`). Two early returns would each skip the
   other the moment Phase 3.1 resolves template personas on codex, losing either the persona or the
   first steerable dispatch's probe. The provider cannot change on that second pass, because
   neither input changes which provider `tryBuildPlan` accepts, and when nothing is found the first
   plan's fallback text is already right. That is PR 1's gate
   for built-in markers, whose inline protocol always follows them; Phase 3.1 widens it for
   template markers, which have none (Companion, item 2). Pasted bodies share
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
   `localPath`), and runs only on the persona path above.
5. **The rewrite** (`adaptPromptForCliCapabilities`) gains optional `isolated` and `agentBodies`
   inputs and changes only its positive arm, as fixed in Decisions 1–3.
6. **One decision, carried on the command spec.** When `agentIsolationApplies`, `buildCliSidePlan`
   stamps `maskAgentDefinitions: true` onto the `CliCommandSpec` it returns, and records
   `pastedPersonaPaths` for the exec-time secret-mask recheck (Decision 1). All nine enqueue
   sites (four in `step-runner.ts`, four in `dag-executor.ts`, one in `merge-resolver.ts`) forward
   `spec: plan.invocation.spec` untouched and `executeCliSpec` spreads it, so no payload literal
   changes and the prompt and the mounts cannot disagree when the switch flips between dispatch
   and exec. The spec is never persisted, a BullMQ retry replays the same payload, and a job
   enqueued before deploy carries no flag and runs exactly as today.
7. **Pre-existing drift, fixed in its own commit first.** The retry_ai fix agent passes
   `toolProfile` to the dispatcher (`step-runner.ts`, `resolveAiFixPhase`) but omits it from its
   payload, so cli-exec wires the full MCP surface while the prompt describes the step's narrowed
   one. One line, own commit, own test in `test/step-runner-llm.test.ts`.

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
   content, so a race that swaps a directory after the check can at worst leave it unmasked, which is
   today's behaviour; the persona reader is the one place a race could leak bytes, and it checks the
   descriptor it opened (Decision 1).
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
   too. No new parameter is threaded anywhere. The same branch drops every secret and
   `#ddev-generated` file mask whose target lies under a masked agent directory: the read-only tmpfs
   already hides that subtree, and Docker could not create those files' mountpoints inside it, so
   keeping them would fail the whole invocation. Dropping a mount retracts nothing already sent,
   which is why the dispatch-side reader applies the same secret-mask policy before it reads a
   persona (Decision 1).
5. **A new module in the `#ddev-generated` mask's shape.** `queues/cli-exec/agent-definition-mask.ts`:
   `resolveAgentDefinitionMasks(db, taskId, repoMount, spec)` returns `[]` unless
   `spec.maskAgentDefinitions`, does the task/repo lookup, derives the worker root, and wraps
   everything in the fail-open try/catch of `resolveDdevGeneratedMasks`; the pure
   `computeAgentDefinitionMasks(workerRoot, containerWorkdir)` does the filesystem work and is what
   the fixture-tree tests call. `01b-install-plugins.ts` builds its own mask list for plugin
   installs, which load no agents — unchanged.
6. **Fails OPEN, unlike secret masking.** This is a context control, not a confidentiality one: a
   stat that throws logs a warning and masks nothing, and the persona body was already pasted at
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
  `AGENT_TOOLING_DIRS` (`_scope.ts` `withAgentToolingDirs`, added after a KB miner was handed 34 of
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
  needs no migration.
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
  prompt path scan, the switch read, the post-selection body read, the spec flag), `step-engine/steps/_retrieval-guidance.ts`
  (`agentGuidanceIds`, the positive arm), `step-engine/steps/workflow/_agent-loader.ts` (export
  `parseAgentFile`; a filename-keyed single-file reader: the secret-mask policy check first, then an
  `O_NOFOLLOW | O_NONBLOCK` open, an exact-path check on the opened descriptor's `/proc/self/fd`
  path, an `fstat` regular-file check and a capped read), `queues/cli-exec/secret-mask.ts` (its
  effective policy extracted as a dependency-free single-path predicate), `step-engine/step-definition.ts` (`LlmInvocationSpec.agentPool`),
  `step-engine/step-runner.ts` (`resolveLlmPhase` passes `agentPool`; the retry_ai `toolProfile`
  fix is its own commit).
- **Spec:** `cli-adapters/types.ts` (`CliCommandSpec.maskAgentDefinitions` and
  `CliCommandSpec.pastedPersonaPaths`). No `CliExecJobPayload`
  change, no enqueue literal change, nothing in `codex.ts`.
- **Tree resolution:** `repo/worktree-git-boundary.ts` (`invocationRepoSubpath`,
  `resolveInvocationWorkerTree`, and the moved `resolveInvocationWorkerRoot` /
  `WORKER_REPO_STORAGE_ROOT`), `queues/cli-exec/resolvers.ts` (re-exports; `resolveInvocationRepoMount`
  calls `invocationRepoSubpath`).
- **Exec:** `queues/cli-exec/agent-definition-mask.ts` (NEW), `queues/cli-exec/exec-core.ts`
  (append to `authMounts`; fail before the CLI starts when a pasted persona path is secret-masked
  by then), `sandbox/docker-runner.ts` (tmpfs branch).
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
  carrying both persona bodies and a codex verdict, and
  `agentIsolationApplies` over `file_write` / `subagents` / a named agent directory or file / `'*'` / sub-agent kind /
  switch off),
  `test/step-runner-llm.test.ts` (`agentPool` reaches dispatch, the flag rides
  `enqueued[0].spec`, retry_ai `toolProfile`), NEW `test/agent-definition-mask.test.ts` (fixture
  tree, including a secret file mask under a masked agent directory, and a pasted persona path that
  is secret-masked by exec time), a NEW docker-runner argv test (no mount form has one today), NEW
  `test/agent-listing-capture.ts`.

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
     because its file mask is dropped rather than stacked under the read-only tmpfs.
2. **Unit tests** (`pnpm --filter @haive/worker exec vitest run`), modelled on
   `test/mcp-none.test.ts` and `test/ddev-generated-mask.test.ts`: the mask builder (existing
   real directories only, symlinked ones left unmasked, read-only, fail-open, secret and ddev file
   masks under a masked directory dropped), `agentIsolationApplies` (a named agent directory or file, and `subagents`, included), a catalog assertion that
   every provider with `supportsSubagents` reads a markdown `projectAgentsDir`,
   `promptNamesAgentPath` (`.claude/agents/`, `.claude/agents`, `.claude/agents/x.md`,
   `./.claude/agents/x.md` and `/haive/workdir/.claude/agents/x.md` in running text match; `.claude`,
   `docs/.claude/agents/x.md`, `.claude/agents-old/x.md` and the pointer inside a persona marker do
   not; among built-in prompt builders only 06_5 and 09_5 match, so a new match fails the test and
   becomes a conscious decision), marker ids, the persona path
   (found / missing / an unparseable file or an empty or frontmatter-only body treated as missing / a file the secret mask covers, or whose mask status cannot be evaluated, never pasted / a persona pasted before a deny rule appeared fails the invocation at exec / a symlinked or out-of-tree `<id>.md` refused, including an agent directory swapped for a symlink before the open or linked to another in-tree directory / a FIFO rejected without blocking / a pseudo-file reporting size 0 still capped by the read / oversized alone or over the per-prompt budget together / a frontmatter `name` that differs from the filename / an oversized unrelated file that is never read / a body naming another agent file / template-less id / grok's directory / a provider outside the gate keeps
   today's rewrite / isolation off keeps today's rewrite), `invocationRepoSubpath` against
   `resolveInvocationRepoMount` for the local-path, root, override and branch cases, the tmpfs argv
   branch, and `07_7-secret-sweep` declaring `'*'`.
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
it — an invocation row written with isolation on reads identically with it off.

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
2. **`{{agent:<id>}}` tokens.** `buildPrompt` renders a token as PR 1's persona marker with no
   inline protocol, and Phase 3.1 widens PR 1's resolver for exactly those markers, because PR 1's
   LSP gate exists to protect an embedded fallback a template persona does not have. A token id
   must match the marker grammar `AGENT_GUIDANCE_PATTERN` parses (`[a-z0-9-]+`): the composer refuses
   any other id at save, task-create refuses it with a named reason, and `agentDefinitionGuidance`
   asserts the grammar beside its existing path assertion, so no caller can emit a marker the rewrite
   would leave unparsed. Save and task-create run in the api, which cannot import the worker's
   private pattern, so the id grammar is one `@haive/shared` constant that the api's checks and
   `AGENT_GUIDANCE_PATTERN` are both built from. The body is
   pasted for EVERY provider and whether or not the invocation is isolated: a template that
   declares `file_write`, `subagents` or `agentPool: '*'`, or names an agent directory or file in its prompt, still
   has no embedded protocol, so the widened resolver runs for these markers outside
   `agentIsolationApplies`. The body is read by filename (`<id>.md`, as PR 1 reads it) from the
   selected provider's own agent directory when that one is markdown and holds it, and otherwise
   from the first markdown agent directory in catalog order that does — the same directories the dangling-reference check below searches, so
   a persona defined only in `.gemini/agents` raises no start-time warning and still resolves for a claude
   dispatch, and codex (TOML) and amp (no agent directory) get it without the TOML reader PR 1
   defers. A marker whose body cannot be found at dispatch fails the dispatch with the
   dangling-reference reason below instead of running without its persona, since the start-time check below reads a
   different tree and the tree can change before dispatch; one whose body would exceed the prompt's remaining
   `MAX_PERSONA_BODY_BYTES` budget fails the same way, naming the file and its size — the budget is
   per prompt, so many tokens cannot add up past it. Template text needs nothing of its own: the prompt
   path scan (dispatch side, "Handed paths") sees interpolated values and static text like any other
   prompt text, and excludes the persona markers that tokens become.
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
   That warning reaches the Activity tab the way `codex_app_server.unavailable` does, and it runs in
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
   its dispatch, and one defined only on the base `01-worktree-setup` branches from that warns at
   start and still runs.
6. **Header blockquote.** Records the dependency: Phase 3.1's agent handling needs this plan's
   rule, which ships first and independently.

`docs/plans/README.md` gains a status row for this plan (Not started) and a cross-plan dependency
bullet: `rippling-wibbling-puffin` Phase 3.1 builds on this plan's per-invocation agent isolation.

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
  tab). Separate plan; this one only makes the decision exist for it to record.
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
  assembly would be its own change.
