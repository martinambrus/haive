import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tryCliAuthLock, type Database } from '@haive/database';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { CLI_LOGIN_CLOSE_CODES } from '@haive/shared/constants';
import { cleanActor, createDatabase, makeActor, schema } from './security-audit-db.js';

const url = process.env.CLI_SECRETS_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cli_secrets_audit_test'))
  throw new Error('Use a dedicated cli_secrets_audit_test database');

const h = vi.hoisted(() => ({
  db: undefined as Database | undefined,
  actor: '',
  beforeLock: undefined as (() => Promise<void>) | undefined,
  add: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/auth/jwt.js', () => ({
  verifyAccessToken: async () => ({ sub: h.actor, tv: 0 }),
}));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ add: h.add }),
}));
vi.mock('@haive/database', async (original) => {
  const real = await original<typeof import('@haive/database')>();
  return {
    ...real,
    tryCliAuthLock: async (db: Parameters<typeof real.tryCliAuthLock>[0], scope: string) => {
      await h.beforeLock?.();
      return real.tryCliAuthLock(db, scope);
    },
  };
});

import { installCliLoginBannerWebSocket } from '../src/routes/cli-login-banner.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

describe.skipIf(!url)('login banner refusal transport on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  let server: Server;
  let endpoint: string;
  let provider: typeof schema.cliProviders.$inferSelect;
  const clients: WebSocket[] = [];

  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    h.actor = (await makeActor(db)).id;
    h.beforeLock = undefined;
    h.add.mockClear();
    const [row] = await db
      .insert(schema.cliProviders)
      .values({
        userId: h.actor,
        name: 'claude-code',
        label: 'banner refusal',
      })
      .returning();
    provider = row!;
    server = createServer();
    installCliLoginBannerWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/cli-login-banner/${provider.id}`;
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanActor(db, provider.userId);
    expect(h.add).not.toHaveBeenCalled();
  });

  function connect(origin?: string): Promise<{ opened: boolean; code: number }> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(endpoint, {
        headers: { cookie: `${ACCESS_COOKIE}=synthetic-session`, ...(origin ? { origin } : {}) },
      });
      clients.push(ws);
      ws.on('open', () => {
        opened = true;
      });
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        ws.terminate();
        resolve({ opened, code: res.statusCode! });
      });
      ws.on('close', (code) => resolve({ opened, code }));
    });
  }

  async function expectScopeFree(scope: string) {
    const release = await tryCliAuthLock(db, scope);
    try {
      expect(release).not.toBeNull();
    } finally {
      await release?.();
    }
  }

  it('accepts a busy account socket, closes with its code, and leaves the holder alone', async () => {
    const scope = cliAuthScope(provider);
    const release = await tryCliAuthLock(db, scope);
    expect(release).not.toBeNull();
    try {
      expect(await connect()).toEqual({ opened: true, code: CLI_LOGIN_CLOSE_CODES.AUTH_BUSY });
      const contender = await tryCliAuthLock(db, scope);
      try {
        expect(contender).toBeNull();
      } finally {
        await contender?.();
      }
    } finally {
      await release?.();
    }
    await expectScopeFree(scope);
  });

  it('releases the old scope before accepting a settings-changed refusal', async () => {
    h.beforeLock = async () => {
      h.beforeLock = undefined;
      await db
        .update(schema.cliProviders)
        .set({ isolateAuth: true })
        .where(eq(schema.cliProviders.id, provider.id));
    };
    expect(await connect()).toEqual({ opened: true, code: CLI_LOGIN_CLOSE_CODES.SETTINGS_CHANGED });
    await expectScopeFree(cliAuthScope(provider));
    await expectScopeFree(cliAuthScope({ ...provider, isolateAuth: true }));
  });

  it('refuses a foreign origin before accepting even with valid auth and a busy scope', async () => {
    const release = await tryCliAuthLock(db, cliAuthScope(provider));
    try {
      expect(await connect('http://localhost:5173')).toEqual({ opened: false, code: 403 });
    } finally {
      await release?.();
    }
  });

  it.each(['authentication', 'ownership', 'unsupported'] as const)(
    'keeps the earlier %s refusal on HTTP',
    async (reason) => {
      if (reason === 'authentication') h.actor = randomUUID();
      if (reason === 'ownership') endpoint = endpoint.replace(provider.id, randomUUID());
      if (reason === 'unsupported')
        await db
          .update(schema.cliProviders)
          .set({ name: 'ollama' })
          .where(eq(schema.cliProviders.id, provider.id));
      expect(await connect()).toEqual({
        opened: false,
        code: reason === 'authentication' ? 401 : reason === 'ownership' ? 404 : 400,
      });
    },
  );
});
