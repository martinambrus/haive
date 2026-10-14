import { Hono } from 'hono';
import { count, eq, sql } from 'drizzle-orm';
import type { ZodError } from 'zod';
import { schema, type DbTx } from '@haive/database';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import {
  customToolArgsSchema,
  parsePinnedCustomSteps,
  type CustomTool,
  type RagQueryTool,
} from '@haive/shared/modularity';
import { formatRagHits } from '@haive/shared/rag';
import { verifyTaskToken } from '@haive/shared/task-token';
import { getDb, type Database } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
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
  | 'action-not-available'
  | 'action-failed';

interface CallClaims {
  taskId: string;
  taskStepId: string;
  cliInvocationId: string;
}

function claimsFromBearer(authHeader: string | undefined): CallClaims {
  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret) throw new HttpError(500, 'server misconfigured: CONFIG_ENCRYPTION_KEY unset');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const claims = token ? verifyTaskToken(token, 'custom-mcp', secret) : null;
  if (!claims?.taskStepId || !claims.cliInvocationId) {
    throw new HttpError(401, 'invalid or missing custom-mcp token');
  }
  return {
    taskId: claims.taskId,
    taskStepId: claims.taskStepId,
    cliInvocationId: claims.cliInvocationId,
  };
}

async function findInvocation(db: Database, invocationId: string) {
  const [row] = await db
    .select({
      taskId: schema.cliInvocations.taskId,
      taskStepId: schema.cliInvocations.taskStepId,
      endedAt: schema.cliInvocations.endedAt,
      supersededAt: schema.cliInvocations.supersededAt,
      stepId: schema.taskSteps.stepId,
      customSteps: schema.tasks.customSteps,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .leftJoin(schema.taskSteps, eq(schema.taskSteps.id, schema.cliInvocations.taskStepId))
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
function cutToBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes - Buffer.byteLength(TRUNCATED_MARK);
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString('utf8') + TRUNCATED_MARK;
}

async function ragQuery(tool: RagQueryTool, taskId: string, query: string): Promise<string> {
  const hits = await executeRagSearch(taskId, query, tool.topK);
  const own = tool.scope === 'project' ? 'local' : 'global';
  const kept = tool.scope === 'all' ? hits : hits.filter((hit) => hit.scope === own);
  return cutToBytes(kept.length > 0 ? formatRagHits(kept) : NO_RESULTS_TEXT, tool.maxResponseBytes);
}

// Sandbox-facing like /rag and /ddev: the bearer is a task token, not a user session.
export const customMcpRoutes = new Hono<AppEnv>();

customMcpRoutes.use('*', sandboxBodyLimit);

customMcpRoutes.post('/call', async (c) => {
  const startedAt = Date.now();
  const claims = claimsFromBearer(c.req.header('Authorization'));
  const body = (await c.req.json().catch(() => null)) as {
    tool?: unknown;
    arguments?: unknown;
  } | null;
  const db = getDb();

  const invocation = await findInvocation(db, claims.cliInvocationId);
  if (
    !invocation ||
    invocation.taskId !== claims.taskId ||
    invocation.taskStepId !== claims.taskStepId ||
    invocation.endedAt !== null ||
    invocation.supersededAt !== null
  ) {
    throw new HttpError(401, 'this invocation is not live', 'invocation-not-live');
  }

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
    outcome: 'ok' | 'error',
    reason: Reason | null,
    responseBytes: number | null,
  ) =>
    db
      .update(schema.customToolCalls)
      .set({ outcome, reason, responseBytes, durationMs: Date.now() - startedAt })
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
    return refuse(501, 'action-not-available', 'http-get tools are not available yet');
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
