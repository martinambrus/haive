# Typed step ports: roles in addition to step ids

> Status: approved 2026-11-15; PR1 and PR2 merged; PR3 implements universal v3 per-consumer data-edge pins and its first review fixes. PR4 remains pending. Builds on the review/audit roles from #1211.

## Context

How steps communicate today:

1. **Order.** Requires/provides tokens and `validateComposition` decide where a step may sit. They do not say which output feeds which input.
2. **Data.** Steps pull each other's output by hard-coded step id:
   - core steps call `loadPreviousStepOutput(db, taskId, '<id>')` (132 call sites, 46 selectors);
   - prompt steps quote `{{step:<id>}}`;
   - module steps call `ctx.host.loadPreviousStepOutput(stepId)`.
3. **Typed ports.** Only review and audit have them (`STEP_ROLES`, output contracts, v2 `roleBindings`, #1211). A module step can fill those two seats only because the contract and the pin are hard-coded for exactly those two (`output-contracts.ts:15`, `run-list.ts:116`).

The goal, Yahoo Pipes style: a step declares named outputs (ports) with a contract. Another step declares inputs by role, not by step id. Any producer that meets the contract can feed that input. The editor shows the edges and refuses a dangling input.

Evidence base:
- Codex analysis at #1211's head: `.claude/tmp/codex-run/ROLE-S/codex-1/design.md`, plus `edge-index.md`, a full inventory of every edge.
- I checked the decisive claims in the code myself:
  - the two-role hard-coding, `output-contracts.ts:15-34`;
  - the review-else-audit policy branch, `run-list.ts:95-160`;
  - prompt quotes read the newest *done* row, `prompt-step.ts:232`;
  - the spec is a 05a -> 05 -> 04 precedence chain, `_spec-artifact.ts:45`;
  - the discovery reads, `03b:84` and `04:378`.

## Design (what changes)

**1. Ports carry data only. Control stays with the host.**
- A role grants no loop, skip, shouldRun override, closing, commit, root, database, seat or persona power.
- Review and audit keep their existing host policy adapters (`assertPinnedProducerSupport`).
- New roles never pass through that branch.
- The fix loop still targets only 07. Gate revise targets stay physical.

**2. Role registry.** It replaces the two-value branches with a frozen, host-owned table:
- `{ id, contract:{id,version}, cardinality:'one'|'many', authorship:'agent'|'human'|'host'|'mixed', quoteProjection?, legacyStepId? }`.
- Contracts are exact id+version, and validation is data only. Modules cannot assert compatibility.
- `haive.code-review@1` and `haive.code-audit@1` stay as aliases, so old pins decode byte for byte.

**3. Declarations.** Steps get two arrays:
- `providesRoles: [{ role, contract, projection }]`
- `consumesRoles: [{ input, role, contract, optional }]`

These go on core composable entries, module manifests (boot parity check as today) and prompt steps. A prompt step can only *provide* a role through a new host-parsed structured-output mode; raw replies stay raw. Requires/provides tokens remain for effects and control (repository, clean-tree, commit, loop targets).

**4. Reading.** Three entry points:
- core steps use `readRole(ctx, input)`;
- modules get `ctx.host.loadRoleOutput(input)`;
- prompts get an own-line `{{role:<id>}}` token.

The result is a discriminated value: `ready` (typed data plus producer row, step id, round and contract), `absent`, `unselected`, `not-ready` or `invalid`.
- A required input that cannot be read fails before dispatch, with its name in the error.
- An optional input falls back exactly as today.
- New edges take the newest row at or below the current round *before* checking status, so a reset never shows stale success.
- Existing `{{step:}}` semantics stay unchanged.

**5. Human output is never quoted as agent text.**
- `{{role:}}` accepts only roles whose quote projection is agent-only.
- Human and mixed roles (gate decisions, run config, spec with user edits) are reachable only through explicit host adapters. Those keep operator words authoritative and fence the agent attachments (prompt-containment.md:84).

**6. Pins: each consumer binds to one producer, frozen at task creation.**
- A new v3 plan is stored in a new nullable task column, appended LAST. It works for static admin types, module seeds and derived types. v1 and v2 stay frozen.
- At INSERT it records:
  - each consumer input -> the exact producer step and contract version;
  - the absent optional inputs;
  - a fingerprint of all of the above.
- Retry, Resume, boot, dead revive and definition edits never remap a binding.
- Old tasks keep their canonical physical reads. Nothing is backfilled.
- The binding is per consumer, not per role. 05 reads the 04 draft while 07 reads the effective spec, and one global map cannot express that.

**7. Edge validation**, shared by the editor, the API and admission:
- each required input needs exactly one earlier producer with a compatible contract;
- if exactly one producer qualifies, it is wired automatically and then pinned;
- if several qualify, the editor asks the author to choose;
- if none qualifies, the input is dangling and save is refused;
- a missing optional input is only a warning;
- each derived candidate path is validated on its own.

**8. Editor: a node canvas.** Owner decision (2026-11-15).
- Steps are nodes laid out in run order, with input ports on the left and output ports on the right.
- Each port shows its contract, version, authorship and whether it is required or optional.
- Edges are drawn from the bindings. Selecting a port highlights its consumers.
- Dragging an edge onto an ambiguous input picks its producer. A dangling required input shows red, and save is refused.
- Reordering by drag still runs the shared `validateComposition` order checks.
- The ordered list stays as the keyboard/accessible view of the same draft, and save, preview and conflict rules are shared.
- Library: `@xyflow/react` (MIT, React 19 compatible), pinned exactly. Graph state is only a view of the serialized per-consumer bindings, never a second store.
- Task history shows the pinned edges as a read-only canvas.

**9. What stays a physical step-id read:**
- approved gate forms and their revise targets;
- the worktree, terminal and runtime readiness;
- receipts, upgrade rollback, cleanup and PR side effects, provenance;
- own-step replay and prior-form reuse;
- historical migrations, events and telemetry identity;
- the insight inventory, which is a historical service and not a current-run port.

Report and context consumers are what this migrates.

## PRs (smallest first, each shippable alone)

1. **Registry + spec chain (xhigh: shared pinned decoding, spec authority).**
   - A generic frozen registry, with the v1/v2 decoders byte-equivalent and review/audit kept as aliases.
   - Stage roles `haive.spec.draft@1` (04), `haive.spec.checked@1` (05) and `haive.spec.resolved@1` (05a), all mixed authorship and quoting off.
   - A host adapter `effective-spec` with an explicit ordered list: resolved > checked > draft, then ''.
   - `resolveApprovedSpec` (feeding about 10 consumers), the house-rules spec SQL, gate 1, 05 and 05a move to role reads with canonical resolution only.
   - Behaviour is unchanged.
   - Controls:
     - 04 -> 05 -> 05a precedence;
     - an intentionally empty spec versus a missing one;
     - optional stages skipped; the no-spec quick path;
     - a Retry that clears an upstream stage; round ceilings;
     - existing role, contract and derived fixtures unchanged;
     - old plans still refuse unknown bindings;
     - the spec is never quotable through a generic token.
2. **Canvas, read-only (high; web + one api projection).**
   - An api projection of the declared ports and edges for a draft or a type.
   - The canvas view in the static and derived composers and in task history. It shows the spec chain, review and audit edges, and dangling or ambiguous inputs from the shared validator.
   - Order editing works by drag, through the existing order checks. The list view stays.
   - Controls:
     - the canvas and list views produce the same draft and conflict behaviour;
     - drag-reorder refused when a token is violated;
     - SSR-safe (no window access in render);
     - the library's inline styles pass the app's CSP (markdown-rendering.md). If they do not, stop and raise it before any CSP change.
   - Browser check through the real web origin.
3. **Universal v3 data-edge pins (xhigh: pins, recovery, concurrency).**
   - Migration: one nullable task column, appended last.
   - The v3 writer runs at locked INSERT for static, module-seed and derived tasks; the v3 reader backs `readRole`.
   - Controls:
     - a definition or catalog edit between preflight and INSERT;
     - a module deactivation race;
     - malformed or missing pin, unselected candidate, contract removed after creation;
     - step Retry, full Retry, Stop/Resume, duplicate advance, boot and dead revive;
     - static versus module-seed parity;
     - a refused admission writes no task, event or job.
4. **Module, SDK and prompt ports, plus canvas binding (xhigh: security and authority).**
   - `ctx.host.loadRoleOutput`; manifest and seed declarations; `{{role:}}` tokens.
   - The structured prompt-output mode, with producer validation.
   - Dragging an edge on the canvas binds an ambiguous input.
   - A module can then provide `spec.checked`, for example as an alternative spec checker, and the author wires it on the canvas.
   - Controls:
     - task, user, step, round and cancellation binding;
     - a data role inherits no review/audit policy;
     - a version mismatch is refused;
     - tokens: own-line, single pass, caps, forged persona;
     - human/mixed quoting refused, including passthrough fields;
     - an invalid structured reply fails the producer and never enters the 07 fix loop;
     - seed ownership and resync no-op.
5. **Discovery, requirements and implementation summary (high, split as needed).**
   - `haive.discovery@1`, `requirements.draft` and `.humanized` with their adapter, and the implementation summary (07 or DAG, normalized by the host).
6. **Checks and advisory results (xhigh: approval and loops).**
   - Validation, verify, test management, browser and QA become roles. The D/I metadata they read today moves into the contract.
   - Gate 2, learning, house rules and history read them by role.
   - Not run, incomplete, failed and manual checklist stay distinct.
   - Fix, restart, cap and closing stay with the host.
7. **Optional, later:** many-valued review-lens fan-in with a host aggregate, and onboarding context DTOs. Each only when a concrete consumer needs it.

## Decisions

Owner decisions 2026-11-15:
- **A. Ports carry data only.** Control extensibility for run config, triage, implementation, gates and commit is a separate design later.
- **B. The spec is a chain of stage roles plus an explicit effective-spec adapter.**
- **E. A node canvas from the first UI PR.**
- **First port: the spec chain.**

Settled by existing invariants (task-types.md:40, :454):
- **C.** Exactly one eligible producer is wired automatically. When several qualify, the author chooses on the canvas. Either way it is pinned at creation and never remapped.
- **D.** No backfill. Only new tasks get v3 edges.

## Rollback

- **PR1:** revert. v1/v2 support is untouched.
- **PR2 to PR5:** stop creating new v3 pins or declarations first. Keep v3-capable readers and workers running while any v3 task can still resume. The column stays, since it is nullable and older code ignores it. Never regenerate or downgrade a pin, and never edit an applied migration.
- **PR2 canvas:** reverts on its own. The list view and the serialized bindings stay.

## Execution

- Codex driver at high effort, one worktree per PR. A Sonnet reviewer reviews at the effort each PR names.
- PR1 starts once #1211 merges. It touches shared contracts, the spec readers and gate 1, none of which the insight series touches, so the two series run in parallel. PR3 waits for the insight loop's routing PR (INS3b), because both touch task admission and recovery.
- Each PR goes through bots and CI and merges when the stack is idle. The full suite runs at the feature end.
- Before PR3, export the persisted admin prompt templates read-only to count real `{{step:}}` edges. The analysis could not see database templates.

## Verification

- Every PR's controls fail on its parent first.
- PR2: a browser check of the canvas through the web origin, showing the spec-chain, review and audit edges plus one dangling input.
- PR4 end: a throwaway module providing `haive.spec.checked@1`, wired on the canvas in a static admin type. One task runs with the module's output feeding gate 1 and 07, then a definition edit plus Retry shows the binding has not moved.
