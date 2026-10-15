import { Hono } from 'hono';
import { count, eq, sql } from 'drizzle-orm';
import type { ZodError } from 'zod';
import { schema, type DbTx } from '@haive/database';
import { CONFIG_KEYS, configService, effectiveNetworkPolicy, logger } from '@haive/shared';
import {
  customToolArgsSchema,
  customToolUrl,
  parsePinnedCustomSteps,
  validateCustomTool,
  type CustomTool,
  type RagQueryTool,
} from '@haive/shared/modularity';
import { formatRagHits } from '@haive/shared/rag';
import { getDb, type Database } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import {
  EgressGuardError,
  guardedGet,
  type GuardReason,
  type GuardedResponse,
} from '../lib/egress-guard.js';
import { assertInvocationLive, claimsFromBearer } from '../lib/task-call-auth.js';
import { sandboxBodyLimit } from '../middleware/sandbox-body-limit.js';
import { executeRagSearch } from './rag.js';

const log = logger.child({ module: 'custom-mcp-routes' });

const CALL_BUDGET = 50;
const NO_RESULTS_TEXT = 'No results.';
const TRUNCATED_MARK = '\n[truncated]';
const ISSUE_MAX_LENGTH = 200;

type Reason =
  | 'undeclared-tool'
  | 'switched-off'
  | 'invalid-arguments'
  | 'tool-invalid'
  | 'egress-restricted'
  | 'action-failed'
  | GuardReason;

// What the agent is told, never the cause: that can name an address inside the compose network.
const GUARD_FAILURES: Record<
  GuardReason,
  { status: number; outcome: 'refused' | 'error'; message: string }
> = {
  'blocked-address': {
    status: 403,
    outcome: 'refused',
    message: 'that address is not reachable from here',
  },
  'redirect-not-followed': {
    status: 502,
    outcome: 'error',
    message: 'the server answered with a redirect, which tools do not follow',
  },
  'encoding-not-supported': {
    status: 502,
    outcome: 'error',
    message: 'the server compressed its answer, which tools cannot read',
  },
  'content-type-not-allowed': {
    status: 502,
    outcome: 'error',
    message: 'the server answered with a content type that tools do not read (text, JSON and XML)',
  },
  'request-timeout': {
    status: 504,
    outcome: 'error',
    message: 'the server did not answer in time',
  },
  'request-failed': {
    status: 502,
    outcome: 'error',
    message: 'the request could not be completed',
  },
};

async function findInvocation(db: Database, invocationId: string) {
  const [row] = await db
    .select({
      taskId: schema.cliInvocations.taskId,
      taskStepId: schema.cliInvocations.taskStepId,
      endedAt: schema.cliInvocations.endedAt,
      supersededAt: schema.cliInvocations.supersededAt,
      stepId: schema.taskSteps.stepId,
      customSteps: schema.tasks.customSteps,
      taskMetadata: schema.tasks.metadata,
      providerPolicy: schema.cliProviders.networkPolicy,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .leftJoin(schema.taskSteps, eq(schema.taskSteps.id, schema.cliInvocations.taskStepId))
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(eq(schema.cliInvocations.id, invocationId))
    .limit(1);
  return row;
}

async function callsMade(db: DbTx, invocationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.customToolCalls)
    .where(eq(schema.customToolCalls.cliInvocationId, invocationId));
  return row?.n ?? 0;
}

function describeIssue(error: ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return `invalid arguments: ${where}${issue?.message ?? 'not accepted'}`.slice(
    0,
    ISSUE_MAX_LENGTH,
  );
}

/** At most `maxBytes` of UTF-8, marked as cut, never ending inside a character. */
function cutToBytes(text: string, maxBytes: number, alreadyCut = false): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes && !alreadyCut) return text;
  let end = Math.min(bytes.length, maxBytes - Buffer.byteLength(TRUNCATED_MARK));
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString('utf8') + TRUNCATED_MARK;
}

function httpGetText(response: GuardedResponse, maxBytes: number): string {
  const body = new TextDecoder().decode(response.body, { stream: response.truncated });
  const head = `HTTP ${response.status} ${response.contentType}, ${response.body.length} bytes\n`;
  return cutToBytes(head + body, maxBytes, response.truncated);
}

async function ragQuery(tool: RagQueryTool, taskId: string, query: string): Promise<string> {
  const scope = tool.scope === 'project' ? 'local' : tool.scope;
  const hits = await executeRagSearch(taskId, query, tool.topK, scope);
  return cutToBytes(hits.length > 0 ? formatRagHits(hits) : NO_RESULTS_TEXT, tool.maxResponseBytes);
}

// Sandbox-facing like /rag and /ddev: the bearer is a task token, not a user session.
export const customMcpRoutes = new Hono<AppEnv>();

customMcpRoutes.use('*', sandboxBodyLimit);

customMcpRoutes.post('/call', async (c) => {
  const startedAt = Date.now();
  const claims = claimsFromBearer(c.req.header('Authorization'), 'custom-mcp');
  const body = (await c.req.json().catch(() => null)) as {
    tool?: unknown;
    arguments?: unknown;
  } | null;
  const db = getDb();

  const invocation = await findInvocation(db, claims.cliInvocationId);
  assertInvocationLive(invocation, claims);

  // Empty until a declared tool is found: a name the agent chose is never stored.
  let tool: CustomTool | undefined;
  // A row is a claim: written under the invocation's lock, and only below the budget.
  const claim = async (outcome: 'running' | 'refused', reason: Reason | null): Promise<string> => {
    const id = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`custom-mcp-budget:${claims.cliInvocationId}`}, 0))`,
      );
      if ((await callsMade(tx, claims.cliInvocationId)) >= CALL_BUDGET) return null;
      const [row] = await tx
        .insert(schema.customToolCalls)
        .values({
          taskId: invocation.taskId,
          taskStepId: invocation.taskStepId,
          cliInvocationId: claims.cliInvocationId,
          stepId: invocation.stepId ?? '',
          tool: tool?.name ?? '',
          action: tool?.action ?? '',
          outcome,
          reason,
          durationMs: Date.now() - startedAt,
        })
        .returning({ id: schema.customToolCalls.id });
      return row!.id;
    });
    if (id === null) {
      const message = `this invocation has used its ${CALL_BUDGET} tool calls`;
      throw new HttpError(429, message, 'budget-spent');
    }
    return id;
  };
  const refuse = async (status: number, reason: Reason, message: string): Promise<never> => {
    await claim('refused', reason);
    throw new HttpError(status, message, reason);
  };
  const finish = (
    id: string,
    outcome: 'ok' | 'refused' | 'error',
    reason: Reason | null,
    responseBytes: number | null,
    httpStatus: number | null = null,
  ) =>
    db
      .update(schema.customToolCalls)
      .set({ outcome, reason, responseBytes, httpStatus, durationMs: Date.now() - startedAt })
      .where(eq(schema.customToolCalls.id, id));

  const name = typeof body?.tool === 'string' ? body.tool : '';
  const pinned =
    invocation.stepId === null
      ? undefined
      : parsePinnedCustomSteps(invocation.customSteps)[invocation.stepId];
  tool = pinned?.tools.find((declared) => declared.name === name);
  if (!tool) return refuse(403, 'undeclared-tool', 'this step does not declare that tool');

  if (!(await configService.getBoolean(CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED, true))) {
    return refuse(403, 'switched-off', 'custom tools are switched off on this install');
  }

  const args = customToolArgsSchema(tool).safeParse(body?.arguments ?? {});
  if (!args.success) return refuse(400, 'invalid-arguments', describeIssue(args.error));

  if (tool.action === 'http-get') {
    // requiresRepository only matters to the scope of a rag-query tool.
    const problems = validateCustomTool(tool, { requiresRepository: true });
    if (problems.length > 0) {
      const kinds = problems.map((problem) => problem.kind);
      log.warn(
        { taskId: invocation.taskId, tool: tool.name, kinds },
        'a pinned http-get tool failed its checks',
      );
      return refuse(403, 'tool-invalid', 'this tool is not valid on this install');
    }
    const target = customToolUrl(tool, args.data);
    if (!target.ok) {
      return refuse(
        400,
        'invalid-arguments',
        `invalid arguments: ${target.message}`.slice(0, ISSUE_MAX_LENGTH),
      );
    }
    if (
      effectiveNetworkPolicy(invocation.taskMetadata, invocation.providerPolicy)?.mode !== 'full'
    ) {
      return refuse(
        403,
        'egress-restricted',
        'this task has no full internet access, so http-get tools cannot run',
      );
    }

    const callId = await claim('running', null);
    let response: GuardedResponse;
    try {
      response = await guardedGet(target.url, {
        timeoutMs: tool.timeoutMs,
        maxBytes: tool.maxResponseBytes,
      });
    } catch (err) {
      if (!(err instanceof EgressGuardError)) {
        log.error({ err, taskId: invocation.taskId, tool: tool.name }, 'custom tool failed');
        await finish(callId, 'error', 'action-failed', null);
        throw new HttpError(500, 'the tool failed', 'action-failed');
      }
      log.warn(
        { err, taskId: invocation.taskId, tool: tool.name },
        'custom tool request not completed',
      );
      const failure = GUARD_FAILURES[err.reason];
      await finish(callId, failure.outcome, err.reason, null, err.httpStatus);
      throw new HttpError(failure.status, failure.message, err.reason);
    }
    const text = httpGetText(response, tool.maxResponseBytes);
    await finish(callId, 'ok', null, Buffer.byteLength(text), response.status);
    return c.json({ ok: true, text });
  }

  const query = String(args.data.query).trim();
  if (query === '') return refuse(400, 'invalid-arguments', 'invalid arguments: query is blank');

  const callId = await claim('running', null);
  let text: string;
  try {
    text = await ragQuery(tool, invocation.taskId, query);
  } catch (err) {
    log.error({ err, taskId: invocation.taskId, tool: tool.name }, 'custom tool failed');
    await finish(callId, 'error', 'action-failed', null);
    throw new HttpError(500, 'the tool failed', 'action-failed');
  }
  await finish(callId, 'ok', null, Buffer.byteLength(text));
  return c.json({ ok: true, text });
});
