import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { logger } from '@haive/shared/logger';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  error: undefined as unknown,
  resolveForge: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/forge/index.js', async (original) => ({
  ...(await original<object>()),
  resolveForgeContext: h.resolveForge,
}));
vi.mock('../src/step-engine/steps/workflow/_task-meta.js', async (original) => ({
  ...(await original<object>()),
  resolveDdevWorkspace: async () => ({ repoSubpath: '' }),
}));
vi.mock('../src/sandbox/ddev-runner.js', async (original) => ({
  ...(await original<object>()),
  ddevExec: async () => {
    throw h.error;
  },
  runnerHandleForTask: () => ({}),
}));
vi.mock('../src/cli-versions/fetcher.js', () => ({
  fetchVersionsFromSource: async () => {
    throw h.error;
  },
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<object>()),
  configService: { getBoolean: async () => true },
}));

import { TASK_JOB_NAMES } from '@haive/shared';
import { recordPlanMirrorError } from '../src/plan/mirror.js';
import { PlanMirrorRefusal } from '../src/queues/plan-mirror-queue.js';
import { runDdevControl } from '../src/queues/ddev-control-queue.js';
import { runPrPollTick } from '../src/queues/pr-poll-queue.js';
import { processTaskJob } from '../src/queues/task-queue.js';
import { refreshAllCliVersions, refreshAllToolVersions } from '../src/cli-versions/refresh.js';
import { refreshBrowserVersions } from '../src/cli-versions/browser-versions.js';
import { refreshRubyVersions } from '../src/cli-versions/ruby-versions.js';
import { refreshOpenRouterModels } from '../src/cli-versions/openrouter-models.js';
import { refreshModelPrices, refreshFxRates } from '../src/cli-versions/model-prices.js';
import { fetchOllamaModelPrices } from '../src/cli-versions/ollama-model-prices.js';

const secret = randomBytes(24).toString('base64url');
const ordinary = 'ordinary diagnosis\n  exact whitespace';
const lines: string[] = [];
const writes: Record<string, unknown>[] = [];
function failure(bound: boolean) {
  return bound
    ? new DrizzleQueryError('select $1', [secret], new Error(secret))
    : new Error(ordinary);
}
function safe(value: unknown) {
  const text = JSON.stringify(value);
  expect(
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
      text.includes(part),
    ),
  ).toBe(false);
}
function dbFake() {
  return {
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        writes.push(value);
        return {
          onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
            writes.push(set);
          },
        };
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        writes.push(value);
        return { where: () => ({ returning: async () => [] }) };
      },
    }),
    query: {
      tasks: {
        findFirst: async () => ({ repositoryId: 'repo' }),
        findMany: async () => [
          {
            id: 'task',
            repositoryId: 'repo',
            prNumber: '1',
            prCredentialId: 'credential',
            prState: 'open',
            prRemoteUrl: 'https://example.invalid/repo',
          },
        ],
      },
      repositories: {
        findFirst: async () => ({
          storagePath: '/unused',
          remoteUrl: 'https://example.invalid/repo',
        }),
      },
    },
    select: () => ({
      from: (table: unknown) => {
        const rows = table === schema.cliProviders ? [{ model: 'kimi-k3:cloud' }] : [];
        return Object.assign(Promise.resolve(rows), { where: () => Promise.resolve(rows) });
      },
    }),
  };
}
beforeEach(() => {
  lines.length = 0;
  writes.length = 0;
  h.resolveForge.mockReset().mockImplementation(async () => {
    throw h.error;
  });
  const key = Object.getOwnPropertySymbols(logger).find(
    (key) => key.description === 'pino.stream',
  )!;
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
  h.db = dbFake();
  vi.stubGlobal('fetch', async () => {
    throw h.error;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])('fix6 stores safe plan mirror errors (bound: %s)', async (bound) => {
  const err = failure(bound);
  await recordPlanMirrorError(h.db as never, 'repo', err);
  expect(
    writes.every((row) => row.lastError === (bound ? 'Database operation failed' : ordinary)),
  ).toBe(true);
  safe(writes);
});
it('fix6 preserves PlanMirrorRefusal text', async () => {
  await recordPlanMirrorError(h.db as never, 'repo', new PlanMirrorRefusal(ordinary));
  expect(writes.every((row) => row.lastError === ordinary)).toBe(true);
});
it.each([true, false])('fix6 stores safe task queue failures (bound: %s)', async (bound) => {
  h.error = failure(bound);
  (h.db as ReturnType<typeof dbFake>).query.tasks.findFirst = async () => {
    throw h.error;
  };
  await processTaskJob({
    name: TASK_JOB_NAMES.START,
    data: { taskId: 'task', epoch: 0 },
  } as never).catch(() => undefined);
  expect(
    writes.some((row) => row.errorMessage === (bound ? 'Database operation failed' : ordinary)),
  ).toBe(true);
  safe([writes, lines]);
});
it.each([true, false])('fix6 returns safe ddev failures (bound: %s)', async (bound) => {
  h.error = failure(bound);
  const result = await runDdevControl({ taskId: 'task', action: 'status' });
  expect(result.error === (bound ? 'Database operation failed' : ordinary)).toBe(true);
  safe([result, lines]);
});
it.each([true, false])('fix6 stores safe PR poll failures (bound: %s)', async (bound) => {
  h.error = failure(bound);
  await runPrPollTick(h.db as never);
  expect(h.resolveForge).toHaveBeenCalledWith(
    expect.objectContaining({ remoteUrl: 'https://example.invalid/repo' }),
  );
  expect(
    writes.some((row) => row.prPollError === (bound ? 'Database operation failed' : ordinary)),
  ).toBe(true);
  safe([writes, lines]);
});
for (const refresh of [
  refreshAllCliVersions,
  refreshAllToolVersions,
  refreshBrowserVersions,
  refreshRubyVersions,
  refreshOpenRouterModels,
  refreshModelPrices,
  refreshFxRates,
  fetchOllamaModelPrices,
]) {
  it.each([true, false])(`fix6 keeps ${refresh.name} errors safe (bound: %s)`, async (bound) => {
    h.error = failure(bound);
    const result = await refresh(h.db as never);
    expect(result.errors.length > 0).toBe(true);
    safe([result, writes, lines]);
    if (!bound)
      expect(JSON.stringify([result, writes]).includes(JSON.stringify(ordinary).slice(1, -1))).toBe(
        true,
      );
  });
}
