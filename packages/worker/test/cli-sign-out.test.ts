import { describe, expect, it } from 'vitest';
import { handleSignOutJob } from '../src/queues/cli-exec-queue.js';
import type { Database } from '@haive/database';
import type {
  DockerRunner,
  DockerRunOpts,
  DockerVolumeOpResult,
} from '../src/sandbox/docker-runner.js';

interface ProviderRowOverrides {
  id?: string;
  userId?: string;
  name?: string;
  isolateAuth?: boolean;
}

function makeProviderRow(overrides: ProviderRowOverrides = {}) {
  return {
    id: overrides.id ?? 'prov-default',
    userId: overrides.userId ?? 'user-1',
    name: overrides.name ?? 'gemini',
    isolateAuth: overrides.isolateAuth ?? false,
    label: 'test',
    executablePath: null,
    wrapperPath: null,
    envVars: null,
    cliArgs: null,
    supportsSubagents: false,
    networkPolicy: { mode: 'full' as const, domains: [], ips: [] },
    authMode: 'subscription' as const,
    cliVersion: null,
    effortLevel: null,
    sandboxDockerfileExtra: null,
    sandboxImageTag: null,
    sandboxImageBuildStatus: 'idle' as const,
    sandboxImageBuildError: null,
    sandboxImageBuiltAt: null,
    enabled: true,
    authStatus: 'ok' as const,
    authLastCheckedAt: null,
    authMessage: null,
    rulesContent: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    wrapperContent: null,
  };
}

interface DbCalls {
  updateSet: Record<string, unknown> | null;
}

function makeDb(row: ReturnType<typeof makeProviderRow> | null, calls: DbCalls): Database {
  return {
    query: {
      cliProviders: {
        async findFirst() {
          return row;
        },
      },
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          calls.updateSet = values;
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as Database;
}

interface MockRunner extends DockerRunner {
  existing: Set<string>;
  removed: string[];
}

function makeRunner(opts: { existing?: string[]; removeFails?: string[] } = {}): MockRunner {
  const existing = new Set<string>(opts.existing ?? []);
  const removed: string[] = [];
  const failSet = new Set<string>(opts.removeFails ?? []);
  return {
    existing,
    removed,
    async build() {
      throw new Error('not used');
    },
    async run(_opts: DockerRunOpts) {
      throw new Error('not used');
    },
    async inspect() {
      return { exists: false, imageId: null };
    },
    async remove() {
      return { ok: true, stderr: '' };
    },
    async volumeCreate(): Promise<DockerVolumeOpResult> {
      return { ok: true, stderr: '' };
    },
    async volumeExists(name: string) {
      return existing.has(name);
    },
    async volumeRemove(name: string): Promise<DockerVolumeOpResult> {
      if (failSet.has(name)) return { ok: false, stderr: 'in use' };
      existing.delete(name);
      removed.push(name);
      return { ok: true, stderr: '' };
    },
  };
}

describe('handleSignOutJob', () => {
  it('returns ok=false silently when provider not found', async () => {
    const calls: DbCalls = { updateSet: null };
    const db = makeDb(null, calls);
    const runner = makeRunner();
    const result = await handleSignOutJob(db, { providerId: 'missing', userId: 'user-1' }, runner);
    expect(result).toEqual({ ok: false, removed: [], failed: [] });
    expect(runner.removed).toEqual([]);
    expect(calls.updateSet).toBeNull();
  });

  it('refuses to act on a provider that belongs to a different user', async () => {
    const calls: DbCalls = { updateSet: null };
    const row = makeProviderRow({ userId: 'owner-A' });
    const db = makeDb(row, calls);
    const runner = makeRunner({ existing: ['haive_cli_auth_user1_gemini_1'] });
    const result = await handleSignOutJob(db, { providerId: row.id, userId: 'attacker-B' }, runner);
    expect(result.ok).toBe(false);
    expect(runner.removed).toEqual([]);
  });

  it('shared (non-isolated) provider removes per-user volume namespace', async () => {
    const userId = 'aaaa-bbbb-cccc-ee';
    const userSlug = 'aaaabbbbccccee'.replace(/-/g, '').slice(0, 12);
    const expectedVolName = `haive_cli_auth_${userSlug}_gemini_1`;
    const calls: DbCalls = { updateSet: null };
    const row = makeProviderRow({ userId, isolateAuth: false });
    const db = makeDb(row, calls);
    // gemini has 2 authConfigPaths; only idx=1 exists.
    const runner = makeRunner({ existing: [expectedVolName] });
    const result = await handleSignOutJob(db, { providerId: row.id, userId }, runner);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([expectedVolName]);
    expect(calls.updateSet?.authStatus).toBe('unknown');
    expect(calls.updateSet?.authMessage).toBeNull();
  });

  it('isolated provider removes ONLY per-provider volume, not user-shared', async () => {
    const calls: DbCalls = { updateSet: null };
    const providerId = 'pppp-qqqq-rrrr-ssss';
    const providerSlug = 'ppppqqqqrrrr';
    const userId = 'uuuu-uuuu-uuuu';
    const userSlug = 'uuuuuuuuuuuu';
    const isolatedVol = `haive_cli_auth_p_${providerSlug}_gemini_1`;
    const sharedVol = `haive_cli_auth_${userSlug}_gemini_1`;
    const row = makeProviderRow({ id: providerId, userId, isolateAuth: true });
    const db = makeDb(row, calls);
    const runner = makeRunner({ existing: [isolatedVol, sharedVol] });
    const result = await handleSignOutJob(db, { providerId, userId }, runner);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([isolatedVol]);
    // Crucially: the shared volume must remain so other providers stay signed in.
    expect(runner.existing.has(sharedVol)).toBe(true);
  });

  it('skips volumes that do not exist (idempotent on already-signed-out)', async () => {
    const calls: DbCalls = { updateSet: null };
    const row = makeProviderRow();
    const db = makeDb(row, calls);
    const runner = makeRunner();
    const result = await handleSignOutJob(db, { providerId: row.id, userId: row.userId }, runner);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    // authStatus is still reset on the empty-but-successful path so the UI
    // re-syncs even when the underlying volumes were absent.
    expect(calls.updateSet?.authStatus).toBe('unknown');
  });

  it('reports failed volumes and skips authStatus reset when remove fails', async () => {
    const calls: DbCalls = { updateSet: null };
    const userId = 'failuser-1234';
    const userSlug = 'failuser1234';
    const failVol = `haive_cli_auth_${userSlug}_gemini_0`;
    const row = makeProviderRow({ userId });
    const db = makeDb(row, calls);
    const runner = makeRunner({ existing: [failVol], removeFails: [failVol] });
    const result = await handleSignOutJob(db, { providerId: row.id, userId }, runner);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ name: failVol, stderr: 'in use' }]);
    expect(calls.updateSet).toBeNull();
  });
});
