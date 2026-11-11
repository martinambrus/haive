import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { cliAuthScope } from '@haive/shared/cli-auth-state';

const h = vi.hoisted(() => ({
  secret: null as string | null,
  volume: null as string | null,
  held: false,
  busy: false,
  acquire: vi.fn(),
  release: vi.fn(),
  fetch: vi.fn(),
  writesHeld: [] as boolean[],
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: h.acquire,
}));
vi.mock('../src/usage-window/token-source.js', () => ({
  readProviderSecretToken: async () => h.secret,
  readAuthVolumeFile: async () => h.volume,
  writeProviderSecret: vi.fn(),
}));
vi.mock('../src/usage-window/fetchers/index.js', async (original) => {
  const real = await original<typeof import('../src/usage-window/fetchers/index.js')>();
  return {
    ...real,
    USAGE_PROVIDERS: Object.fromEntries(
      Object.entries(real.USAGE_PROVIDERS).map(([name, cfg]) => [name, { ...cfg, fetch: h.fetch }]),
    ),
  };
});
vi.mock('../src/cli-adapters/probe-fetch.js', () => ({
  resolveProbeFetch: async () => fetch,
}));
import { runUsagePollTick } from '../src/queues/usage-poll-queue.js';

beforeEach(() => {
  h.held = false;
  h.busy = false;
  h.writesHeld = [];
  h.release.mockReset().mockImplementation(async () => {
    h.held = false;
  });
  h.acquire.mockReset().mockImplementation(async () => {
    if (h.busy) return null;
    h.held = true;
    return Object.assign(h.release, {
      assertHeld: async () => {
        if (!h.held) throw new Error('lock lost');
      },
    });
  });
  h.fetch.mockReset().mockResolvedValue({ ok: true, windows: { fiveHour: { usedPct: 12 } } });
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'get').mockResolvedValue('off');
});
afterEach(() => vi.restoreAllMocks());

function setup(name: 'zai' | 'claude-code' | 'codex' = 'zai') {
  h.secret =
    name === 'claude-code'
      ? JSON.stringify({ accessToken: 'synthetic-token', expiresAt: Date.now() + 3_600_000 })
      : 'synthetic-token';
  h.volume = JSON.stringify({ tokens: { access_token: 'synthetic-token', account_id: 'account' } });
  const fake = createFakeDb({
    cliProviders: schema.cliProviders,
    usageWindowSnapshots: schema.usageWindowSnapshots,
  });
  const provider = {
    id: randomUUID(),
    userId: randomUUID(),
    name,
    enabled: true,
    authMode: 'subscription' as const,
    isolateAuth: true,
    envVars: null,
    cliVersion: null,
  };
  fake.insert(schema.cliProviders, provider);
  fake.hooks.beforeInsert = async () => {
    h.writesHeld.push(h.held);
  };
  const tick = () => runUsagePollTick(fake.db as unknown as Database);
  return { fake, provider, tick };
}

it.each(['zai', 'claude-code', 'codex'] as const)(
  '%s: Disconnect between fetch and snapshot write leaves no snapshot',
  async (name) => {
    const t = setup(name);
    h.fetch.mockImplementation(async () => {
      expect(h.held).toBe(false);
      h.secret = null;
      h.volume = null;
      await t.fake.db
        .delete(schema.usageWindowSnapshots)
        .where(eq(schema.usageWindowSnapshots.providerId, t.provider.id));
      return { ok: true, windows: { fiveHour: { usedPct: 12 } } };
    });
    await t.tick();
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(t.fake.rows(schema.usageWindowSnapshots)).toHaveLength(0);
    expect(h.writesHeld).toEqual([]);
    expect(h.acquire).toHaveBeenCalledWith(t.fake.db, cliAuthScope(t.provider));
    expect(h.held).toBe(false);
  },
);

it.each(['zai', 'claude-code', 'codex'] as const)(
  '%s: writes a current snapshot under the scope lock, with no lock across the fetch',
  async (name) => {
    const t = setup(name);
    h.fetch.mockImplementation(async () => {
      expect(h.held).toBe(false);
      return { ok: true, windows: { fiveHour: { usedPct: 12 } } };
    });
    await t.tick();
    expect(t.fake.rows(schema.usageWindowSnapshots)).toMatchObject([
      { status: 'ok', fiveHourPct: 12 },
    ]);
    expect(h.writesHeld).toEqual([true]);
    expect(h.release).toHaveBeenCalledOnce();
  },
);

it('skips a stale result after credential replacement', async () => {
  const t = setup();
  h.fetch.mockImplementation(async () => {
    h.secret = 'synthetic-replacement';
    return { ok: false, error: 'temporary failure' };
  });
  await t.tick();
  expect(t.fake.rows(schema.usageWindowSnapshots)).toHaveLength(0);
});
it('skips a snapshot while Disconnect holds the scope', async () => {
  const t = setup();
  h.fetch.mockImplementation(async () => {
    h.busy = true;
    return { ok: false, error: 'temporary failure' };
  });
  await t.tick();
  expect(t.fake.rows(schema.usageWindowSnapshots)).toHaveLength(0);
});
it('skips a result when settings move the provider to another auth scope during fetch', async () => {
  const t = setup();
  h.fetch.mockImplementation(async () => {
    await t.fake.db
      .update(schema.cliProviders)
      .set({ isolateAuth: false })
      .where(eq(schema.cliProviders.id, t.provider.id));
    return { ok: true, windows: { fiveHour: { usedPct: 12 } } };
  });
  await t.tick();
  expect(t.fake.rows(schema.usageWindowSnapshots)).toHaveLength(0);
});

it('retries the denied-token snapshot after a busy write turn instead of gating it forever', async () => {
  const t = setup();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  h.fetch.mockResolvedValue({ ok: false, error: 'denied', authExpired: true });
  for (let i = 0; i < 3; i++) {
    h.busy = i === 2;
    now += 200_000;
    await t.tick();
  }
  expect(t.fake.rows(schema.usageWindowSnapshots)).toHaveLength(0);
  h.busy = false;
  now += 200_000;
  await t.tick();
  expect(h.fetch).toHaveBeenCalledTimes(4);
  expect(t.fake.rows(schema.usageWindowSnapshots)).toMatchObject([{ status: 'needs_reconnect' }]);
  expect(h.writesHeld).toEqual([true]);
});
it('refuses the snapshot write after losing the acquired lock', async () => {
  const t = setup();
  h.acquire.mockImplementation(async () =>
    Object.assign(h.release, {
      assertHeld: async () => {
        throw new Error('lock lost');
      },
    }),
  );
  await t.tick();
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(t.fake.rows(schema.usageWindowSnapshots)).toHaveLength(0);
  expect(h.release).toHaveBeenCalledOnce();
});
