import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { eq } from 'drizzle-orm';
import { configService } from '@haive/shared';
import { guardedProbeFetch } from '@haive/shared/egress';

vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: async () => Object.assign(async () => {}, { assertHeld: async () => {} }),
}));

vi.mock('../src/usage-window/token-source.js', () => ({
  readProviderSecretToken: async () => 'fixture-token',
  readAuthVolumeFile: async () => null,
  writeProviderSecret: vi.fn(),
}));

import { runUsagePollTick } from '../src/queues/usage-poll-queue.js';

const privateUrl = 'http://10.23.45.67:8123';
const usageBody = JSON.stringify({ data: [{ type: 'TOKENS_LIMIT', percentage: 12 }] });
let serial = 0;
let clock = Date.now();
const globalFetch = vi.fn<typeof fetch>();

function setup(baseUrl: string | null = privateUrl) {
  const provider = {
    id: `egress-provider-${++serial}`,
    userId: 'owner-1',
    name: 'zai',
    cliVersion: null,
    authMode: 'api_key',
    isolateAuth: false,
    envVars: baseUrl === null ? null : { ANTHROPIC_BASE_URL: baseUrl },
  };
  const findOwner = vi
    .fn<() => Promise<{ role: string } | undefined>>()
    .mockResolvedValue({ role: 'user' });
  const rows: Record<string, unknown>[] = [];
  const db = {
    query: {
      users: { findFirst: findOwner },
      cliProviders: { findMany: async () => [provider], findFirst: async () => provider },
    },
    insert: (table: unknown) => {
      expect(table).toBe(schema.usageWindowSnapshots);
      return {
        values: (row: Record<string, unknown>) => ({
          onConflictDoUpdate: async () => {
            rows.push(row);
          },
        }),
      };
    },
  } as unknown as Database;
  const tick = async () => {
    clock += 70_000;
    await runUsagePollTick(db);
  };
  return { provider, db, rows, findOwner, tick };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  // No recovery work is needed to inspect the poll's snapshot writes.
  vi.spyOn(configService, 'get').mockResolvedValue('off');
  vi.spyOn(http, 'request').mockImplementation(() => {
    throw new Error('unexpected socket');
  });
  vi.spyOn(https, 'request').mockImplementation(() => {
    throw new Error('unexpected socket');
  });
  globalFetch.mockReset().mockImplementation(async () => new Response(usageBody));
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Z.AI usage poll owner egress', () => {
  it('refuses a non-admin private literal without sending the token', async () => {
    const t = setup();
    await t.tick();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
    expect(t.findOwner).toHaveBeenCalledExactlyOnceWith({
      where: eq(schema.users.id, t.provider.userId),
      columns: { role: true },
    });
    expect(t.rows).toMatchObject([{ status: 'error', errorMessage: 'fetch failed' }]);
  });

  it('uses plain fetch with the raw token for an admin', async () => {
    const t = setup();
    t.findOwner.mockResolvedValue({ role: 'admin' });
    await t.tick();
    expect(globalFetch).toHaveBeenCalledExactlyOnceWith(
      `${privateUrl}/api/monitor/usage/quota/limit`,
      expect.objectContaining({
        headers: { Authorization: 'fixture-token', Accept: 'application/json' },
      }),
    );
    expect(t.rows).toMatchObject([{ status: 'ok', fiveHourPct: 12 }]);
  });

  it.each([undefined, { role: 'administrator' }])('guards owner %j', async (owner) => {
    const t = setup();
    t.findOwner.mockResolvedValue(owner);
    await t.tick();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
    expect(t.rows).toMatchObject([{ status: 'error' }]);
  });

  it('uses plain fetch without a role read when no URL was hand-set', async () => {
    const t = setup(null);
    t.findOwner.mockRejectedValue(new Error('role query must not run'));
    await t.tick();
    expect(t.findOwner).not.toHaveBeenCalled();
    expect(globalFetch).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.anything(),
    );
    expect(t.rows).toMatchObject([{ status: 'ok' }]);
  });

  it('keeps refusal indistinguishable from a missing name in the stored row', async () => {
    const refused = setup();
    await refused.tick();
    const missing = setup('http://missing.invalid');
    missing.findOwner.mockResolvedValue({ role: 'admin' });
    globalFetch.mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    await missing.tick();
    expect(refused.rows[0]?.status).toBe('error');
    expect(refused.rows[0]?.errorMessage).toBe(missing.rows[0]?.errorMessage);
  });

  it('keeps the guard transport error structure', async () => {
    await expect(guardedProbeFetch(privateUrl)).rejects.toMatchObject({
      name: 'TypeError',
      cause: { code: 'ENOTFOUND' },
    });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('does not back off, suppress the token or request reconnect after repeated refusals', async () => {
    const t = setup();
    for (let i = 0; i < 4; i++) await t.tick();
    expect(t.rows.map((r) => r.status)).toEqual(['error', 'error', 'error', 'error']);
    expect(globalFetch).not.toHaveBeenCalled();
    t.findOwner.mockResolvedValue({ role: 'admin' });
    await t.tick();
    expect(t.rows.at(-1)?.status).toBe('ok');
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it('resets auth strikes on refusal instead of adding an auth strike', async () => {
    const t = setup();
    t.findOwner.mockResolvedValue({ role: 'admin' });
    globalFetch.mockImplementation(async () => new Response('', { status: 401 }));
    await t.tick();
    await t.tick();
    expect(t.rows).toHaveLength(0);
    t.findOwner.mockResolvedValue({ role: 'user' });
    await t.tick();
    expect(t.rows.map((r) => r.status)).toEqual(['error']);
    t.findOwner.mockResolvedValue({ role: 'admin' });
    await t.tick();
    expect(t.rows).toHaveLength(1);
  });
});
