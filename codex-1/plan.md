# RAG invocation attribution

- Security change. Current path: `rag_search` in `rag-mcp-server.ts` sends
  `RAG_TASK_TOKEN` to POST `/rag/search`; `logRagQuery` records task-only telemetry.
- `resolveMcpSurface` signs a task-only `rag` bearer. It cannot prove an invocation,
  including when concurrent agents share a task. Never infer identity from time.
- The existing `v1` task token already supports authenticated `taskStepId` and
  `cliInvocationId` claims, used by custom tools and integrations. No new token
  type, audience, route or tool argument is needed; the brief's stop condition
  does not apply.
- Reuse those claims when materializing RAG for an execution payload. Mount the
  bearer as one run-private read-only file beside the MCP script, using the
  existing extra-file mechanism. The proxy reads this before its legacy env.
  Keep only the task-scoped bearer in shared MCP configuration: an invocation
  token there could be overwritten/read by a sibling using volume-backed config.
- Before retrieval, the API checks the signed invocation's id, task and step
  against the database, the step's task ownership, a non-null start, and null
  ended/superseded timestamps. Unknown or inactive proof leaves attribution NULL
  without refusing a valid task's search. Invalid MAC/audience/expiry remains 401.
- Append nullable `cli_invocation_id` LAST in Drizzle's `rag_query_log`, referencing
  `cli_invocations` with SET NULL on delete. Add guarded migration 0247; old rows,
  shared task tokens and missing steps explicitly mean unknown (NULL). No backfill.
- Controls before implementation on unchanged origin/main: forged body identity,
  A credential versus B body identity, invalid ownership/liveness, distinct fan-out
  credentials, and historical NULLs. Verify actual proxy file precedence too.
- Run focused red/green controls, schema parity and idempotency on a disposable
  Postgres 18, sequential typechecks, and full api/worker/database suites with
  at most two Vitest workers. Documentation changes are delivered only as
  `codex-1/docs.patch`. Revert code to roll back; the additive column stays.
