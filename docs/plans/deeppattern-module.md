# DeepPattern review: a public Haive module

> **Not implemented; planned 2026-11-14.** Phase 0 decides whether this is built at all. If it is,
> it becomes Haive's first public external module and the end-to-end test of installing one.

## Context

DeepPattern (deeppattern.ai) was assessed on 2026-11-11 on the owner's free invite. Nothing was built.

- **AQG** is a set of local MIT skills, hooks and rule blocks for interactive desktop agents. Skip it:
  it duplicates Haive's deterministic gates.
- **DE (Decision Engine)** is a hosted, cross-vendor review panel. Its server is closed; the GitHub
  repositories `deeppatternai/decision-engine` and `agent-quality-gates` hold squashed client
  snapshots only. It is an invite-only preview with no SLA.

DE could sit beside Haive's review steps as an independent second reader. It sees only the text it is
sent, so it is added beside 08c (code review), never in place of it.

Haive has internal modules (`modules/statistics`, in this repository) and private external modules
(translator and deep-analysis, in private repositories since T669). It has no public external module.
Shipping DE as one tests that path: a public repository, installed into a stock Haive.

## DE interface (as measured 2026-11-11)

Remote MCP endpoint: `https://endpoint.deeppattern.ai/plugin/mcp/v1/audit`. An unauthenticated
`initialize` and `tools/list` work. It answers plain JSON with no session id.

- `audit_skill_submit(idempotency_key, title<=200, content, tier: fast|standard|deep, context?, focus?, domain?, stakes?, artifact_intent?)`
- `audit_skill_status(task_id, wait_seconds<=25)`
- `audit_skill_result(task_id)` returns `json` (an untyped object) and `markdown`
- `audit_skill_events(task_id)`

Limits: about 480 KB of content for fast/standard, about 240 KB for deep. A deep run takes 15-30 min.
One idempotency key gives one task and at most one charge.

Auth: OAuth 2.1 with a public PKCE client (token auth method `none`). CIMD is supported; DCR and
userinfo are not. The client id `deep-pattern-audit-harness` is preregistered for DeepSeek Harness;
do not reuse it. A legacy device route also exists: `POST /v1/devices/activate` returns a bearer
token, then `POST /mcp`.

Re-measure all of this in Phase 0: it is a preview and may have changed.

## Phase 0: value test, outside Haive (decides go or no-go)

1. Install the Claude Code plugin `audit@deeppattern-plugins` and run DE on 5-10 real Haive diffs
   that already passed 08c, plus 2-3 with known escaped bugs (pick from the board's REGRESSION items).
2. Record per diff: tier, wall time, cost, findings, and for each finding whether it is new versus
   08c's review, a duplicate, or wrong.
3. **Go** if DE finds at least one consequential issue 08c missed across the set, at a cost and
   latency a review step can carry (a fast/standard tier within the step's timeout). **No-go**
   otherwise: record the numbers here and park the plan.

## Design (only after a go)

### Module shape

- A public GitHub repository, `martinambrus/haive-module-deeppattern`, package
  `@haive-module/deeppattern`, licensed for public use.
- `./manifest` declares the module, one integration provider (DeepPattern account, OAuth) and one
  composable step.
- `./steps` contributes `08c-deeppattern-review`: it submits the same diff and scope 08c reviews,
  waits through `audit_skill_status` with the step's cancel contract (`throwIfCancelled` in the
  poll loop), and stores the result's `markdown` as the step's report. Its findings are report-only;
  gate 2 shows them beside 08c's, and they do not block on their own.
- The idempotency key derives from task, step, round and diff hash, so a retry or a worker restart
  never pays twice.
- Content above the tier's limit is not truncated silently: the step either sends the bounded
  changed-files scope (the 08c collector's) or reports "too large for DE" and passes.
- Every value DE returns is untrusted text: render it through `MarkdownView` and keep it out of any
  later agent prompt unless fenced as data (see Prompt containment).

### Prerequisites in core

Re-check each against the code at start; these were true on 2026-11-11.

1. **Step SDK seam.** `./steps` is a recognised module export, but a module step needs the step
   types and helpers without importing `@haive/worker` (which has no package exports). The same seam
   is a prerequisite of the deep-analysis module (`kind-riding-dream.md`); build it once, for both.
2. **Integration sign-in.** Haive's integration OAuth expects a preregistered client with a secret
   and a userinfo endpoint; `cimd` exists only in the schema enum (`clientRegistration` in
   `@haive/shared` `modularity/integrations.ts`). DE needs a public PKCE client registered through
   CIMD, with no userinfo. Either implement the CIMD path generally or use DE's device route as the
   first auth mode.
3. **Composable placement.** 08c2, 04a, 08d and 09 are not in `CORE_COMPOSABLE_STEPS`, and gate 2
   reads 08c2 by id. The module step must be placeable after 08c and shown at gate 2 by a generic
   mechanism, not a new hard-coded id.

### Public module distribution (the second purpose)

This module exercises the public install paths end to end, which no module has yet:

- **Source checkout:** clone into `external-modules/deeppattern/`, `pnpm module add deeppattern`,
  rebuild; the tracked tree stays clean (T669, #1179).
- **Published-image install:** add the public repository as a git install source on the admin
  Modules page (no token), fetch, upgrade.
- **Registry:** `pnpm module add @haive-module/deeppattern@<version>`. GitHub Packages requires a
  token to install npm packages even when they are public; confirm, and decide whether a public
  module also publishes to npmjs.
- **Public module list:** decide whether a public external module is listed in `public-modules.json`
  (the guard then lets tracked wiring name it) or stays unlisted like a private one. Record the rule
  in [Modules](../architecture/modules.md).
- A module CI template (T669 item 4) builds and tests the module against a pinned Haive release tag.

## Phases

0. Value test outside Haive (above). Stop on a no-go.
1. Core prerequisites 1-3, each its own PR, shared with deep-analysis where they overlap.
2. The module repository, with its CI on the T669 template, and the step behind an off-by-default
   switch.
3. Install it each of the three ways above on a throwaway install, and fix what breaks in core.
4. Live check: a workflow task with the step on reaches gate 2 with DE's report beside 08c's, a
   retry does not create a second DE task, and a cancel stops the poll.

## Rollback

The module is optional and off by default. Rolling back is `pnpm module remove deeppattern` (or
removing the install source) and a rebuild. Core prerequisite PRs are reverted one by one; the step
SDK seam stays if deep-analysis already uses it.

## Open questions for the owner

- Pricing: who pays for DE runs (the instance owner's DE account), and is a per-task cost cap needed?
- Is DE's invite-only preview with no SLA acceptable for a public module, or does it wait for
  general availability?
