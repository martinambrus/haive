# Agent rules

The task and dependency boundary is `TASK_SCOPE_RULES` in shared constants. It is part of
the default provider rules and the step-level repository-data guards, so a custom provider
persona or an old onboarded persona cannot opt out of it. The original task request reaches
spec correction, implementation, validation and code review. Review dimensions and a revised
spec cannot authorize extra work or override explicit constraints. A spec corrector reports
conflicts as `scopeQuestions`; gate 1 shows them, defaults to rejection and requires an answer.
The same default and required clarification apply when the reviewer directly reports
`BLOCKING_AMBIGUITY`, even without a corrector-generated question list.
An unresolved question must be rejected with clarification to regenerate and review the spec.
It cannot be approved merely by adding feedback: implementation and validators must share the
revised specification rather than reading different answers to the same question.
The sprint planner, every DAG coder and the DAG review/recovery dispatches receive the
original request too. Refuters carry the mandatory task boundary and original brief;
when an older review resumes, the second-wave dispatch reloads that brief from the task.
`hydrateTaskBrief` reloads a missing brief before spec review/correction, sprint planning,
implementation, validation and both code-review waves dispatch. The boundary therefore
also applies to forms and CLI waits parked before these detect fields existed.

Agents may read infrastructure as evidence, but never repair framework core or underlying
infrastructure. They report defects and their impact; a blocker requires a user decision.
Contrib and installed packages remain third-party unless ownership is established. A repair
is allowed only for a reproduced failure breaking the requested installation or behavior,
and must be delivered as a versioned package-manager-applied patch, tested from a clean
lockfile install. Speculative hardening and optional-feature defects are observations.
Edited upstream source and search-and-replace install hooks are never the deliverable.

**Every dispatch carries its provider's rules, whatever the checkout holds.** Onboarding writes
the merged `haive:cli-rules` block into AGENTS.md, but a workflow task runs in a worktree checked
out from HEAD, onboarding's commit defaults off, and an upgrade never re-committed the file —
MEASURED before this existed, 598 of 3,509 recorded invocations (17%) ran with the rules loaded,
and none since the last manual regeneration. So `buildCliSidePlan` puts the provider's effective
rules (`resolveEffectiveRules(provider.rulesContent)`, not the merged block) at the top of every
`kind: 'prompt'` dispatch through `withAgentRules` (`orchestrator/agent-rules.ts`). It is applied
LAST in `adaptPrompt`, so no capability or marker rewrite ever touches the operator's text, under
a framing line: the step's own instructions and output contract win where they differ, and the
block supersedes a differing AGENTS.md copy.

It is never skipped because the repository "already delivers" the rules, which was unsafe four
ways: the block written into every repository was damaged by the dedup bug until #232, codex reads
only the first 32 KiB of AGENTS.md, antigravity's native loading is unmeasured, and a block merged
from several providers never equals one provider's rules. The cost is a duplicate where the
repository copy also loads.

- **Only a block at position 0 is Haive's.** A stored prompt dispatched again has its block
  REPLACED with today's rules, and null rules strip a leading block, so a switched-off dispatch
  never keeps a stored one. The strip runs BEFORE the other adapters, because every one of them
  prepends: one that applies now but did not on the stored run (a model newly learned to lack
  vision) would otherwise bury the old block and leave two. The isolation scan reads the prompt
  with that block removed for the same reason. A marker anywhere else is text the prompt carries
  and can neither suppress nor replace the injection.
- **Unfenced**, because providers are per-user and edited by their owner: this is operator text.
- **Opt-outs** (`skipAgentRules`): the step recap, `01-env-detect` and the model-health canary,
  whose prompts carry their whole task and whose replies are parsed as they are. The sub-agent
  kinds, which no step builds, get no block.
- **`CONFIG_KEYS.AGENT_RULES_INJECTION_ENABLED`** (default on, Admin > CLI execution). ABSENT in
  the pure resolver means off, which keeps every direct `resolveDispatch` caller's prompt
  byte-identical; a failed read means off.
- **Never a new failure.** gemini takes its prompt only as an argument, so when the rules push a
  prompt that fits past `PROMPT_ARGV_LIMIT_BYTES` the dispatch is rebuilt without them and says so.
- **Recorded per run.** `spec.agentRules` (`{ hash, injected, reason? }`, the hash of the
  normalised effective rules, kept even when they were not injected) rides the job to exec and is
  written by the UPDATE that sets `started_at` into `cli_invocations.agent_rules` (migration 0166).
  NULL means not recorded: older rows, a run that never started, a sub-agent split.
