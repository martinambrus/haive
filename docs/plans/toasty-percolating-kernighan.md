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
   exactly. Inside it, the body replaces the pointer, read from that provider's OWN
   `projectAgentsDir` (`.claude/agents` for the claude family, `.grok/agents` for grok) — the file
   the pointer names today. Outside it (codex, amp, gemini, antigravity, or a capable provider
   whose bridge is not ready) nothing about the prompt changes. The reader is `loadAgentPersonas`
   (`steps/workflow/_agent-loader.ts`, called only by 03), which already parses frontmatter and
   returns `body`; it gains a directory argument defaulting to `.claude/agents`. Codex inlining
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
- the prompt hands the agent no path inside an agent directory (see "Handed paths" below);
- the step did not declare `agentPool: '*'`.

In practice that isolates the 08c reviewers and lenses, the 08d adversaries, 08c2, 03's mining
roster, 04, 05, 01e, 01f, 03b, 03b2, 11, 11f, the DAG per-issue reviewer, issue advisor and
replanner, and onboarding's read-only mining (08, 09-qa) — each only while the paths it is handed
stay outside the agent directories — while 08a, 08b and the DAG coders declare `file_write` and are
not isolated.

**Handed paths.** Several read-only dispatches are handed a list of repository paths to READ: the
review change set (`changedFilesBlock` in `_impl-changes.ts`, rendered by 08c, 08c2 and 08d among
others), the external drift 01e and 01f list (`resolveExternalDrift`, which drops only Haive's own
commits), the task's `changedPaths` that `11f-plan-reconcile` lists, the `filesTouched` list
`11-phase-8-learning` renders into its prompt, and the `filesModified` change set the DAG per-issue
reviewer is told to "read each in full" (`reviewerPrompt`, `dag-executor.ts`). Those are every
read-only prompt that renders a change set, found by searching the renderers of
`changedFilesBlock`, `changedPaths`, `filesTouched` and `filesModified`. A task that
edits an agent definition, or an outside commit that touches one, would otherwise hand a reviewer or
a catch-up agent a file the mask hides — a review of a change it never saw, the failure
`changedFilesBlock`'s COVERAGE notice exists to prevent. So those renderers append
`AGENT_DIRECTORY_SCOPE_MARKER` whenever a listed path lies inside an agent directory (a pure
`agentDirectoryScopeMarker(paths)` beside the agent-directory union, matching repository-relative
paths on whole segments from the root, the way `isDeniedPath` does), and `agentIsolationApplies`
treats the marker as `agentPool: '*'`. The marker stays in the prompt, as
`WORKTREE_GIT_BOUNDARY_MARKER` does, so a stored prompt that a mining retry re-dispatches keeps the
decision it was built with. The rule lives at the render sites, not in a list of steps: a future
step that reuses these helpers inherits it.

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
   with `agentFileFormat: 'markdown'`) and the prompt has marker ids, read that ONE directory in
   the invocation's tree and, when any body is found, `return resolveDispatch({ ...resolved,
   agentBodies })`. The provider cannot change on that second pass, because bodies never affect
   `tryBuildPlan`; codex never passes the gate, so this never stacks with the codex re-resolve;
   and when nothing is found the first plan's fallback text is already right.
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
   stamps `maskAgentDefinitions: true` onto the `CliCommandSpec` it returns. All nine enqueue
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
   (`sandbox/sandbox-runner.ts` records the same hazard for files). So the builder stats each
   candidate under the invocation's worker-side root (`resolveInvocationWorkerRoot`) and masks
   only what is there.
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
   too. No new parameter is threaded anywhere.
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
  system never runs. No pool: hiding them removes that trap.
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
- **08c, 08c2, 08d, 01e, 01f, 11-phase-8-learning, 11f-plan-reconcile, the DAG per-issue
  reviewer** — handed lists of repository paths to read (the review change set, the external
  drift, `changedPaths`, `filesTouched`, `filesModified`). Isolated only while no listed path
  lies inside an agent directory; a list that names one carries the scope marker, and that
  invocation sees the real tree (dispatch side, "Handed paths").
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
  scope-marker check, the switch read, the post-selection body read, the spec flag), `step-engine/steps/_retrieval-guidance.ts`
  (`agentGuidanceIds`, the positive arm), `step-engine/steps/workflow/_agent-loader.ts` (directory
  argument), `step-engine/step-definition.ts` (`LlmInvocationSpec.agentPool`),
  `step-engine/step-runner.ts` (`resolveLlmPhase` passes `agentPool`; the retry_ai `toolProfile`
  fix is its own commit).
- **Spec:** `cli-adapters/types.ts` (`CliCommandSpec.maskAgentDefinitions`). No `CliExecJobPayload`
  change, no enqueue literal change, nothing in `codex.ts`.
- **Tree resolution:** `repo/worktree-git-boundary.ts` (`invocationRepoSubpath`,
  `resolveInvocationWorkerTree`, and the moved `resolveInvocationWorkerRoot` /
  `WORKER_REPO_STORAGE_ROOT`), `queues/cli-exec/resolvers.ts` (re-exports; `resolveInvocationRepoMount`
  calls `invocationRepoSubpath`).
- **Exec:** `queues/cli-exec/agent-definition-mask.ts` (NEW), `queues/cli-exec/exec-core.ts`
  (append to `authMounts`), `sandbox/docker-runner.ts` (tmpfs branch).
- **Steps:** `step-engine/steps/onboarding/07_7-secret-sweep.ts` (`agentPool: '*'`), and the
  handed-path renderers that append the scope marker: `step-engine/steps/workflow/_impl-changes.ts`
  (`changedFilesBlock`), `01e-external-kb-sync.ts`, `01f-external-plan-sync.ts`,
  `11-phase-8-learning.ts`, `11f-plan-reconcile.ts`, and `step-engine/dag-executor.ts`
  (`reviewerPrompt`).
- **Shared:** beside `packages/shared/src/cli-providers/catalog.ts` (the agent-directory union and
  `agentDirectoryScopeMarker`),
  `packages/shared/src/config/config.service.ts` (key and default).
- **API and web:** `packages/api/src/routes/admin.ts`, `packages/web/src/app/(app)/admin/page.tsx`.
- **Docs:** `AGENTS.md` → Sandbox, a paragraph beside "Secret-file masking" and "Worktree gitfile
  masking": what is hidden, from which invocations, why it fails open, and the measured listing
  costs.
- **Tests:** `test/dispatcher.test.ts` (isolated twins, grok, a template-less id, and
  `agentIsolationApplies` over `file_write` / `subagents` / the scope marker / `'*'` / sub-agent kind /
  switch off),
  `test/step-runner-llm.test.ts` (`agentPool` reaches dispatch, the flag rides
  `enqueued[0].spec`, retry_ai `toolProfile`), NEW `test/agent-definition-mask.test.ts` (fixture
  tree), a NEW docker-runner argv test (no mount form has one today), NEW
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
     mount the earlier captures did not exercise.
2. **Unit tests** (`pnpm --filter @haive/worker exec vitest run`), modelled on
   `test/mcp-none.test.ts` and `test/ddev-generated-mask.test.ts`: the mask builder (existing
   directories only, read-only, fail-open), `agentIsolationApplies` (the scope marker and `subagents` included), a catalog assertion that
   every provider with `supportsSubagents` reads a markdown `projectAgentsDir`,
   `agentDirectoryScopeMarker` (`.claude/agents/x.md` marks; `docs/.claude/agents/x.md` and
   `.claude/agents-old/x.md` do not), marker ids, the persona path
   (found / missing / template-less id / grok's directory / a provider outside the gate keeps
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
   LSP gate exists to protect an embedded fallback a template persona does not have. The body is
   pasted for EVERY provider, read from the selected provider's own agent directory when that one
   is markdown and otherwise from the first markdown agent directory in catalog order that defines
   the id — so codex (TOML) and amp (no agent directory) get the same persona without the TOML
   reader PR 1 defers. A marker whose body cannot be found at dispatch fails the dispatch with the
   dangling-reference reason below instead of running without its persona, since the tree can
   change between task-create and dispatch. The factory is also a handed-path renderer: a read-only
   template that interpolates an agent file (`Review {{path}}` with `path = .claude/agents/foo.md`)
   would hand its agent a masked file, so `buildPrompt` runs `agentDirectoryScopeMarker` over the
   template's static text and every interpolated value, split into path tokens, BEFORE tokens
   become persona markers (whose own pointer names `.claude/agents/<id>.md`), and appends the scope
   marker when one lies inside an agent directory.
3. **Dangling references.** Extended to personas: a token naming a persona the target repository
   does not define in a markdown agent directory is refused at task-create with a named reason
   ("step `<slug>` needs agent `drupal7-developer`, which this repository does not define") — the
   same not-silently-truncated rule the section applies to missing steps. A definition that exists
   only as `.codex/agents/<id>.toml` counts as absent until a TOML reader exists. Built-in steps are
   never refused this way, since their personas always have an inline fallback.
4. **Creator mode.** The generated candidate entry may use tokens and `agentPool`; the generating
   turn is handed the persona catalog Haive's onboarding templates install (id + description).
   Authoring is global, so no single repository's own agents apply; a repository-specific persona
   typed by hand is caught at task-create by the dangling-reference rule, and the admin reviews the
   pick in the composer like any other field.
5. **Net-new infrastructure, Critical files, Verification.** Item 6 (`synthesizeStepDefinition`)
   and the Phase 3 critical-files line name the field and the token; Phase 3 verification gains a
   prompt-template step using `{{agent:peer-reviewer}}` whose captured request contains that
   persona's body and no other repository agent.
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
