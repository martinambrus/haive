import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import {
  syncProviderAuthBack,
  syncRefreshedAuthToUserVolumes,
} from '../src/sandbox/task-auth-volume.js';
import type { DockerRunner, DockerRunOpts } from '../src/sandbox/docker-runner.js';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: Object.assign(
    vi.fn(async () => {}),
    { assertHeld: vi.fn(async () => {}) },
  ),
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: h.acquire,
}));
const provider = {
  id: 'provider',
  userId: 'user',
  name: 'codex' as const,
  authMode: 'subscription' as const,
  isolateAuth: false,
};
beforeEach(() => {
  h.acquire.mockReset().mockResolvedValue(h.release);
  h.release.mockClear();
});
afterEach(() => vi.useRealTimers());
describe('task auth sync shares the sign-out critical section', () => {
  it('yields to login/sign-out without even reading a credential', async () => {
    h.acquire.mockResolvedValue(null);
    const runner = { volumeExists: vi.fn(), run: vi.fn() };
    expect(
      await syncProviderAuthBack(
        'task',
        provider,
        {} as Database,
        runner as unknown as DockerRunner,
        0,
      ),
    ).toBe(false);
    expect(runner.volumeExists).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(h.acquire).toHaveBeenCalledWith(expect.anything(), cliAuthScope(provider));
  });
  it('waits for a short-lived teardown contender before reading the surviving user volume', async () => {
    vi.useFakeTimers();
    h.acquire.mockResolvedValueOnce(null);
    const runner = { volumeExists: vi.fn(async () => false), run: vi.fn() };
    const pending = syncProviderAuthBack(
      'task',
      provider,
      {} as Database,
      runner as unknown as DockerRunner,
    );
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(h.acquire).toHaveBeenCalledTimes(2);
    expect(runner.volumeExists).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it('does not recreate a volume that sign-out removed', async () => {
    const runner = { volumeExists: vi.fn(async () => false), run: vi.fn() };
    expect(
      await syncProviderAuthBack(
        'task',
        provider,
        {} as Database,
        runner as unknown as DockerRunner,
      ),
    ).toBe(false);
    expect(runner.run).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it('carries a rotated credential back under the lock without marking it as a new login', async () => {
    const update = vi.fn();
    const rotated = randomBytes(32).toString('hex');
    const prior = randomBytes(32).toString('hex');
    const runner = {
      volumeExists: vi.fn(async () => true),
      run: vi.fn(async (opts: DockerRunOpts) => {
        const task = opts.mounts?.[0]?.source.includes('_task_') === true;
        const script = opts.cmd[2] as string;
        return {
          exitCode: 0,
          stdout: script.startsWith('stat')
            ? task
              ? '200'
              : '100'
            : JSON.stringify({ tokens: { access_token: task ? rotated : prior } }),
          stderr: '',
        };
      }),
    };
    expect(
      await syncProviderAuthBack(
        'task',
        provider,
        { update } as unknown as Database,
        runner as unknown as DockerRunner,
      ),
    ).toBe(true);
    expect(runner.run.mock.calls.at(-1)?.[0].mounts).toHaveLength(2);
    expect(h.release).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('sync-back temporary files', () => {
  async function scripts(): Promise<string[]> {
    const copies: string[] = [];
    const taskToken = randomBytes(32).toString('hex');
    const userToken = randomBytes(32).toString('hex');
    const runner = {
      volumeExists: async () => true,
      run: async (opts: DockerRunOpts) => {
        const script = opts.cmd[2]!;
        if (opts.mounts?.length === 2) copies.push(script);
        const task = opts.mounts?.[0]?.source.includes('_task_');
        return {
          exitCode: 0,
          stdout: script.startsWith('stat')
            ? task
              ? '200'
              : '100'
            : JSON.stringify({ tokens: { access_token: task ? taskToken : userToken } }),
          stderr: '',
        };
      },
    } as unknown as DockerRunner;
    await Promise.all(
      ['one', 'two'].map((task) => syncProviderAuthBack(task, provider, {} as Database, runner)),
    );
    return copies;
  }

  it('gives overlapping settlements distinct copy destinations', async () => {
    const copies = await scripts();
    const destinations = copies.map(
      (script) => script.match(/cp "\/src\/auth.json" "([^"]+)"/)?.[1],
    );
    expect(destinations).toHaveLength(2);
    expect(destinations.every(Boolean)).toBe(true);
    expect(new Set(destinations).size).toBe(2);
  });

  it.each([0, 1])('cleans its temporary credential after chown exits %s', async (exit) => {
    const [script] = await scripts();
    const root = mkdtempSync(join(tmpdir(), 'haive-auth-sync-'));
    try {
      for (const dir of ['src', 'dst', 'bin']) mkdirSync(join(root, dir));
      const token = randomBytes(32).toString('hex');
      writeFileSync(join(root, 'src/auth.json'), token);
      writeFileSync(join(root, 'bin/chown'), `#!/bin/sh\nexit ${exit}\n`, { mode: 0o755 });
      const result = spawnSync(
        'sh',
        ['-c', script!.replaceAll('/src/', `${root}/src/`).replaceAll('/dst/', `${root}/dst/`)],
        {
          env: { PATH: `${root}/bin:/usr/bin:/bin` },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(exit);
      expect(readdirSync(join(root, 'dst')).filter((name) => name.includes('.haive-tmp'))).toEqual(
        [],
      );
      if (exit === 0)
        expect(readFileSync(join(root, 'dst/auth.json'), 'utf8') === token).toBe(true);
      else expect(readdirSync(join(root, 'dst'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it.each([
  ['subscription', true, 'haive_cli_auth_p_000000000000_codex_0'],
  ['api_key', true, 'haive_cli_auth_p_000000000000_codex_0'],
  ['subscription', false, 'haive_cli_auth_111111111111_codex_0'],
  ['api_key', false, 'haive_cli_auth_111111111111_codex_k_0'],
] as const)(
  'task-end sync uses the ledger provider for %s, isolation %s',
  async (authMode, isolateAuth, expectedUserVolume) => {
    const fake = createFakeDb({
      cliInvocations: schema.cliInvocations,
      cliProviders: schema.cliProviders,
    });
    const providerId = '00000000-0000-4000-8000-000000000010';
    const taskId = '00000000-0000-4000-8000-000000000020';
    const userId = '11111111-1111-4111-8111-111111111111';
    fake.insert(schema.cliProviders, {
      ...provider,
      userId,
      id: providerId,
      isolateAuth,
      authMode,
    });
    fake.insert(schema.cliProviders, {
      ...provider,
      userId,
      id: '22222222-2222-4222-8222-222222222222',
      name: 'gemini',
    });
    for (const id of [
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ])
      fake.insert(schema.cliInvocations, { id, taskId, cliProviderId: providerId });
    const token = randomBytes(32).toString('hex');
    const copies: DockerRunOpts[] = [];
    const runner = {
      volumeExists: async () => true,
      run: async (opts: DockerRunOpts) => {
        if (opts.mounts?.length === 2) copies.push(opts);
        const task = opts.mounts?.[0]?.source.includes('_task_');
        return {
          exitCode: 0,
          stdout: opts.cmd[2]!.startsWith('stat')
            ? task
              ? '200'
              : '100'
            : JSON.stringify({
                tokens: { access_token: task ? token : randomBytes(32).toString('hex') },
              }),
          stderr: '',
        };
      },
    } as unknown as DockerRunner;
    // The fake supports SELECT filtering but has no DISTINCT builder. Adapt just that
    // boundary here, retaining its evaluation of the actual ledger predicate.
    const database = {
      ...fake.db,
      selectDistinct: (fields: { providerId: typeof schema.cliInvocations.cliProviderId }) => ({
        from: (table: typeof schema.cliInvocations) => ({
          where: async (where: SQL) => {
            const rows = await (fake.db as unknown as Database)
              .select(fields)
              .from(table)
              .where(where);
            return [...new Map(rows.map((row) => [row.providerId, row])).values()];
          },
        }),
      }),
    } as unknown as Database;
    await syncRefreshedAuthToUserVolumes(database, taskId, runner);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.mounts?.map((mount) => mount.source)).toEqual([
      'haive_cli_auth_task_000000000000_codex_0',
      expectedUserVolume,
    ]);
    expect(h.acquire).toHaveBeenCalledOnce();
  },
);

it('bounds teardown contention at thirty seconds without reading an unowned credential', async () => {
  vi.useFakeTimers();
  h.acquire.mockResolvedValue(null);
  const runner = { volumeExists: vi.fn(), run: vi.fn() };
  const pending = syncProviderAuthBack(
    'task',
    provider,
    {} as Database,
    runner as unknown as DockerRunner,
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await pending).toBe(false);
  expect(h.acquire).toHaveBeenCalledTimes(61);
  expect(runner.volumeExists).not.toHaveBeenCalled();
  expect(h.release).not.toHaveBeenCalled();
});
