import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { CONFIG_KEYS } from '@haive/shared';
import { logger } from '@haive/shared/logger';
import { eq } from 'drizzle-orm';
import { DATA_MIGRATIONS } from '../src/data-migrations.js';
import { seedPrivateEndpointAllowlist, type SeedDeps } from '../src/private-endpoint-seed.js';

const url = process.env.PRIVATE_ENDPOINT_SEED_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/private_endpoint_seed_test')) {
  throw new Error('Use a dedicated private_endpoint_seed_test database');
}

const KEY = CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST;
const NIL_ACTOR = '00000000-0000-0000-0000-000000000000';
const addr = (address: string): dns.LookupAddress => ({
  address,
  family: address.includes(':') ? 6 : 4,
});
const NAMES: Record<string, string> = {
  'ollama-box.lan': '10.0.0.11',
  'rag-db.lan': '10.0.0.12',
  'ddev-db.lan': '192.168.1.13',
  'forge.lan': '172.16.0.14',
  'api.forge.lan': '172.16.0.15',
  'embed.lan': '10.0.0.16',
  'mirror.lan': '10.0.0.17',
  'task.lan': '10.0.0.18',
  'old.lan': '10.0.0.19',
  'host.docker.internal': '172.17.0.1',
  'public.example': '93.184.216.34',
};
const lookups: string[] = [];
const resolve = async (host: string): Promise<dns.LookupAddress[]> => {
  lookups.push(host);
  const found = NAMES[host];
  if (!found) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  return [addr(found)];
};

function fakeConfig(initial?: string, opts: { raceWith?: string; failSet?: boolean } = {}) {
  const store = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]]);
  return {
    store,
    getFresh: async (key: string) => store.get(key) ?? null,
    setIfAbsent: vi.fn(async (key: string, value: string) => {
      if (opts.failSet) throw new Error('redis down');
      if (opts.raceWith !== undefined) {
        store.set(key, opts.raceWith);
        return false;
      }
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    }),
  };
}

describe.skipIf(!url)('one-time seed of the private endpoint allowlist', () => {
  let db: Database;
  let userId: string;
  const lines: string[] = [];

  const deps = (config: ReturnType<typeof fakeConfig>): SeedDeps => ({
    config,
    plan: { resolvers: { dns: resolve, system: resolve } },
  });
  const audits = () =>
    db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'config.private_endpoint_allowlist'));
  const repo = async (tooling?: Record<string, unknown>, schemaVersion = 1) => {
    const [row] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'fixture',
        source: 'blank',
        ...(tooling ? { onboardingTooling: { schemaVersion, tooling } } : {}),
      })
      .returning({ id: schema.repositories.id });
    return row!.id;
  };
  const onboardingTask = async (
    repositoryId: string,
    rounds: Array<Record<string, unknown>>,
    createdAt?: Date,
  ) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'onboarding',
        title: 'onboarding',
        ...(createdAt ? { createdAt } : {}),
      })
      .returning({ id: schema.tasks.id });
    for (const [round, tooling] of rounds.entries()) {
      await db.insert(schema.taskSteps).values({
        taskId: task!.id,
        stepId: '04-tooling-infrastructure',
        stepIndex: 4,
        round,
        title: 'tooling',
        output: { tooling },
      });
    }
    return task!.id;
  };
  const credential = (host: string, provider: string | null, apiBaseUrl: string | null = null) =>
    db.insert(schema.repoCredentials).values({
      userId,
      label: host,
      host,
      usernameEncrypted: 'x',
      secretEncrypted: 'x',
      encryptedDek: 'x',
      provider,
      apiBaseUrl,
    });

  beforeAll(async () => {
    db = createDatabase(url!);
  });
  beforeEach(async () => {
    await db.delete(schema.auditEvents);
    await db.delete(schema.users);
    userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    lines.length = 0;
    lookups.length = 0;
    const key = Object.getOwnPropertySymbols(logger).find((s) => s.description === 'pino.stream')!;
    const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
    vi.spyOn(stream, 'write').mockImplementation((line) => {
      lines.push(line);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db.delete(schema.auditEvents);
    await db.delete(schema.users);
    await db.$client.end({ timeout: 5 });
  });

  it('seeds from the global KB url, repository tooling and forge credentials, with one audit row', async () => {
    const config = fakeConfig();
    config.store.set(CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL, ' http://ollama-box.lan:11434 ');
    await repo({
      ragMode: 'external',
      ragConnectionString: 'postgres://u:pw@rag-db.lan:5432/rag',
      ollamaUrl: 'http://embed.lan:11434',
    });
    await repo({ ragMode: 'ddev', ragConnectionString: 'postgres://db:db@ddev-db.lan:5432/db' });
    await credential('forge.lan:8443', 'gitea', 'https://api.forge.lan/api/v1');
    await credential('old.lan', null, 'https://task.lan/api');

    await seedPrivateEndpointAllowlist(db, deps(config));

    const text = config.store.get(KEY)!;
    expect(text.split('\n')).toEqual([
      'api.forge.lan',
      'ddev-db.lan',
      'embed.lan',
      'forge.lan',
      'ollama-box.lan',
      'rag-db.lan',
    ]);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: NIL_ACTOR,
      action: 'config.private_endpoint_allowlist',
      targetType: 'system',
      targetId: null,
      metadata: { from: '', to: text, seeded: true },
    });
  });

  it('reads the repository mirror first and ignores the onboarding task when the mirror has tooling', async () => {
    const id = await repo({
      ragMode: 'external',
      ragConnectionString: 'postgres://u:p@rag-db.lan/rag',
    });
    await onboardingTask(id, [
      { ragMode: 'external', ragConnectionString: 'postgres://u:p@old.lan/rag' },
    ]);
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('rag-db.lan');
  });

  it('falls back to the newest onboarding task newest-round output when the mirror has no tooling', async () => {
    const id = await repo();
    await onboardingTask(
      id,
      [{ ragMode: 'ddev', ragConnectionString: 'postgres://u:p@old.lan/db' }],
      new Date('2026-01-01'),
    );
    await onboardingTask(
      id,
      [
        { ragMode: 'ddev', ragConnectionString: 'postgres://u:p@task.lan/db' },
        { ragMode: 'ddev', ragConnectionString: 'postgres://u:p@mirror.lan/db' },
      ],
      new Date('2026-06-01'),
    );
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('mirror.lan');
  });

  it('falls back when the mirror has another schema version', async () => {
    const id = await repo(
      { ragMode: 'external', ragConnectionString: 'postgres://u:p@old.lan/db' },
      99,
    );
    await onboardingTask(id, [
      { ragMode: 'external', ragConnectionString: 'postgres://u:p@task.lan/db' },
    ]);
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('task.lan');
  });

  it('ignores a repository whose rag mode is none, even with a stored dsn and url', async () => {
    await repo({
      ragMode: 'none',
      ragConnectionString: 'postgres://u:p@rag-db.lan/rag',
      ollamaUrl: 'http://embed.lan:11434',
    });
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('');
    expect(await audits()).toHaveLength(0);
  });

  it('takes the ollama url of an internal repository but not its stored connection string', async () => {
    await repo({
      ragMode: 'internal',
      ragConnectionString: 'postgres://u:p@rag-db.lan/rag',
      ollamaUrl: 'http://embed.lan:11434',
    });
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('embed.lan');
  });

  it('skips the built-in targets', async () => {
    const config = fakeConfig();
    config.store.set(CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL, 'http://host.docker.internal:11434');
    await repo({ ragMode: 'internal', ollamaMode: 'internal' });
    await repo({
      ragMode: 'external',
      ragConnectionString: 'postgres://u:p@public.example/r',
      ollamaUrl: 'http://ollama:11434',
    });
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('');
    expect(await audits()).toHaveLength(0);
  });

  it('leaves an existing empty list alone and writes no audit row', async () => {
    await repo({ ragMode: 'external', ragConnectionString: 'postgres://u:p@rag-db.lan/rag' });
    const config = fakeConfig('');
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('');
    expect(config.setIfAbsent).not.toHaveBeenCalled();
    expect(lookups).toEqual([]);
    expect(await audits()).toHaveLength(0);
  });

  it('does not even look at the install when the key exists and nothing would be seeded', async () => {
    const config = fakeConfig('');
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.setIfAbsent).not.toHaveBeenCalled();
  });

  it('leaves an existing non-empty list alone', async () => {
    await repo({ ragMode: 'external', ragConnectionString: 'postgres://u:p@rag-db.lan/rag' });
    const config = fakeConfig('10.1.1.1');
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('10.1.1.1');
    expect(config.setIfAbsent).not.toHaveBeenCalled();
    expect(lookups).toEqual([]);
    expect(await audits()).toHaveLength(0);
  });

  it('writes an empty list and no audit row when nothing needs seeding', async () => {
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('');
    expect(await audits()).toHaveLength(0);
  });

  it('takes back the audit row and logs no error when another writer wins the race', async () => {
    await repo({ ragMode: 'external', ragConnectionString: 'postgres://u:p@rag-db.lan/rag' });
    const config = fakeConfig(undefined, { raceWith: '10.2.2.2' });
    await expect(seedPrivateEndpointAllowlist(db, deps(config))).resolves.toBeUndefined();
    expect(config.store.get(KEY)).toBe('10.2.2.2');
    expect(await audits()).toHaveLength(0);
    expect(
      lines.map((line) => JSON.parse(line) as { level: number }).filter((l) => l.level >= 40),
    ).toEqual([]);
  });

  it('is a no-op the second time', async () => {
    await repo({ ragMode: 'external', ragConnectionString: 'postgres://u:p@rag-db.lan/rag' });
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('rag-db.lan');
    expect(await audits()).toHaveLength(1);
    expect(config.setIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('leaves no audit row when the config write throws, and a later run seeds', async () => {
    await repo({ ragMode: 'external', ragConnectionString: 'postgres://u:p@rag-db.lan/rag' });
    await expect(
      seedPrivateEndpointAllowlist(db, deps(fakeConfig(undefined, { failSet: true }))),
    ).rejects.toThrow();
    expect(await audits()).toHaveLength(0);
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    expect(config.store.get(KEY)).toBe('rag-db.lan');
    expect(await audits()).toHaveLength(1);
  });

  it('never logs a stored dsn password or a malformed dsn', async () => {
    const pw = randomUUID();
    const brokenPw = randomUUID();
    await repo({
      ragMode: 'external',
      ragConnectionString: `postgres://admin:${pw}@rag-db.lan/rag`,
    });
    await repo({
      ragMode: 'external',
      ragConnectionString: `postgres://admin:${brokenPw}@db.lan:notaport/rag`,
    });
    const config = fakeConfig();
    await seedPrivateEndpointAllowlist(db, deps(config));
    const logged = lines.join('');
    expect(logged).not.toContain(pw);
    expect(logged).not.toContain(brokenPw);
    expect(logged).toContain('rag-db.lan');
  });

  it('is registered as convergent, right after the global KB vector classifier', () => {
    const ids = DATA_MIGRATIONS.map((m) => m.id);
    const index = ids.indexOf('seedPrivateEndpointAllowlist');
    expect(index).toBeGreaterThan(-1);
    expect(ids[index - 1]).toBe('classifyGlobalKbVectorProvenance');
    expect(DATA_MIGRATIONS[index]!.kind).toBe('convergent');
  });
});
