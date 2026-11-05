import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/lib/upgrade-run.js', () => ({
  findLiveUpgradeRun: async () => null,
  listUpgradeRuns: async () => [],
}));
vi.mock('../src/lib/audit.js', () => ({
  recordAuditEvent: vi.fn(),
  insertAuditEvent: vi.fn(),
  logAuditEvent: vi.fn(),
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (_c: unknown, next: () => unknown) => next(),
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  getHaiveVersion: () => '1.0.0',
}));
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { HttpError } from '../src/context.js';

const app = new Hono();
app.onError((err, c) =>
  c.json({ error: err.message }, err instanceof HttpError ? err.status : 500),
);
app.route('/maintenance', maintenanceRoutes);
const post = () =>
  app.request('/maintenance/upgrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 'v9.9.9' }),
  });
beforeEach(() => {
  for (const key of [
    'HAIVE_CHANNEL',
    'HAIVE_CHANNEL_REGISTRY',
    'HAIVE_REGISTRY',
    'HAIVE_INSTALL_ID',
    'HAIVE_RELEASE_MANIFEST_URL',
    'HAIVE_POSTGRES_VOLUME',
    'HAIVE_SNAPSHOT_HOST_DIR',
    'HAIVE_NETWORK',
    'COMPOSE_PROJECT_NAME',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('HAIVE_INSTALL_DIR_HOST', '/host/install');
  vi.stubEnv('HAIVE_REGISTRY_TOKEN', 'hidden-token-sentinel');
  vi.spyOn(Date, 'now').mockReturnValue(1234);
  h.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('container-id'));
      child.emit('close', 0);
    });
    return child;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('channel argv selects image/channel/version and mounted Docker config without token', async () => {
  vi.stubEnv('HAIVE_CHANNEL', 'acme');
  vi.stubEnv('HAIVE_CHANNEL_REGISTRY', 'private.example:5000/customer');
  expect((await post()).status).toBe(202);
  const args = h.spawn.mock.calls[0]![1] as string[];
  expect(args).toContain('--manifest-image');
  expect(args).not.toContain('--manifest');
  expect(
    args.slice(args.indexOf('--manifest-image'), args.indexOf('--manifest-image') + 6),
  ).toEqual([
    '--manifest-image',
    'private.example:5000/customer/haive-acme-release:9.9.9',
    '--channel',
    'acme',
    '--version',
    '9.9.9',
  ]);
  expect(args).toContain('DOCKER_CONFIG=/install/.docker');
  expect(args.indexOf('DOCKER_CONFIG=/install/.docker')).toBeLessThan(
    args.indexOf('ghcr.io/martinambrus/haive-updater:9.9.9'),
  );
  expect(args.join(' ')).not.toContain('hidden-token-sentinel');
  expect(args).toContain('DATABASE_URL');
  expect(args).toContain('CONFIG_ENCRYPTION_KEY');
});
it('public argv remains byte-for-byte unchanged', async () => {
  expect((await post()).status).toBe(202);
  expect(h.spawn.mock.calls[0]).toEqual([
    'docker',
    [
      'run',
      '-d',
      '--name',
      'haive-upgrade-9.9.9-1234',
      '--network',
      'haive-network',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      '/host/install:/install',
      '-e',
      'DATABASE_URL',
      '-e',
      'REDIS_URL',
      '-e',
      'CONFIG_ENCRYPTION_KEY',
      '-e',
      'COMPOSE_PROJECT_NAME=haive',
      '-e',
      'HAIVE_INSTALL_ID=haive',
      'ghcr.io/martinambrus/haive-updater:9.9.9',
      '--manifest',
      'https://github.com/martinambrus/haive/releases/download/v9.9.9/release.json',
      '--install-dir',
      '/install',
      '--registry',
      'ghcr.io/martinambrus',
      '--postgres-volume',
      'haive_postgres_data',
      '--snapshot-host-dir',
      '/host/install/snapshots',
    ],
  ]);
});
it.each([
  ['../bad', 'private'],
  ['A', 'private'],
  ['bad-', 'private'],
  ['a'.repeat(33), 'private'],
  ['acme', 'https://private'],
  ['acme', 'private/token?secret'],
  ['acme', 'private/../repo'],
  ['acme', ''],
])('invalid channel/registry refuses before spawn: %s %s', async (channel, prefix) => {
  vi.stubEnv('HAIVE_CHANNEL', channel);
  vi.stubEnv('HAIVE_CHANNEL_REGISTRY', prefix);
  const result = await post();
  expect(result.status).toBe(400);
  expect(h.spawn).not.toHaveBeenCalled();
});
it('GET upgrade reports channel for display', async () => {
  vi.stubEnv('HAIVE_CHANNEL', 'acme');
  expect(await (await app.request('/maintenance/upgrade')).json()).toMatchObject({
    channel: 'acme',
  });
});
it('run overlay forwards channel, channel registry and Docker config keys to api', async () => {
  const text = await readFile(new URL('../../../docker-compose.run.yml', import.meta.url), 'utf8');
  const api = text.slice(text.indexOf('\n  api:'), text.indexOf('\n  worker:'));
  for (const key of ['HAIVE_CHANNEL', 'HAIVE_CHANNEL_REGISTRY', 'DOCKER_CONFIG'])
    expect(api).toContain(key + ': ${' + key + ':-}');
});
