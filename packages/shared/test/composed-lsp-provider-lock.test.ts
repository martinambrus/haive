import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  checkTaskComposedLspProvider,
  decideComposedLspProviderLock,
  lockTaskForComposedLsp,
  withComposedLspTransaction,
  type ComposedLspLockProvider,
} from '../src/composed-lsp-provider-lock.js';

const id = (n: number) => `00000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const CLAUDE = id(1);
const CLAUDE_2 = id(2);
const CODEX = id(3);
const provider = (pid: string, name: string, enabled = true): ComposedLspLockProvider => ({
  id: pid,
  name,
  enabled,
});

describe('decideComposedLspProviderLock', () => {
  const claude = provider(CLAUDE, 'claude-code');

  it('accepts one enabled claude-code row, and duplicates of it', () => {
    expect(
      decideComposedLspProviderLock({ effectiveProviderIds: [CLAUDE], providers: [claude] }),
    ).toEqual({ ok: true, providerId: CLAUDE });
    expect(
      decideComposedLspProviderLock({
        effectiveProviderIds: [CLAUDE, null, CLAUDE, undefined],
        providers: [claude],
      }),
    ).toEqual({ ok: true, providerId: CLAUDE });
  });

  it('refuses two distinct claude-code rows', () => {
    const d = decideComposedLspProviderLock({
      effectiveProviderIds: [CLAUDE, CLAUDE_2],
      providers: [claude, provider(CLAUDE_2, 'claude-code')],
    });
    expect(d).toMatchObject({
      ok: false,
      violation: { code: 'multiple_providers', providerIds: [CLAUDE, CLAUDE_2] },
    });
  });

  it.each(['codex', 'grok', 'zai', 'ollama', 'muse', 'openrouter'])(
    'refuses %s as unverified',
    (name) => {
      const d = decideComposedLspProviderLock({
        effectiveProviderIds: [CODEX],
        providers: [provider(CODEX, name)],
      });
      expect(d).toMatchObject({
        ok: false,
        violation: { code: 'unverified_provider', providerId: CODEX, providerName: name },
      });
    },
  );

  it('names the first offender in first-appearance order', () => {
    const d = decideComposedLspProviderLock({
      effectiveProviderIds: [CLAUDE, CODEX],
      providers: [claude, provider(CODEX, 'codex')],
    });
    expect(d).toMatchObject({
      ok: false,
      violation: { code: 'unverified_provider', providerId: CODEX, providerName: 'codex' },
    });
    if (!d.ok) expect(d.message).toContain('codex');
  });

  it('refuses an unknown id with a null name', () => {
    expect(
      decideComposedLspProviderLock({ effectiveProviderIds: [CODEX], providers: [claude] }),
    ).toMatchObject({
      ok: false,
      violation: { code: 'unverified_provider', providerId: CODEX, providerName: null },
    });
  });

  it('refuses a disabled claude-code row', () => {
    expect(
      decideComposedLspProviderLock({
        effectiveProviderIds: [CLAUDE],
        providers: [provider(CLAUDE, 'claude-code', false)],
      }),
    ).toMatchObject({ ok: false, violation: { code: 'disabled_provider', providerId: CLAUDE } });
  });

  it('reports no_provider for an empty or all-null list', () => {
    for (const ids of [[], [null, undefined]]) {
      expect(
        decideComposedLspProviderLock({ effectiveProviderIds: ids, providers: [claude] }),
      ).toMatchObject({ ok: false, violation: { code: 'no_provider' } });
    }
  });
});

describe('checkTaskComposedLspProvider', () => {
  const USER = id(0xa1);
  const OTHER = id(0xa2);
  const TASK = id(0xb1);
  const TEMPLATE = id(0xc1);

  function setup(opts: { template?: Record<string, unknown> | null; taskCli?: string | null }) {
    const fake = createFakeDb({
      tasks: schema.tasks,
      cliProviders: schema.cliProviders,
      envTemplates: schema.envTemplates,
    });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      cliProviderId: opts.taskCli ?? null,
      envTemplateId: opts.template === undefined ? null : TEMPLATE,
    });
    if (opts.template !== undefined)
      fake.insert(schema.envTemplates, {
        id: TEMPLATE,
        userId: USER,
        name: 't',
        baseImage: 'img',
        declaredDeps: opts.template,
      });
    fake.insert(schema.cliProviders, {
      id: CLAUDE,
      userId: USER,
      name: 'claude-code',
      enabled: true,
      createdAt: new Date(1),
    });
    fake.insert(schema.cliProviders, {
      id: CLAUDE_2,
      userId: USER,
      name: 'claude-code',
      enabled: true,
      createdAt: new Date(2),
    });
    fake.insert(schema.cliProviders, {
      id: CODEX,
      userId: USER,
      name: 'codex',
      enabled: true,
      createdAt: new Date(3),
    });
    fake.insert(schema.cliProviders, {
      id: id(4),
      userId: OTHER,
      name: 'claude-code',
      enabled: true,
      createdAt: new Date(1),
    });
    return fake.db as unknown as Database;
  }
  const run = (db: Database, providerId: string) =>
    checkTaskComposedLspProvider(db, { userId: USER, taskId: TASK, providerId });

  it('does not apply without a template or without contract 2', async () => {
    expect(await run(setup({}), CODEX)).toBeNull();
    expect(await run(setup({ template: {} }), CODEX)).toBeNull();
    expect(await run(setup({ template: { lspInstallContractVersion: 1 } }), CODEX)).toBeNull();
  });

  const v2 = { lspInstallContractVersion: 2 };

  it('accepts the default claude row under contract 2', async () => {
    expect(await run(setup({ template: v2 }), CLAUDE)).toEqual({ ok: true, providerId: CLAUDE });
  });

  it('refuses codex, a second claude row and a foreign provider under contract 2', async () => {
    const db = setup({ template: v2 });
    expect(await run(db, CODEX)).toMatchObject({
      ok: false,
      violation: { code: 'unverified_provider', providerName: 'codex' },
    });
    expect(await run(db, CLAUDE_2)).toMatchObject({
      ok: false,
      violation: { code: 'multiple_providers' },
    });
    expect(await run(db, id(4))).toMatchObject({
      ok: false,
      violation: { code: 'unverified_provider', providerId: id(4), providerName: null },
    });
  });
});

describe('lockTaskForComposedLsp', () => {
  const run = (rows: { cliProviderId: string | null }[]) => {
    const calls: { from?: unknown; where?: unknown; lock: unknown[] } = { lock: [] };
    const chain = {
      from: vi.fn((table: unknown) => {
        calls.from = table;
        return chain;
      }),
      where: vi.fn((cond: unknown) => {
        calls.where = cond;
        return chain;
      }),
      for: vi.fn((mode: unknown) => {
        calls.lock.push(mode);
        return Promise.resolve(rows);
      }),
    };
    const tx = { select: vi.fn(() => chain) } as unknown as Pick<Database, 'select'>;
    return { calls, result: lockTaskForComposedLsp(tx, { userId: 'u-1', taskId: 't-1' }) };
  };

  it('selects the task row scoped by id and user, locked FOR NO KEY UPDATE once', async () => {
    const { calls, result } = run([{ cliProviderId: CLAUDE }]);
    expect(await result).toEqual({ cliProviderId: CLAUDE });
    expect(calls.from).toBe(schema.tasks);
    expect(calls.lock).toEqual(['no key update']);
    const query = new PgDialect().sqlToQuery(calls.where as SQL);
    expect(query.sql).toContain('"tasks"."id" = $1');
    expect(query.sql).toContain('"tasks"."user_id" = $2');
    expect(query.params).toEqual(['t-1', 'u-1']);
  });

  it("returns null when the task is not the user's", async () => {
    expect(await run([]).result).toBeNull();
  });
});

describe('composed choice transaction deadlock recovery', () => {
  it('retries one whole transaction on a wrapped SQLSTATE 40P01', async () => {
    const db = {
      transaction: vi
        .fn()
        .mockRejectedValueOnce(new Error('opaque', { cause: { code: '40P01' } }))
        .mockResolvedValueOnce('saved'),
    };
    expect(await withComposedLspTransaction(db as unknown as Database, async () => 'saved')).toBe(
      'saved',
    );
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });
  it('returns a stable retryable refusal after a second deadlock', async () => {
    const db = { transaction: vi.fn().mockRejectedValue({ code: '40P01' }) };
    await expect(
      withComposedLspTransaction(db as unknown as Database, async () => null),
    ).rejects.toMatchObject({ code: 'composed_lsp_write_busy', retryable: true });
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });
  it('does not retry another SQLSTATE or wording that mentions deadlock', async () => {
    const error = Object.assign(new Error('deadlock 40P01'), { code: '23503' });
    const db = { transaction: vi.fn().mockRejectedValue(error) };
    await expect(
      withComposedLspTransaction(db as unknown as Database, async () => null),
    ).rejects.toBe(error);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
