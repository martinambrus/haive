import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), { end: vi.fn() }),
  initialize: vi.fn(),
}));
vi.mock('postgres', () => ({ default: () => h.sql }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { initialize: h.initialize },
}));
vi.mock('./journal.js', () => ({
  ensureJournal: vi.fn(),
  findLiveRun: vi.fn(),
  recordRunError: vi.fn(),
  startRun: vi.fn(),
  tryLock: vi.fn(),
}));
vi.mock('./run.js', async (original) => ({
  ...(await original<typeof import('./run.js')>()),
  readEnvVar: vi.fn(),
  resume: vi.fn(),
}));
import { main } from './cli.js';
import * as images from './images.js';
import * as dk from './docker.js';
import * as journal from './journal.js';
import * as run from './run.js';
const pin = (host: string) => `private/acme-${host}@sha256:${'a'.repeat(64)}`;
const refs = { api: pin('api'), worker: pin('worker'), web: pin('web'), builder: pin('builder') };
const settings: images.ImageSettings = {
  ...images.emptyOverrides(),
  HAIVE_CHANNEL: 'acme',
  DOCKER_CONFIG: '/host/install/.docker',
  HAIVE_CHANNEL_REGISTRY: 'private',
  HAIVE_INSTALL_ID: '',
  HAIVE_OWN_MODULES_HOST_DIR: '',
  HAIVE_BUILDER_IMAGE: '',
  HAIVE_OWN_MODULES_REBUILD_WEB: '',
};
let argv: string[];
beforeEach(() => {
  argv = process.argv;
  process.argv = [
    'node',
    'updater',
    '--install-dir',
    '/host/install',
    '--channel',
    'acme',
    '--version',
    '9.9.9',
    '--manifest-image',
    'private/release:9.9.9',
    '--check',
  ];
  vi.stubEnv('DATABASE_URL', 'postgres://isolated');
  vi.stubEnv('REDIS_URL', 'redis://isolated');
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(images, 'readImageSettings').mockResolvedValue({ ...settings });
  vi.mocked(journal.tryLock).mockResolvedValue(true);
  vi.mocked(journal.findLiveRun).mockResolvedValue(null);
  vi.mocked(run.readEnvVar).mockResolvedValue('1.0.0');
  h.sql.end.mockResolvedValue(undefined);
  vi.spyOn(dk, 'localImages').mockResolvedValue([
    'ghcr.io/martinambrus/haive-api:1.0.0',
    'ghcr.io/martinambrus/haive-worker:1.0.0',
    'ghcr.io/martinambrus/haive-web:1.0.0',
  ]);
  vi.spyOn(dk, 'readReleaseManifestImage').mockResolvedValue(
    JSON.stringify({
      manifestVersion: 1,
      channel: 'acme',
      version: '9.9.9',
      builtAt: '2026-11-05',
      migrationHead: '0221',
      images: refs,
    }),
  );
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
it('check applies install credentials before manifest IO, emits pins, and starts no run', async () => {
  vi.mocked(dk.readReleaseManifestImage).mockImplementation(async () => {
    expect(process.env.DOCKER_CONFIG).toBe('/host/install/.docker');
    return JSON.stringify({
      manifestVersion: 1,
      channel: 'acme',
      version: '9.9.9',
      builtAt: '2026-11-05',
      migrationHead: '0221',
      images: refs,
    });
  });
  expect(await main()).toBe(0);
  expect(dk.localImages).toHaveBeenCalledWith(true);
  expect(journal.startRun).not.toHaveBeenCalled();
  const plan = vi
    .mocked(console.log)
    .mock.calls.map(([line]) => JSON.parse(String(line)))
    .find((v) => v.event === 'image-plan');
  expect(plan.overrides).toEqual({
    HAIVE_API_IMAGE: refs.api,
    HAIVE_WORKER_IMAGE: refs.worker,
    HAIVE_WEB_IMAGE: refs.web,
  });
});
it('an interrupted channel run resumes before any new manifest pull', async () => {
  process.argv = ['node', 'updater', '--install-dir', '/host/install'];
  vi.mocked(journal.findLiveRun).mockResolvedValue({
    id: 'run',
    fromVersion: '1.0.0',
    toVersion: '9.9.9',
    startedAt: new Date(),
    phase: 'migrate',
    metadata: { migrationHead: '0221' },
  } as never);
  vi.mocked(run.resume).mockResolvedValue(undefined);
  expect(await main()).toBe(0);
  expect(run.resume).toHaveBeenCalled();
  expect(process.env.DOCKER_CONFIG).toBe('/host/install/.docker');
  expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
});
it('a mismatched manifest creates no upgrade run', async () => {
  process.argv[process.argv.indexOf('--version') + 1] = '8.8.8';
  await expect(main()).rejects.toThrow('version');
  expect(journal.startRun).not.toHaveBeenCalled();
  expect(run.resume).not.toHaveBeenCalled();
});
