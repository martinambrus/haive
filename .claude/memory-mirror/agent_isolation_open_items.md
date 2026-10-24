---
name: agent-isolation-open-items
description: "Agent-isolation landing order: all six pieces shipped (#191-#196), why the predicate needed picomatch, what remains is the plan's own verification items 1/2/4, and the found-not-fixed item behind it — an absent toolProfile on a cli-exec payload means the FULL MCP surface"
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-22T15:15:00.000Z
---

The plan is `docs/plans/toasty-percolating-kernighan.md` (**read the H1 first** — that slug is
overloaded, see [[plan-slug-collision]]), re-verified against `main` at `9ea6f06e` on 2026-09-21
after 176 commits of drift, and given a five-piece `## Commit sequence`.

**Piece 1 LANDED 2026-09-21** as PR #191, merge commit `7deb542d`, main green on all five jobs.
One source line plus one test: `resolveAiFixPhase` passed `toolProfile` to `resolveTaskDispatch`
but omitted it from the `enqueueCliInvocation` payload. It landed ALONE on purpose — a
pre-existing mismatch the plan merely found while auditing the dispatch path, not agent isolation
— and its agent always declares `file_write`, so it is never isolated either way.

**Piece 2 LANDED 2026-09-21** as PR #192, merge commit `bde5722e`, main green on all five jobs.
Foundations, inert by design: `WORKER_REPO_STORAGE_ROOT` and `resolveInvocationWorkerRoot` moved
from `queues/cli-exec/resolvers.ts` into `repo/worktree-git-boundary.ts` with a NEW
`invocationRepoSubpath` extracted from the rule that was inline in `resolveInvocationRepoMount`
(its first caller, so nothing is dead); the secret-mask policy as a single-path predicate in a new
`queues/cli-exec/secret-mask-policy.ts`; `parseAgentFile` + `ParsedAgentFile` exported;
`tmpfs?: true` on `DockerVolumeMount`; and `CONFIG_KEYS.AGENT_ISOLATION_ENABLED` with no reader.

Three things from it worth not re-deriving. **A re-export is not an import**: `export { X } from`
creates no local binding, so `resolvers.ts` needs BOTH for `WORKER_REPO_STORAGE_ROOT`, which
`ensureRepoMountWritable` uses twice in that same file — it already used that pair for
`HOST_REPO_ROOT`, which is the shape to copy. **The predicate needed a glob engine and that was a
GAP in the plan, not drift**: the policy is glob arrays and `computeSecretMasks` evaluates them with
tinyglobby's directory scanner, which cannot judge one path. Node's own `path.matchesGlob` was
MEASURED at 21 of 26 real paths against that scanner — `**` will not descend into a dotted
directory and `*` will not match a dotted basename without `dot: true`, so `**/.env` missed
`.config/.env` and `**/*.pem` missed `.hidden.pem`, THREE of the five in the unsafe direction. So
piece 2 declares `picomatch` **4.0.4**, the version tinyglobby itself resolves, with an ambient
`.d.ts` (it ships no types and `@types/picomatch` is not in the lockfile, so a local declaration
avoids a second dep and a network fetch). Pinning **4.0.7 was rejected on measurement**: it drags
tinyglobby's own `fdir@6.5.0(picomatch@4.0.4)` up with it and so changes the very scanner the
predicate must agree with. **The lockfile churn is disclosed, not hidden**: adding a direct
picomatch retires the stale `picomatch@4.0.5` and moves `lint-staged` and `vite` to `4.0.7` inside
the `^4` range they already allowed — a bare `--lockfile-only` install with no package.json change
produces an EMPTY diff, so the churn is the declaration's, not pre-existing drift.

**DECIDED 2026-09-22 by the user: the `?? 'full'` default STAYS.** Do not re-raise it as a defect and
do not flip it. If it is ever addressed, the shape is a typed requirement at the payload boundary —
never a change to the default, which four call sites rely on. The hazard below is recorded so the
NEXT omission is recognised quickly, not as an argument for changing the contract.

**FOUND, NOT FIXED — and it is PREVENTIVE, not a live defect.** `exec-core.ts:494` resolves
`payload.toolProfile ?? 'full'` (again at `queues/cli-exec/sub-agent.ts:72` and `:147` — that file is
under `queues/cli-exec/`, NOT `orchestrator/`), so forgetting the field on
a payload does not fail and does not warn — it hands the agent every MCP server. The type itself
documents that (`unset = the full surface`), so it is a stated design choice; the hazard is only
that an OMISSION is indistinguishable from an intentional full surface, which is what kept piece
1's bug invisible. Left deliberately, and **the fix belongs inside piece 4 (the exec mask)** — the
change with standing to alter the payload/mask contract. Shape: a typed requirement at the payload
boundary, NEVER a flip of the default, which four call sites rely on.

**The defect CLASS is "the dispatcher got a profile and the payload did not", and as of 2026-09-21
it exists nowhere else.** MEASURED worker-wide: NINE enqueue sites, not four. `step-runner.ts` has
four and each pairs a dispatcher call with a payload line — `:868`/`:876` (`llmSpec.toolProfile`),
`:1039`/`:1050` (piece 1), `:1650`/`:1659` (`spec.toolProfile`), `:2818`/`:2825` (both `'none'`, the
step-summary pass). The other five — `dag-executor.ts:620`/`:919`/`:1610`/`:2047` and
`merge-resolver.ts:521` — contain the string `toolProfile` ZERO times and their `resolveTaskDispatch`
calls pass none either, so both halves are consistently absent and the full surface they get is the
one their prompts describe. `step-runner.ts:216` is the deps-interface declaration, not a call site;
counting it inflates step-runner's four to five. The field is declared at
`packages/shared/src/constants/index.ts:414` as `toolProfile?: 'rag_only' | 'none'` — a real
optional union, not an index signature, so a typo is a type error rather than a silent no-op.

**Piece 6 (PR #196) closed a HOLE in piece 4, and the hole is the lesson.** Decision 1 requires that a
persona body pasted at dispatch be RECHECKED at exec against the current secret-mask policy, failing
the invocation before the CLI starts if a deny rule or the masking switch changed while the job sat in
the queue. Piece 4 shipped without it: `CliCommandSpec.pastedPersonaPaths` had ONE writer
(`dispatcher.ts:563`) and ZERO readers, while two comments — in `step-runner.ts` and
`_retrieval-guidance.ts` — asserted the recheck happened. I reported the piece as built. Found only by
grepping writers against readers after the fact, which is the check worth running on any field added
to carry a decision across a boundary: **one writer and no readers is a shipped no-op**.
`assertPastedPersonasStillAllowed` (`queues/cli-exec/secret-mask.ts`, called from `executeByKind`
before `executeCliSpec`) is the fix; both comments now name it. The dispatch-to-exec `spec` forwarding
was verified intact at the same time across all nine enqueue sites, so `maskAgentDefinitions` does
arrive and the exec mask does engage.

A second finding from that PR, worth keeping: removing the recheck's CALL SITE left **252 of 252**
tests passing, and the only objection came from tsc's unused-import error. A function can be fully
unit-tested and still be wired to nothing. `test/persona-recheck.test.ts` therefore carries a
structural guard asserting the call exists with `pastedPersonaPaths` AND precedes `executeCliSpec` —
a proxy for an execution test (driving `executeByKind` needs provider rows, secrets, an image and a
spawner), labelled as such in the file.

**VERIFICATION ITEMS 1 AND 2 ARE THE REAL REMAINING WORK, and item 1 is much bigger than it looks.**
All six pieces shipped 2026-09-21 (#191 `7deb542d`, #192 `bde5722e`, #193 `fe3148a5`, #194
`16f8be37`, #195 `a66a79de`, #196 the recheck above). What is NOT done is the plan's own
Verification section:

- **Item 1, the capture harness.** I wrote a version and CUT it rather than ship a scaffold: its
  central step was an unwritten TODO and it counted agent names with a regex over a serialized
  request body. Reading the spec properly afterwards showed it needs FAR more — the production path
  (`createSandboxSpawner`, network policy `none`, the mounts `computeAgentDefinitionMasks` actually
  returns), a node recorder shipped as a `SandboxExtraFile` and started ahead of the CLI IN THE SAME
  container, and per-CLI wiring that cannot be reasoned out: `ANTHROPIC_BASE_URL` (claude),
  `-c model_provider` plus `-c model_providers.cap={…wire_api="responses"}` (codex),
  `XAI_API_BASE_URL` (grok) — and grok also needs **200** on `GET /models` and `GET /api-key` or it
  exits "Not signed in". Seven assertions, three of which I had not contemplated: a write into a
  masked directory must FAIL on `readonly` (the one part of the tmpfs mount no earlier capture
  exercised), a deny-listed untracked file inside a masked directory must still let the container
  start because its file mask is DROPPED rather than stacked, and a directory removed between
  mask-build and container start must come back root-owned and be gone again after the run. Plus an
  instruction-file sentinel fixture across `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`
  and a nested copy. Needs a live stack and a fixture repo with real `.claude/agents/*.md`.
- **Item 2's missing unit assertions**, cheap and doable with no stack: a catalog assertion that every
  provider with `supportsSubagents` reads a markdown `projectAgentsDir`; that among built-in prompt
  builders, with markers stripped the way `agentIsolationApplies` strips them, ONLY `06_5` and `09_5`
  match `promptNamesAgentPath` — so a new match fails the test and becomes a conscious decision; and
  `invocationRepoSubpath` cross-checked against `resolveInvocationRepoMount` for the local-path, root,
  override and branch cases.
- **Item 4**, the live check: one workflow task through 08c, reading `cli_invocations.stream_log` for
  `init.agents` holding only built-ins on 05 and the 08c reviewers while still holding the repo's
  agents on 07 (`file_write`). That is the measurement that proves the feature end to end.
- **Item 5, the admin toggle in the browser — VERIFIED 2026-09-21, two assertions of three.** Done on
  the dev stack at `localhost:3000/admin?tab=execution` after pulling merged main: the card renders
  after the codex app-server card and **loads its stored value** (checked/Enabled, the `setnx` default
  from piece 2); a **flip survives a reload** (unchecked after a full page load, fetched from the
  server rather than surviving in React state), with `GET /admin/config/agent-isolation` answering
  `200 {"enabled":false}` and then `{"enabled":true}` once restored — which is also the first
  end-to-end proof that the handler resolves `CONFIG_KEYS.AGENT_ISOLATION_ENABLED`, since the `401`
  an unauthenticated probe returns only shows the route is MOUNTED. The switch was restored to
  Enabled, so the install is on its default. **The third assertion — "the next dispatched invocation
  follows it" — is SUBSTITUTED, not met**: it needs a real CLI dispatch, and the stored-value
  round-trip is what `resolveTaskDispatch` reads rather than a watched invocation obeying it. Fold it
  into item 4's live check on the next run.

**Items 1 and 4 are PARKED on the next onboarding run and registered in
[[onboarding-run-checkpoints]]** — item 1 keyed to `07-generate-files` (agents on disk), item 4 to a
workflow task reaching `08c`. The user's call, 2026-09-21: they are doing a clean onboarding of a new
repo on main later, which several other checks are already queued against, so these ride with it
rather than being half-done against a synthetic fixture. Item 1 does not STRICTLY need a fresh
onboarding — hand-built stub agents would satisfy the letter of it — but capturing "what does the CLI
list" against three stubs proves much less than against a real generated set, and item 4 cannot be
done at all without an onboarded repo. Read the index at the start of that run, not this file.

**What each later piece carried**, for reading the history back: piece 3 the dispatch rule
(`agentIsolationApplies`, `promptNamesAgentPath`, the project-instruction scan, the persona reader,
the rewrite's positive arm, `LlmInvocationSpec.agentPool`, `07_7-secret-sweep` declaring `'*'`),
piece 4 the exec mask, piece 5 the switch surface and docs, piece 6 the recheck. The 3-versus-4 fold
was decided by SPLITTING, as the plan defaulted to.

`resolveInvocationWorkerTree` landed in piece 3, not piece 2, and the reason is worth keeping: it is
async (`db`, `taskId`, `worktreeRel`) and its only callers are the project-instruction and persona
paths, so putting it in the foundations commit would have added an unused function to the one commit
whose contract is that nothing reads the switch yet. Piece 3 was also the first CALLER of
`secretMaskDeniesPath`, which piece 2 shipped unused on purpose.

**CODEX IS REVIEWING AGAIN, and its findings on this series sat UNREAD on merged code.** Assumed out
of quota all session (the PR-workflow rule says land on CI alone when every reviewer is spent), it had
in fact reviewed #192-#196 and posted FIVE findings, two of them P1, on the INLINE surface that
`gh pr view` does not show — read `gh api repos/<o>/<r>/pulls/<n>/comments` plus `/reviews` plus
`/issues/<n>/comments`, or "nothing to fix" is unproven. #191, #195 and #196 carried none.

All five were CONFIRMED against the tree before any edit. **PR #198 fixed them and MERGED
(`b7625480`); main is green at `8ce572a1`, which also carries #199 and #200.** The loop took four
rounds and TWO of them found defects in my own fixes — the pattern is the lesson, not the individual
bugs: a fix written against a reviewer's description rather than against a reproduction is itself
unverified until its own red-to-green exists.

- Round 2 found that my stub-cleanup fix had opened a host-side DATA LOSS window (below).
- Round 3 found that my negation partition THREW on a lone `!` (below).
- Round 4 brought nothing — the first clean round, and the bar for merging.

Twice the remedy I shipped was NARROWER than the one proposed, on measured grounds: affirmative
provenance rather than stricter inode reasoning, and `|| '.'` rather than skipping the derived pattern
(`picomatch(['.'])` matches `.` alone, so skipping and emitting it are different verdicts). Two
follow-up PRs came out of the same review pass: **#199** corrected a status row that implied read-only
was sufficient for isolation, and **#200** landed two of verification item 2's three assertions.

The findings themselves:

- **P1, the instruction scan failed CLOSED — the inverse of its documented contract.**
  `agent-isolation.ts` called `readTextNoFollow` without `strict: true`, and `readResult` folds a
  containment refusal into `null`, which the next line reads as ABSENT. So a symlinked, non-regular or
  unreadable instruction file left isolation ENABLED while a CLI, which does follow that link, could
  be told to read a definition the mask then hid. AGENTS.md and the function's own comment both claim
  the opposite. `strict: true` is safe: ABSENT is answered before the flag is consulted, so a repo
  with no instruction file still isolates.
- **P2, the 1 MiB budget was counted in UTF-16 units** (`text.length`) against a byte cap, so a
  multibyte file read at `budget + 1` bytes measured under budget and was accepted as complete. Now
  `read.truncated || read.size > budget`.
- **P1, isolation was INERT for antigravity.** `resolveRepoMirrors` injects `.agents/agents` under
  `~/.gemini/config/agents`, which is where agy actually loads agents from — so masking the workspace
  dirs hid nothing. The filter lives IN `resolveRepoMirrors` behind `opts.maskAgentDefinitions`.
- **P2, the stub cleanup skipped the race it exists for**: `if (record.inode !== null) continue` with
  records emitted only for directories that exist, so the body was unreachable. Fixed in TWO steps,
  and the second is the lesson: an inode comparison alone (plus `runtimeUid` ownership and emptiness)
  opened a host-side DATA LOSS window, which Codex caught on its SECOND round — a root-owned
  local-path repository whose agent directory is legitimately recreated during the run has a new
  inode, is empty, and is owned by uid 0 exactly as a Docker stub is, and `/host-fs` is writable. The
  shipped guard therefore requires AFFIRMATIVE provenance: the container's uid must DIFFER from the
  repository tree's owner (read from the anchor, or injected), and when the two match or the owner
  cannot be read the directory is KEPT. Not inert in production — AGENTS.md's `prepareAgentWritableDir`
  note is the evidence that repository roots are uid-1000-owned — and correctly inert on exactly the
  root-owned local-path repo Codex named. See also [[inode-reuse-breaks-replaced-dir-tests]].
- **P2, negated globs diverged from the scanner.** `picomatch(array)` is an any-match where `!x`
  matches everything but `x`; tinyglobby 0.2.17 (`dist/index.mjs:185,189-190`) moves a negated DENY
  pattern into the ignore set and DISCARDS a negated ignore pattern, keeping `!(` as an extglob. The
  ignore side diverged the UNSAFE way. `partitionLikeTinyglobby` applies those rules first — and
  there are **FOUR**, not three: a lone `!` derives `''`, which **picomatch REFUSES**
  (`TypeError: Expected pattern to be a non-empty string`), while tinyglobby normalises it to `.`
  (`posix.normalize('') === '.'`, both executed). Codex's THIRD round caught that as a crash I had
  introduced: `'!'` survives the API's trim-and-filter, so an isolated dispatch evaluating a persona
  path threw on a config the scan accepts. The fix is `p.slice(1) || '.'` and NOT the proposed "skip
  empty patterns" — `picomatch(['.'])` matches `.` alone while dropping the entry matches nothing, so
  skipping stops the throw and restores the very disagreement the helper exists to remove.

Two process lessons from that PR. Running only the suites I touched let a contract test fail in CI
(`sandbox-repo-mirrors.test.ts` asserts `resolveRepoMirrors`'s ARGUMENTS and I added a fourth) — run
the whole package. And that same file disproved my reason for writing a source-grep guard: it already
drives `createSandboxSpawner` with two faked edges, so the guard was replaced by a real behavioural
assertion and deleted.

**VERIFICATION ITEM 2 IS COMPLETE as of PR #202** (`test/prompt-agent-path-tripwire`), which is the
third of its three assertions: with markers stripped the way `agentIsolationApplies` strips them, only
`06_5` and `09_5` match `promptNamesAgentPath`. The file is
`packages/worker/src/step-engine/steps/prompt-agent-paths.test.ts`, and what it grew into is worth
knowing before touching it:

- **168 prompt sources** across five dispatch paths — llm, loop (role x truncation-retry x history),
  mining, `MiningWaveError` waves, and the direct `resolveTaskDispatch` calls no registry step owns —
  plus the blocks the dispatcher splices in AFTER the decision.
- **The `named` list is an explicit array, not a snapshot**, and every entry is a deliberate decision
  with its reason in the file: `06_5` (its prose legitimately points at prior-setup agent files) and
  `09_5` in six variants (declares `file_write`, so isolation is excluded two conditions earlier).
- **Three sources remain unreachable and are asserted BY NAME**: `00-plan-sequence`,
  `02-plan-coverage`, `03-plan-sequence` all call `loadPlanSkeletons(ctx.db, …)` inside `selectAgents`,
  so they need a live database. By name rather than by count, because a count lets a new gap take a
  retiring one's slot.
- **`SCANNED_PROMPT_EXPORTS` is DERIVED from the sources that execute** (`PromptSource.exportKey`) and
  the audit asserts every claimed key belongs to a source that actually built. It was hand-written once
  and that made it unverified bookkeeping.
- **`threw` is asserted EMPTY, separately from "selected nothing"**. A guard refusing a fixture is a
  defect of the test; a mining step selecting no agent is honest. Collapsing them hid four real review
  prompts behind a tolerance.

**The loop that produced it ran 31 rounds, every one a real finding**, and the two lessons that
generalise beyond this file: **`permissive()` reaches only a builder's DEFAULT arm** (it fails strict
comparisons, its `length` is 0, its array stubs return `[]`, spreading it yields nothing) — six
consecutive findings were that one cause; and **an assertion written to BOUND a gap will hide it**
instead unless it names what it tolerates, which happened twice (the derived-export list, the
unbuildable tolerance). Also: a clean per-sha review is NOT a clean loop — audit review threads by
RESOLUTION state, because a truncated listing and GitHub's own replication lag each hid a live finding
for a round. See [[mcp-server-name-escapes-isolation-scan]] for the one PRODUCTION gap it turned up.

**How to apply.** Before building anything further here, re-check the plan against the tree — the last
re-verification found the `01b-install-plugins.ts` path had moved to `steps/workflow/` and
`AGENT_TOOLING_DIRS` had moved into `_scope-seed.ts`, and drift that size accumulated in under two
weeks. Surface the found-not-fixed item above in the PR that touches the exec mask, since that is
the change with standing to fix it. Related: [[found-not-fixed-running-list]] for the practice, and
[[haive-mcp-config-is-per-task-not-per-invocation]] for the neighbouring shelved constraint on the
same surface.
