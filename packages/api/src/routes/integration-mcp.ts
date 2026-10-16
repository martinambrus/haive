import { Hono } from 'hono';
import { count, eq, inArray, sql } from 'drizzle-orm';
import type { ZodError } from 'zod';
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
  OauthUnavailableError,
  OauthVendorError,
  getConnectionCredential,
  getIntegrationProvider,
  integrationTools,
  parseIntegrationBindings,
  providerState,
  writeAllowedBy,
  type ConnectionCredential,
  type IntegrationBinding,
  type IntegrationTool,
} from '@haive/shared/integrations';
import { parseProviderId } from '@haive/shared/modularity';
import { getDb, type Database } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import {
  INTEGRATION_CALL_BODY_LIMIT_BYTES,
  INTEGRATION_CALL_BUDGET,
  INTEGRATION_CALL_DEADLINE_MS,
} from '../lib/integration-call-limits.js';
import {
  REDACTED,
  VendorError,
  createVendorClient,
  tokenForms,
  type VendorReason,
} from '../lib/module-vendor-client.js';
import {
  assertInvocationLive,
  claimsFromBearer,
  type TaskCallClaims,
} from '../lib/task-call-auth.js';
import { jsonBodyLimit } from '../middleware/sandbox-body-limit.js';
import { moduleExecutorOf } from '../modules/integration-executors.js';

const log = logger.child({ module: 'integration-mcp-routes' });

const ERROR_TEXT_MAX_LENGTH = 400;
const RESULT_TEXT_MAX_BYTES = 65_536;
const TRUNCATED_MARK = '\n[truncated]';

type Reason =
  | 'provider-unavailable'
  | 'provider-deactivated'
  | 'provider-missing'
  | 'connection-unavailable'
  | 'write-switched-off'
  | 'invalid-arguments'
  | 'no-remote'
  | 'connection-not-for-repository'
  | 'unsafe-api-base'
  | 'timeout'
  | VendorReason
  | 'internal-error';

type Connection = {
  id: string;
  providerId: string;
  scope: 'user' | 'shared';
  ownerUserId: string;
  status: string;
  accountLabel: string;
  externalAccountId: string | null;
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
      accountLabel: schema.integrationConnections.accountLabel,
      externalAccountId: schema.integrationConnections.externalAccountId,
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

const isUnloadedModuleProvider = (binding: IntegrationBinding): boolean =>
  parseProviderId(binding.providerId)?.kind === 'module' &&
  getIntegrationProvider(binding.providerId) === undefined;

function describeIssue(error: ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return `invalid arguments: ${where}${issue?.message ?? 'not accepted'}`.slice(
    0,
    ERROR_TEXT_MAX_LENGTH,
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

function vendorReason(err: ForgeError | VendorError): Reason {
  if (err instanceof VendorError) return err.reason;
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
  if (err instanceof ForgeError || err instanceof VendorError) {
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

integrationMcpRoutes.use('*', jsonBodyLimit(INTEGRATION_CALL_BODY_LIMIT_BYTES));

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
  const bindings = parseIntegrationBindings(invocation.stamp);
  const tool = declaredTools(bindings, claims, () => true).get(name);
  // A tool nothing lists, while the stamp binds a module provider no loaded module declares, was that provider's.
  const binding = tool?.binding ?? bindings.find(isUnloadedModuleProvider);
  if (!binding)
    throw new HttpError(403, 'this invocation does not declare that tool', 'undeclared-tool');

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
          // A name no provider declares is the agent's own, so it is not stored.
          tool: tool ? name : '',
          access: tool?.op.access ?? binding.access,
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

  const fail = async (
    err: unknown,
    callId: string,
    deadline: AbortSignal,
    secrets: readonly string[],
  ): Promise<never> => {
    const failure = failureOf(err, deadline, secrets);
    const logged = {
      taskId: claims.taskId,
      cliInvocationId: claims.cliInvocationId,
      tool: name,
      reason: failure.reason,
    };
    if (failure.reason === 'internal-error') {
      const detail = redact(
        err instanceof Error ? (err.stack ?? err.message) : String(err),
        secrets,
      );
      log.error({ ...logged, detail }, 'an integration call failed unexpectedly');
    } else {
      log.warn(logged, 'an integration call did not succeed');
    }
    await finish(callId, 'error', failure.reason);
    throw new HttpError(failure.status, failure.message, failure.reason);
  };
  const credentialOf = async (connectionId: string): Promise<ConnectionCredential> => {
    try {
      return await getConnectionCredential(db, connectionId, { fetchFn: fetch });
    } catch (err) {
      if (
        err instanceof NeedsReauthError ||
        err instanceof ConnectionNotFoundError ||
        err instanceof CredentialProviderMismatchError
      ) {
        return refuse(403, 'connection-unavailable', err.message);
      }
      if (err instanceof OauthVendorError || err instanceof OauthUnavailableError) {
        return refuse(403, 'connection-unavailable', 'the access token could not be renewed');
      }
      throw err;
    }
  };

  if (!tool) {
    const message = `the provider ${binding.providerId} is not loaded on this install`;
    return refuse(403, 'provider-missing', message);
  }
  const { op } = tool;

  const state = await providerState(db, binding.providerId);
  if (state === 'module-deactivated') {
    return refuse(403, 'provider-deactivated', 'the module of this provider is deactivated');
  }
  if (state !== 'enabled') {
    return refuse(403, 'provider-unavailable', 'this provider is not available on this install');
  }
  const forge = isForgeProviderName(binding.providerId) ? binding.providerId : null;

  const connections = await loadConnections(db, [binding]);
  const connection = connections.get(binding.connectionId);
  if (
    !connection ||
    connection.status !== 'connected' ||
    connection.providerId !== binding.providerId ||
    connection.scope !== 'user' ||
    connection.ownerUserId !== invocation.ownerId
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

  if (forge === null) {
    const executor = moduleExecutorOf(binding.providerId, op.opId);
    if (!executor) {
      return refuse(403, 'provider-unavailable', 'this provider is not available on this install');
    }
    const args = executor.args.safeParse(body?.arguments);
    if (!args.success) return refuse(400, 'invalid-arguments', describeIssue(args.error));

    const { accessToken } = await credentialOf(connection.id);
    const forms = tokenForms(accessToken);
    const callId = await claim('running', null);
    const deadline = AbortSignal.timeout(INTEGRATION_CALL_DEADLINE_MS);
    let text: string;
    try {
      const result = await executor.run({
        args: args.data,
        vendor: createVendorClient({
          token: accessToken,
          apiHosts: getIntegrationProvider(binding.providerId)?.apiHosts ?? [],
          signal: deadline,
        }),
        signal: deadline,
        account: {
          label: connection.accountLabel,
          externalAccountId: connection.externalAccountId,
        },
      });
      text = cutToBytes(redact(JSON.stringify(result) ?? 'null', forms), RESULT_TEXT_MAX_BYTES);
    } catch (err) {
      return fail(err, callId, deadline, forms);
    }
    await finish(callId, 'ok', null);
    return c.json({ ok: true, text });
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

  const credential = await credentialOf(connection.id);
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
    return fail(err, callId, deadline, secretsOf(credential));
  }
  await finish(callId, 'ok', null);
  return c.json({ ok: true, text: JSON.stringify(result) });
});
