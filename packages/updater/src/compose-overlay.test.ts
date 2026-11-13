import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  exec: vi.fn(),
  sql: Object.assign(
    vi.fn(async () => []),
    { end: vi.fn(async () => {}) },
  ),
}));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: h.exec }),
}));
vi.mock('postgres', () => ({ default: vi.fn(() => h.sql) }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { initialize: vi.fn(), set: vi.fn() },
}));
vi.mock('./journal.js', () => ({
  ensureJournal: vi.fn(),
  findLiveRun: vi.fn(),
  lastDoneChannel: vi.fn(),
  recordRunError: vi.fn(),
  recordAttempt: vi.fn(),
  startRun: vi.fn(),
  tryLock: vi.fn(),
  enterPhase: vi.fn(),
  finishRun: vi.fn(),
  mergeMetadata: vi.fn(),
  readFoundState: vi.fn().mockResolvedValue(null),
}));
vi.mock('./run.js', async (original) => {
  const actual = await original<typeof import('./run.js')>();
  return {
    ...actual,
    phaseDraining: vi.fn(),
    phaseMaintenance: vi.fn(),
    phaseMigrate: vi.fn(),
    // Exercise the real verification deployment, then force the CLI's rollback path.
    phaseVerify: vi.fn(async (ctx) => {
      expect(await actual.phaseVerify(ctx)).toBe(true);
      return false;
    }),
  };
});

import { main } from './cli.js';
import * as dk from './docker.js';
import * as images from './images.js';
import * as journal from './journal.js';

let fixture: string;
let dir: string;
const argv = process.argv;
const baseFiles = ['docker-compose.yml', 'docker-compose.run.yml'];
const gpu = 'docker-compose.gpu.yml';
const vulkan = 'docker-compose.vulkan.yml';

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'updater-overlay-fixture-'));
  for (const file of baseFiles) await writeFile(join(fixture, file), 'services: {}\n');
  await writeFile(join(fixture, '.env'), 'HAIVE_VERSION=1.0.0\n');
  await writeFile(
    join(fixture, 'release.json'),
    JSON.stringify({
      manifestVersion: 1,
      version: '1.1.0',
      builtAt: '2026-11-13',
      minFrom: '0.0.0',
      migrationHead: '0100',
    }),
  );
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'updater-overlay-install-'));
  await cp(fixture, dir, { recursive: true });
  process.argv = [
    'node',
    'updater',
    '--install-dir',
    dir,
    '--registry',
    'registry.test',
    '--manifest',
    join(dir, 'release.json'),
    '--postgres-volume',
    'fixture-postgres',
  ];
  vi.stubEnv('DATABASE_URL', 'postgres://isolated');
  vi.stubEnv('REDIS_URL', 'redis://isolated');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h.exec.mockResolvedValue({ stdout: '' });
  vi.mocked(journal.tryLock).mockResolvedValue(true);
  vi.mocked(journal.findLiveRun).mockResolvedValue(null);
  vi.mocked(journal.lastDoneChannel).mockResolvedValue(null);
  vi.mocked(journal.startRun).mockResolvedValue('fixture-run');
  vi.spyOn(images, 'readImageSettings').mockResolvedValue(
    Object.fromEntries(images.IMAGE_SETTING_KEYS.map((key) => [key, ''])) as images.ImageSettings,
  );
  vi.spyOn(dk, 'localImages').mockResolvedValue(
    ['api', 'worker', 'web'].map((host) => `registry.test/haive-${host}:1.0.0`),
  );
  vi.spyOn(dk, 'snapshotVolume').mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.1.0', migrationHead: '0100' }),
    }),
  );
});
afterEach(async () => {
  process.argv = argv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

it.each([
  { label: 'CPU', installed: [], selected: [] },
  { label: 'NVIDIA', installed: [gpu], selected: [gpu] },
  { label: 'Vulkan', installed: [vulkan], selected: [vulkan] },
  { label: 'both (NVIDIA first)', installed: [vulkan, gpu], selected: [gpu] },
])(
  'preserves the $label install overlay through pull, snapshot, verify, rollback and resume',
  async ({ installed, selected }) => {
    for (const file of installed) await writeFile(join(dir, file), 'services: {}\n');

    expect(await main()).toBe(5);
    // A new updater process reconstructs the same list before recovering an interrupted run.
    vi.mocked(journal.findLiveRun).mockResolvedValue({
      id: 'fixture-run',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      channel: 'public',
      status: 'running',
      error: null,
      phase: 'verify',
      startedAt: new Date('2026-11-13T00:00:00Z'),
      metadata: { migrationHead: '0100' },
    });
    expect(await main()).toBe(0);

    const files = [...baseFiles, ...selected].flatMap((file) => ['-f', file]);
    expect(h.exec.mock.calls.map(([command, args]) => [command, args])).toEqual(
      [
        ['pull'],
        ['stop', 'postgres'],
        ['up', '-d', 'postgres'],
        ['up', '-d'],
        ['up', '-d'],
        ['up', '-d'],
      ].map((operation) => ['docker', ['compose', ...files, ...operation]]),
    );
    expect(h.exec.mock.calls.map(([, , options]) => options.cwd)).toEqual(Array(6).fill(dir));
    expect(h.exec.mock.calls.map(([, , options]) => options.env.HAIVE_VERSION)).toEqual([
      '1.1.0',
      '1.0.0',
      '1.0.0',
      '1.1.0',
      '1.0.0',
      '1.0.0',
    ]);
  },
);
