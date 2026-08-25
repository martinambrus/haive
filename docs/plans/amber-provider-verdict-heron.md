# Persistent provider-verdict banner below the CLI terminal

> Status: IN PROGRESS, started 2026-08-24. Approved.

## Why

Two provider outcomes are invisible in the CLI terminal today:

1. A provider REFUSING the prompt (content moderation). A refused codex QA seat shows only
   `exit 1`. The user cannot tell "the CLI is broken / not logged in" from "the provider
   declined this specific request". MEASURED: codex/gpt-5.6-sol on an 08d seat returns
   `{"type":"error","message":"This content was flagged for possible cybersecurity risk..."}`,
   exit 1, no other signal.
2. A provider silently SWAPPING the served model. MEASURED: Claude Code `--model fable` on a
   security-testing prompt is served `claude-opus-4-8` instead — exit 0, `api_error_status:
   null`, and it complies. Invisible everywhere except `cli_invocations.model_identity.match =
   'differs'`.

The banner sits BELOW the xterm and is driven by the invocation ROW, not the stream, so it
survives the CLI ending — the same principle as `packages/web/src/lib/step-banners.ts`
("gate on the column that proves the state, use the message only as the words in the banner").

## Data sources

- **Model swap**: `cli_invocations.model_identity` (jsonb `{requested, served, match}`) — ALREADY
  persisted per-invocation. Only needs exposing to the viewer. No schema change.
- **Refusal**: no structural signal today. `exec-core.ts` computes a `ProviderFatalClass`
  (`auth | rate_limit | server_error | content_filter`) and turns it into a prose headline in
  `error_message`, but the codebase forbids gating UI on a message column. So: add a nullable
  `cli_invocations.provider_fatal_class text`, stamped where the class is already computed.

## Steps

Ordered so the disruptive worker/db restart is one coordinated window, done while the
task-queue is GLOBAL_PAUSEd and in-flight CLIs have drained (NOT a BullMQ queue pause — that
wedges; see project_global_pause_drain_resume).

### Stage A — non-disruptive (web + types + files on disk)
- [ ] migration `0129_cli_invocation_fatal_class.sql`: `ADD COLUMN IF NOT EXISTS
      provider_fatal_class text` (additive, idempotent, no backfill, rollback = DROP COLUMN).
- [ ] `packages/database/src/schema/tasks.ts`: add the `providerFatalClass` column (inert until
      libs rebuild).
- [ ] `packages/web/src/lib/api-client.ts`: add `providerFatalClass?` and per-invocation
      `modelIdentity?` to `CliInvocationSummary` (optional → older api renders absent).
- [ ] `packages/web/src/components/terminal/cli-stream-status.ts` (new): pure
      `describeInvocationStatus(inv)` selector + unit test, mirroring `step-banners.ts`.
- [ ] `CliStreamViewer.tsx`: render `<StreamStatusBanner>` below the terminal from the selector.
- [ ] `StepTerminal.tsx`: pass the two new fields through to the viewer.

### Stage B — coordinated, during a drain
- [ ] GLOBAL_PAUSE on; wait started-not-ended invocations = 0.
- [ ] `steps.ts`: add `providerFatalClass` + `modelIdentity` to the invocations SELECT + shape.
- [ ] `exec-core.ts`: stamp `providerFatalClass` on the failed invocation row where `fatalClass`
      is already computed.
- [ ] apply migration, then `pnpm docker libs` (rebuild shared+db, restart worker+api).
- [ ] GLOBAL_PAUSE off; verify.

## Copy
- content_filter: "The provider refused this request (content policy). This is not a CLI
  failure — a retry would be refused the same way."
- model swap (bold amber): "Provider served `{served}` for a request for `{requested}`."

## Rollback
Additive column (DROP COLUMN IF EXISTS), behaviour-only worker/api/web (git revert). Nothing
gates on the column; a code revert that leaves the column is harmless.

## Verify
- `describeInvocationStatus` unit test: content_filter row → refusal copy; match:differs →
  swap copy; clean row → null; both present → refusal wins (a refused run has no served model).
- Live: a refused codex 08d seat shows the refusal banner; a Fable-swap invocation shows the
  swap banner; a normal invocation shows nothing.
