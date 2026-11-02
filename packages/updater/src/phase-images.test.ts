import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configService } from '@haive/shared';
import * as dk from './docker.js';
import { emptyOverrides } from './images.js';
import { phaseMigrate, phaseVerify, resume, type UpgradeContext } from './run.js';

vi.mock('./journal.js', () => ({
  enterPhase: vi.fn(),
  finishRun: vi.fn(),
  mergeMetadata: vi.fn(),
  readFoundState: vi.fn().mockResolvedValue('maintenance'),
  recordFoundState: vi.fn(),
}));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function context() {
  const dir = await mkdtemp(join(tmpdir(), 'haive-phase-images-'));
  dirs.push(dir);
  const envFile = join(dir, '.env');
  await writeFile(envFile, 'HAIVE_VERSION=1.0.0\nOTHER=kept\n');
  const fence = Object.assign(
    vi.fn(async () => []),
    { release: vi.fn() },
  );
  const sql = Object.assign(
    vi.fn(async () => []),
    { reserve: async () => fence },
  );
  vi.spyOn(configService, 'set').mockResolvedValue(undefined);
  return {
    sql,
    envFile,
    runId: 'run-fixture',
    compose: { dir, files: [] },
    registry: 'customer',
    fromVersion: '1.0.0',
    target: { version: '1.1.0', migrationHead: '0220' },
    previousImages: {
      ...emptyOverrides(),
      HAIVE_API_IMAGE: 'own-api:old',
      HAIVE_WORKER_IMAGE: 'own-worker:old',
    },
    targetImages: {
      ...emptyOverrides(),
      HAIVE_API_IMAGE: 'own-api:new',
      HAIVE_WORKER_IMAGE: 'own-worker:new',
      HAIVE_WEB_IMAGE: 'own-web:new',
    },
    apiUrl: 'http://fixture',
    network: 'fixture-network',
    log: vi.fn(),
  } as unknown as UpgradeContext;
}

it('runs migration and destructive commit from the derived target images, including forward resume', async () => {
  const ctx = await context();
  const oneShot = vi.spyOn(dk, 'runOneShot').mockResolvedValue('done');
  await phaseMigrate(ctx);
  await resume(ctx, 'commit');
  expect(oneShot.mock.calls.map(([image]) => image)).toEqual(['own-api:new', 'own-worker:new']);
  expect(oneShot.mock.calls[0]?.[1]).toEqual(['node', 'packages/database/dist/migrate/index.js']);
  expect(oneShot.mock.calls[1]?.[1]).toEqual([
    'node',
    'packages/worker/dist/destructive-data-migrations-cli.js',
  ]);
});

it('verify persists target refs and a resumed rollback restores exact old refs before recreating services', async () => {
  const ctx = await context();
  const pinsAtRecreate: string[] = [];
  const up = vi.spyOn(dk, 'composeUp').mockImplementation(async () => {
    pinsAtRecreate.push(await readFile(ctx.envFile, 'utf8'));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.1.0', migrationHead: '0220' }),
    }),
  );
  expect(await phaseVerify(ctx)).toBe(true);
  await resume(ctx, 'verify');
  expect(pinsAtRecreate[0]).toContain('HAIVE_API_IMAGE=own-api:new');
  expect(pinsAtRecreate[0]).toContain('HAIVE_WEB_IMAGE=own-web:new');
  expect(pinsAtRecreate[1]).toContain('HAIVE_API_IMAGE=own-api:old');
  expect(pinsAtRecreate[1]).toContain('HAIVE_WORKER_IMAGE=own-worker:old');
  expect(pinsAtRecreate[1]).toContain('HAIVE_WEB_IMAGE=\n');
  expect(pinsAtRecreate[1]).toContain('HAIVE_VERSION=1.0.0');
  expect(pinsAtRecreate[1]).toContain('OTHER=kept');
  expect(up.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({
      HAIVE_API_IMAGE: 'own-api:new',
      HAIVE_VERSION: '1.1.0',
      HAIVE_REGISTRY: 'customer',
    }),
  );
  expect(up.mock.calls[1]?.[1]).toEqual(
    expect.objectContaining({
      HAIVE_API_IMAGE: 'own-api:old',
      HAIVE_VERSION: '1.0.0',
      HAIVE_REGISTRY: 'customer',
      HAIVE_WEB_IMAGE: '',
    }),
  );
});
