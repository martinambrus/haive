import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  CLI_EXEC_JOB_NAMES,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { closeTaskQueue } from '../src/queues/task-queue.js';
import {
  getCliExecQueue,
  closeCliExecQueue,
  startCliExecWorker,
} from '../src/queues/cli-exec-queue.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { splitSubAgentForProvider } from '../src/sub-agent-emulator/splitter.js';
import type { CliProviderRecord, SubAgentSpec } from '../src/cli-adapters/types.js';
import type { CliExecutionResult, CliSpawner } from '../src/cli-executor/index.js';

const log = logger.child({ module: 'sub-agent-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

interface State {
  userId?: string;
  taskId?: string;
  taskStepId?: string;
  providerId?: string;
  worker?: Awaited<ReturnType<typeof startCliExecWorker>>;
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (val: T) => boolean,
  label: string,
  timeoutMs = 15000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null && predicate(val)) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function createFakeSpawner(): CliSpawner {
  return async (spec, _opts): Promise<CliExecutionResult> => {
    const prompt = spec.args.join(' ');
    if (prompt.includes('sub-agent 1/2')) {
      return {
        exitCode: 0,
        stdout: '<<<JSON>>>{"files": ["src/a.ts", "src/b.ts"]}<<<ENDJSON>>>',
        stderr: '',
        durationMs: 12,
        timedOut: false,
      };
    }
    if (prompt.includes('sub-agent 2/2')) {
      return {
        exitCode: 0,
        stdout: '<<<JSON>>>{"labels": ["security", "performance"]}<<<ENDJSON>>>',
        stderr: '',
        durationMs: 13,
        timedOut: false,
      };
    }
    if (prompt.includes('Synthesize')) {
      return {
        exitCode: 0,
        stdout: '# Report\n\nTwo files scanned; two labels applied.',
        stderr: '',
        durationMs: 9,
        timedOut: false,
      };
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr: `unexpected prompt: ${prompt.slice(0, 200)}`,
      durationMs: 1,
      timedOut: false,
    };
  };
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'subagent-smoke@test.local',
      emailBlindIndex: `subagent-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'codex',
        label: 'codex smoke',
        executablePath: '/bin/true',
        supportsSubagents: false,
        authMode: 'subscription',
        enabled: true,
      })
      .returning();
    if (!provider) throw new Error('provider insert failed');
    state.providerId = provider.id;

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'sub-agent smoke',
        status: 'running',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    const [taskStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task.id,
        stepId: 'smoke-step',
        stepIndex: 0,
        title: 'sub-agent smoke step',
        status: 'waiting_cli',
      })
      .returning();
    if (!taskStep) throw new Error('task step insert failed');
    state.taskStepId = taskStep.id;

    const providerRecord = provider as CliProviderRecord;
    const adapter = cliAdapterRegistry.get(providerRecord.name);

    const spec: SubAgentSpec = {
      subAgents: [
        { name: 'scanner', prompt: 'List suspicious files', outputKey: 'files' },
        { name: 'labeler', prompt: 'Label each file', outputKey: 'labels' },
      ],
      synthesisPrompt: 'Produce a markdown report',
    };

    const split = splitSubAgentForProvider(adapter, providerRecord, spec, {});
    if (split.mode !== 'sequential') {
      throw new Error(`expected sequential mode for codex, got ${split.mode}`);
    }
    log.info({ providerName: providerRecord.name, mode: split.mode }, 'split resolved');

    const [invocation] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: task.id,
        taskStepId: taskStep.id,
        cliProviderId: providerRecord.id,
        mode: 'subagent_emulated',
        prompt: 'sub-agent smoke',
      })
      .returning();
    if (!invocation) throw new Error('cli invocation insert failed');

    state.worker = startCliExecWorker({ spawner: createFakeSpawner() });

    const queue = getCliExecQueue();
    await queue.add(CLI_EXEC_JOB_NAMES.INVOKE, {
      invocationId: invocation.id,
      taskId: task.id,
      taskStepId: taskStep.id,
      userId,
      cliProviderId: providerRecord.id,
      kind: 'subagent_sequential',
      spec: split.invocation,
    });
    log.info({ invocationId: invocation.id }, 'cli-exec job enqueued');

    const completed = await pollUntil(
      async () => {
        const row = await db.query.cliInvocations.findFirst({
          where: eq(schema.cliInvocations.id, invocation.id),
        });
        return row ?? null;
      },
      (r) => r.endedAt !== null,
      'invocation completion',
      20000,
    );

    if (completed.exitCode !== 0) {
      throw new Error(
        `sub-agent exit code ${completed.exitCode}; err=${completed.errorMessage ?? 'none'}`,
      );
    }
    const parsed = completed.parsedOutput as {
      collected?: Record<string, unknown>;
      synthesis?: string | null;
    } | null;
    if (!parsed || !parsed.collected) {
      throw new Error('parsedOutput missing collected');
    }
    if (
      typeof parsed.collected['files'] !== 'object' ||
      typeof parsed.collected['labels'] !== 'object'
    ) {
      throw new Error('collected keys missing expected sub-agent outputs');
    }
    if (!parsed.synthesis || !parsed.synthesis.includes('Report')) {
      throw new Error(`synthesis missing expected content: ${String(parsed.synthesis)}`);
    }

    log.info(
      {
        exitCode: completed.exitCode,
        collectedKeys: Object.keys(parsed.collected),
        synthesisLength: parsed.synthesis.length,
      },
      'sub-agent invocation complete',
    );

    console.log(
      JSON.stringify({
        smoke: 'SUBAGENT_OK',
        mode: split.mode,
        collected: parsed.collected,
        synthesis: parsed.synthesis,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskStepId) {
        await db
          .delete(schema.cliInvocations)
          .where(eq(schema.cliInvocations.taskStepId, state.taskStepId));
        await db.delete(schema.taskSteps).where(eq(schema.taskSteps.id, state.taskStepId));
      }
      if (state.taskId) {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, state.taskId));
      }
      if (state.providerId) {
        await db.delete(schema.cliProviders).where(eq(schema.cliProviders.id, state.providerId));
      }
      if (state.userId) {
        await db.delete(schema.users).where(eq(schema.users.id, state.userId));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup db rows failed');
    }
    if (state.worker) await state.worker.close().catch(() => {});
    await closeCliExecQueue().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
