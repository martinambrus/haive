import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { WORKER_RUNTIME_VERSION_KEY } from '@haive/shared';
import { MODULES_LOADED_WORKER_KEY } from '@haive/shared/modularity';
import { bootstrap } from '../src/bootstrap.js';
import { bootStepEngine } from '../src/step-engine/boot.js';
import { clearAgentLeases } from '../src/queues/cli-exec/agent-lease.js';
import { countBootRequeue } from '../src/queues/boot-requeue.js';
import {
  clearRuntimeReservations,
  clearBrowserSurcharges,
} from '../src/sandbox/runtime-admission.js';
import { closeRedis, getPatientRedis, initRedis } from '../src/redis.js';
import { startFake, type Fake } from './support/redis-stall.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<object>()),
  mkdir: async () => undefined,
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<object>()),
  waitForDatabaseReady: async () => undefined,
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<object>()),
  configService: { initialize: async () => undefined, get: async () => '/unused' },
  secretsService: { initialize: async () => undefined, getMasterKek: async () => 'key' },
  userSecretsService: { initialize: async () => undefined },
}));
vi.mock('../src/db.js', () => ({ initDatabase: () => ({}), getDb: () => ({}) }));
vi.mock('../src/data-migrations.js', () => ({ runDataMigrations: async () => undefined }));
vi.mock('../src/step-engine/template-manifest.js', () => ({
  syncTemplateManifestCache: async () => undefined,
}));
vi.mock('../src/modules.generated.js', () => ({ moduleRegistry: [] }));
vi.mock('../src/modules/activation.js', () => ({ deactivatedModuleIds: async () => new Set() }));
vi.mock('../src/modules/intent.js', () => ({ syncModuleIntent: async () => undefined }));
vi.mock('../src/step-engine/steps/index.js', () => ({ registerAllSteps: () => undefined }));
vi.mock('../src/step-engine/composable-core.js', () => ({
  CORE_COMPOSABLE_STEPS: [],
  assertCoreComposableCatalog: () => undefined,
}));
vi.mock('../src/step-engine/step-catalog.js', () => ({ syncStepCatalog: async () => undefined }));
vi.mock('../src/step-engine/task-type-seed.js', () => ({
  syncTaskTypeDefinitions: async () => ({}),
}));

let fake: Fake | undefined;
afterEach(async () => {
  if (fake) fake.loading = false;
  const closing = closeRedis();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1000);
  await closing;
  await fake?.stop();
  fake = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('all six boot paths wait through 1.2 s of LOADING and publish their writes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  fake = await startFake();
  fake.loading = true;
  const url = `redis://127.0.0.1:${fake.port}`;
  vi.stubEnv('DATABASE_URL', 'postgres://unused');
  vi.stubEnv('REDIS_URL', url);
  const info = fake.nextCommand('INFO');
  initRedis(url).bullRedis.on('error', () => undefined);
  await info;
  const patient = getPatientRedis();
  const paths = [
    bootstrap(),
    bootStepEngine({} as Database),
    clearRuntimeReservations(patient),
    clearAgentLeases(patient),
    clearBrowserSurcharges(patient),
    countBootRequeue('boot-counter'),
  ];
  const settled = paths.map(() => false);
  const outcomes = paths.map((path, i) =>
    path.then(
      (value) => {
        settled[i] = true;
        return { value };
      },
      (error) => {
        settled[i] = true;
        return { error };
      },
    ),
  );
  await vi.advanceTimersByTimeAsync(1200);
  expect(settled).toEqual([false, false, false, false, false, false]);
  fake.loading = false;
  const ready = patient.status === 'ready' ? Promise.resolve() : once(patient, 'ready');
  await vi.advanceTimersByTimeAsync(1000);
  await ready;
  const results = await Promise.all(outcomes);
  expect(results.every((result) => !('error' in result))).toBe(true);
  const writes = fake.commands.filter((c) => c[0]!.toUpperCase() === 'SET').map((c) => c[1]);
  expect(writes).toEqual(
    expect.arrayContaining([WORKER_RUNTIME_VERSION_KEY, MODULES_LOADED_WORKER_KEY]),
  );
  expect(fake.commands.filter((c) => c[0]!.toUpperCase() === 'DEL').map((c) => c[1])).toEqual(
    expect.arrayContaining(['haive:runtime-reserve', 'haive:agent-lease', 'haive:runtime-browser']),
  );
  expect(results[5]).toEqual({ value: 1 });
});

it('the boot entry point passes the patient client into each soft-state clear', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  for (const clear of ['clearRuntimeReservations', 'clearAgentLeases', 'clearBrowserSurcharges']) {
    expect(source).toContain(`await ${clear}(getPatientRedis())`);
  }
});
