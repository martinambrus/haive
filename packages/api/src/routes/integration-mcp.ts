import { Hono } from 'hono';
import { count, eq, inArray, sql } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import { logger } from '@haive/shared';
import {
  ForgeAuthError,
  ForgeConflictError,
  ForgeError,
  ForgeNotFoundError,
  ForgeRateLimitError,
  apiBaseFits,
  credentialApiHost,
  credentialUsableForPr,
  isForgeProviderName,
  parseRemote,
  resolveForgeProvider,
  validateForgeOpArgs,
  type ForgeContext,
  type ForgeProvider,
} from '@haive/shared/forge';
import {
  ConnectionNotFoundError,
  CredentialProviderMismatchError,
  IntegrationToolNameError,
  NeedsReauthError,
  getConnectionCredential,
  getIntegrationProvider,
  integrationTools,
  isProviderEnabled,
  parseIntegrationBindings,
  type ConnectionCredential,
  type IntegrationBinding,
  type IntegrationTool,
} from '@haive/shared/integrations';
import { getDb, type Database } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import {
  INTEGRATION_CALL_BUDGET,
  INTEGRATION_CALL_DEADLINE_MS,
} from '../lib/integration-call-limits.js';
import {
  assertInvocationLive,
  claimsFromBearer,
  type TaskCallClaims,
} from '../lib/task-call-auth.js';
import { sandboxBodyLimit } from '../middleware/sandbox-body-limit.js';

const log = logger.child({ module: 'integration-mcp-routes' });

const ERROR_TEXT_MAX_LENGTH = 400;
const REDACTED = '[redacted]';

type Reason =
  | 'provider-unavailable'
  | 'connection-unavailable'
  | 'write-switched-off'
  | 'invalid-arguments'
  | 'no-remote'
  | 'connection-not-for-repository'
  | 'unsafe-api-base'
  | 'timeout'
  | 'vendor-auth'
  | 'vendor-not-found'
  | 'vendor-conflict'
  | 'vendor-rate-limited'
  | 'vendor-error'
  | 'internal-error';

type Connection = {
  id: string;
  providerId: string;
  scope: 'user' | 'shared';
  ownerUserId: string;
  status: string;
  writeEnabled: boolean;
};

type BoundOperation =
  | { ok: true; run: (provider: ForgeProvider, ctx: ForgeContext) => Promise<unknown> }
  | { ok: false; error: string };

async function findInvocation(db: Database, invocationId: string) {
  const [row] = await db
    .select({
      taskId: schema.cliInvocations.taskId,
      taskStepId: schema.cliInvocations.taskStepId,
      endedAt: schema.cliInvocations.endedAt,
      supersededAt: schema.cliInvocations.supersededAt,
      stamp: schema.cliInvocations.integrations,
      ownerId: schema.tasks.userId,
      remoteUrl: schema.repositories.remoteUrl,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.cliInvocations.taskId))
    .leftJoin(schema.repositories, eq(schema.repositories.id, schema.tasks.repositoryId))
    .where(eq(schema.cliInvocations.id, invocationId))
    .limit(1);
  return row;
}

async function loadConnections(
  db: Database,
  bindings: readonly IntegrationBinding[],
): Promise<Map<string, Connection>> {
  if (bindings.length === 0) return new Map();
  const rows = await db
    .select({
      id: schema.integrationConnections.id,
      providerId: schema.integrationConnections.providerId,
      scope: schema.integrationConnections.scope,
      ownerUserId: schema.integrationConnections.ownerUserId,
      status: schema.integrationConnections.status,
      writeEnabled: schema.integrationConnections.writeEnabled,
    })
    .from(schema.integrationConnections)
    .where(
      inArray(
        schema.integrationConnections.id,
        bindings.map((binding) => binding.connectionId),
      ),
    );
  return new Map(rows.map((row) => [row.id, row]));
}

/** A write operation is open when the owner's switch for the provider is on and a shared connection's own is too. */
async function writeAllowedBy(
  db: Database,
  ownerId: string,
  connections: ReadonlyMap<string, Connection>,
): Promise<(binding: IntegrationBinding) => boolean> {
  const rows = await db
    .select({
      providerId: schema.integrationUserSettings.providerId,
      writeEnabled: schema.integrationUserSettings.writeEnabled,
    })
    .from(schema.integrationUserSettings)
    .where(eq(schema.integrationUserSettings.userId, ownerId));
  const switches = new Map(rows.map((row) => [row.providerId, row.writeEnabled]));
  return (binding) => {
    const connection = connections.get(binding.connectionId);
    return (
      switches.get(binding.providerId) === true &&
      connection !== undefined &&
      (connection.scope === 'user' || connection.writeEnabled)
    );
  };
}

function declaredTools(
  bindings: readonly IntegrationBinding[],
  claims: TaskCallClaims,
  writeAllowed: (binding: IntegrationBinding) => boolean,
): Map<string, IntegrationTool> {
  try {
    return integrationTools(bindings, getIntegrationProvider, { writeAllowed });
  } catch (err) {
    if (!(err instanceof IntegrationToolNameError)) throw err;
    log.warn(
      { taskId: claims.taskId, cliInvocationId: claims.cliInvocationId, detail: err.message },
      'the integration tools of an invocation cannot be named',
    );
    throw new HttpError(409, 'the tools of this invocation cannot be named', 'tools-unlistable');
  }
}

async function callsMade(db: DbTx, invocationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.integrationCalls)
    .where(eq(schema.integrationCalls.cliInvocationId, invocationId));
  return row?.n ?? 0;
}

function bindOperation(opId: string, args: unknown): BoundOperation {
  if (opId === 'get_pull_request_state') {
    const parsed = validateForgeOpArgs('get_pull_request_state', args);
    return parsed.ok
      ? {
          ok: true,
          run: (provider, ctx) => provider.getPullRequestState(ctx, parsed.args.prNumber),
        }
      : parsed;
  }
  if (opId === 'open_pull_request') {
    const parsed = validateForgeOpArgs('open_pull_request', args);
    return parsed.ok
      ? { ok: true, run: (provider, ctx) => provider.openPullRequest(ctx, parsed.args) }
      : parsed;
  }
  return { ok: false, error: 'unknown operation' };
}

function vendorReason(err: ForgeError): Reason {
  if (err instanceof ForgeAuthError) return 'vendor-auth';
  if (err instanceof ForgeNotFoundError) return 'vendor-not-found';
  if (err instanceof ForgeConflictError) return 'vendor-conflict';
  if (err instanceof ForgeRateLimitError) return 'vendor-rate-limited';
  return 'vendor-error';
}

// Bitbucket Cloud sends a token with a username as Basic base64(username:token), which a vendor may echo.
const secretsOf = ({ accessToken, username }: ConnectionCredential): string[] =>
  [username ? Buffer.from(`${username}:${accessToken}`).toString('base64') : '', accessToken]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);

const redact = (text: string, secrets: readonly string[]): string =>
  secrets.reduce((out, secret) => out.split(secret).join(REDACTED), text);

function failureOf(
  err: unknown,
  deadline: AbortSignal,
  secrets: readonly string[],
): { status: number; reason: Reason; message: string } {
  if (deadline.aborted) {
    return {
      status: 504,
      reason: 'timeout',
      message: 'the vendor did not answer within the deadline',
    };
  }
  if (err instanceof ForgeError) {
    return {
      status: 502,
      reason: vendorReason(err),
      message: redact(err.message, secrets).slice(0, ERROR_TEXT_MAX_LENGTH),
    };
  }
  return { status: 500, reason: 'internal-error', message: 'the integration call failed' };
}

// Sandbox-facing like /custom-mcp: the bearer is a task token, and the vendor token never leaves the api.
export const integrationMcpRoutes = new Hono<AppEnv>();

integrationMcpRoutes.use('*', sandboxBodyLimit);

integrationMcpRoutes.post('/tools/list', async (c) => {
  const claims = claimsFromBearer(c.req.header('Authorization'), 'integrations');
  const db = getDb();

  const invocation = await findInvocation(db, claims.cliInvocationId);
  assertInvocationLive(invocation, claims);

  const bindings = parseIntegrationBindings(invocation.stamp);
  const writeAllowed = await writeAllowedBy(
    db,
    invocation.ownerId,
    await loadConnections(db, bindings),
  );
  const tools = [...declaredTools(bindings, claims, writeAllowed)].map(([name, { op }]) => ({
    name,
    description: op.description,
    inputSchema: op.inputSchema,
  }));
  log.info(
    {
      taskId: claims.taskId,
      cliInvocationId: claims.cliInvocationId,
      tools: tools.map((tool) => tool.name),
    },
    'integration tools listed',
  );
  return c.json({ tools });
});

integrationMcpRoutes.post('/call', async (c) => {
  const startedAt = Date.now();
  const claims = claimsFromBearer(c.req.header('Authorization'), 'integrations');
  const body = (await c.req.json().catch(() => null)) as {
    tool?: unknown;
    arguments?: unknown;
  } | null;
  const db = getDb();

  const invocation = await findInvocation(db, claims.cliInvocationId);
  assertInvocationLive(invocation, claims);

  // A write tool the switch has turned off is still matched here, so it is refused with a row, not as unknown.
  const name = typeof body?.tool === 'string' ? body.tool : '';
  const tool = declaredTools(parseIntegrationBindings(invocation.stamp), claims, () => true).get(
    name,
  );
  if (!tool)
    throw new HttpError(403, 'this invocation does not declare that tool', 'undeclared-tool');
  const { binding, op } = tool;

  // A row is a claim: written under the invocation's lock, and only below the budget.
  const claim = async (outcome: 'running' | 'refused', reason: Reason | null): Promise<string> => {
    const id = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`integration-budget:${claims.cliInvocationId}`}, 0))`,
      );
      if ((await callsMade(tx, claims.cliInvocationId)) >= INTEGRATION_CALL_BUDGET) return null;
      const [row] = await tx
        .insert(schema.integrationCalls)
        .values({
          // NULL once the connection is gone: the column is a foreign key.
          connectionId: sql`(select ${schema.integrationConnections.id} from ${schema.integrationConnections} where ${schema.integrationConnections.id} = ${binding.connectionId})`,
          providerId: binding.providerId,
          taskId: claims.taskId,
          taskStepId: claims.taskStepId,
          cliInvocationId: claims.cliInvocationId,
          tool: name,
          access: op.access,
          surface: 'rest',
          outcome,
          reason,
          durationMs: Date.now() - startedAt,
        })
        .returning({ id: schema.integrationCalls.id });
      return row!.id;
    });
    if (id === null) {
      const message = `this invocation has used its ${INTEGRATION_CALL_BUDGET} integration calls`;
      throw new HttpError(429, message, 'budget-spent');
    }
    return id;
  };
  const refuse = async (status: number, reason: Reason, message: string): Promise<never> => {
    await claim('refused', reason);
    throw new HttpError(status, message, reason);
  };
  const finish = (id: string, outcome: 'ok' | 'error', reason: Reason | null) =>
    db
      .update(schema.integrationCalls)
      .set({ outcome, reason, durationMs: Date.now() - startedAt })
      .where(eq(schema.integrationCalls.id, id));

  const forge = isForgeProviderName(binding.providerId) ? binding.providerId : null;
  if (
    !forge ||
    !getIntegrationProvider(binding.providerId) ||
    !(await isProviderEnabled(db, binding.providerId))
  ) {
    return refuse(403, 'provider-unavailable', 'this provider is not available on this install');
  }

  const connections = await loadConnections(db, [binding]);
  const connection = connections.get(binding.connectionId);
  if (
    !connection ||
    connection.status !== 'connected' ||
    connection.providerId !== binding.providerId ||
    (connection.scope === 'user' && connection.ownerUserId !== invocation.ownerId)
  ) {
    return refuse(
      403,
      'connection-unavailable',
      `the connection ${binding.connectionId} is not available to this task`,
    );
  }

  if (op.access === 'write') {
    const writeAllowed = await writeAllowedBy(db, invocation.ownerId, connections);
    if (!writeAllowed(binding)) {
      return refuse(403, 'write-switched-off', 'writes through this connection are switched off');
    }
  }

  const operation = bindOperation(op.opId, body?.arguments);
  if (!operation.ok) return refuse(400, 'invalid-arguments', operation.error);

  const remoteUrl = invocation.remoteUrl?.trim();
  if (!remoteUrl) return refuse(409, 'no-remote', 'this task has no repository with a remote');
  let remote: ReturnType<typeof parseRemote>;
  try {
    remote = parseRemote(remoteUrl, forge);
  } catch (err) {
    if (!(err instanceof ForgeError)) throw err;
    return refuse(409, 'no-remote', 'the remote of this repository cannot be read');
  }

  let credential: ConnectionCredential;
  try {
    credential = await getConnectionCredential(db, connection.id, { fetchFn: fetch });
  } catch (err) {
    if (
      err instanceof NeedsReauthError ||
      err instanceof ConnectionNotFoundError ||
      err instanceof CredentialProviderMismatchError
    ) {
      return refuse(403, 'connection-unavailable', err.message);
    }
    throw err;
  }
  if (
    credential.host === null ||
    !credentialUsableForPr({ provider: credential.provider, host: credential.host }, remoteUrl)
  ) {
    return refuse(
      403,
      'connection-not-for-repository',
      'this connection is not for the repository of this task',
    );
  }
  if (
    !apiBaseFits({
      host: credential.host,
      provider: credential.provider,
      apiBaseUrl: credential.apiBaseUrl,
    })
  ) {
    return refuse(403, 'unsafe-api-base', 'the API address of this connection is not acceptable');
  }

  const callId = await claim('running', null);
  const deadline = AbortSignal.timeout(INTEGRATION_CALL_DEADLINE_MS);
  const provider = resolveForgeProvider(forge);
  const ctx: ForgeContext = {
    provider: forge,
    apiBase: (
      credential.apiBaseUrl?.trim() ||
      provider.defaultApiBase(credentialApiHost(credential.host, remoteUrl))
    ).replace(/\/+$/, ''),
    host: remote.host,
    owner: remote.owner,
    repo: remote.repo,
    token: credential.accessToken,
    username: credential.username ?? '',
    signal: deadline,
  };
  let result: unknown;
  try {
    result = await operation.run(provider, ctx);
  } catch (err) {
    const failure = failureOf(err, deadline, secretsOf(credential));
    const logged = {
      taskId: claims.taskId,
      cliInvocationId: claims.cliInvocationId,
      tool: name,
      reason: failure.reason,
    };
    if (failure.reason === 'internal-error') {
      const detail = redact(
        err instanceof Error ? (err.stack ?? err.message) : String(err),
        secretsOf(credential),
      );
      log.error({ ...logged, detail }, 'an integration call failed unexpectedly');
    } else {
      log.warn(logged, 'an integration call did not succeed');
    }
    await finish(callId, 'error', failure.reason);
    throw new HttpError(failure.status, failure.message, failure.reason);
  }
  await finish(callId, 'ok', null);
  return c.json({ ok: true, text: JSON.stringify(result) });
});
