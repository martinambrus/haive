import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { Duplex } from 'node:stream';
import type Docker from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  ws: undefined as unknown,
  stream: undefined as unknown,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  save: vi.fn(),
  queueError: undefined as Error | undefined,
  probeError: undefined as Error | undefined,
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  logger: { child: () => h.log },
  secretsService: { getMasterKek: async () => Buffer.alloc(32) },
  upsertProviderSecret: h.save,
}));
vi.mock('ws', async (original) => ({
  ...(await original<typeof import('ws')>()),
  WebSocketServer: class {
    handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, cb: (ws: unknown) => void) {
      cb(h.ws);
    }
  },
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/auth/jwt.js', () => ({ verifyAccessToken: async () => ({ sub: 'user', tv: 0 }) }));
vi.mock('../src/routes/terminal.js', () => ({ attachContainerStream: async () => h.stream }));
vi.mock('../src/queues.js', () => ({
  getCliExecQueueEvents: () => ({}),
  getUsagePollQueue: () => ({ add: async () => ({}) }),
  getCliExecQueue: () => ({
    add: async (name: string) => {
      if (h.queueError) throw h.queueError;
      return {
        getState: async () => 'active',
        waitUntilFinished: async () => {
          if (name !== 'cli-login-create' && h.probeError) throw h.probeError;
          return name === 'cli-login-create'
            ? { ok: true, containerRowId: 'row', dockerContainerId: 'container' }
            : { cli: { authStatus: 'ok' } };
        },
      };
    },
  }),
}));

import { installCliLoginBannerWebSocket } from '../src/routes/cli-login-banner.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import type { CliProviderName } from '@haive/shared';

// Synthetic credentials only. Assertions return booleans so failures never print their text.
const TOKEN = 'sk-ant-oat01-' + 'Az9_xQ7-vR2'.repeat(10).slice(0, 95);
const CODE = 'ZXCV-9876';
const PROVIDER = '11111111-2222-4333-8444-555555555555';
let ws: EventEmitter & { readyState: number; send: ReturnType<typeof vi.fn>; close: () => void };
let stream: Duplex;
let providerName: CliProviderName;
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.save.mockReset();
  h.queueError = undefined;
  h.probeError = undefined;
  providerName = 'claude-code';
  h.db = {
    query: {
      users: { findFirst: async () => ({ id: 'user', status: 'active', tokenVersion: 0 }) },
      cliProviders: { findFirst: async () => ({ id: PROVIDER, name: providerName, envVars: {} }) },
    },
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: vi.fn(),
    ping: vi.fn(),
    close: () => {
      ws.readyState = 3;
      ws.emit('close');
    },
  });
  stream = new Duplex({
    read() {},
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
  h.ws = ws;
  h.stream = stream;
});
afterEach(async () => {
  ws.close();
  await settle();
  vi.useRealTimers();
});

async function start(query = '', attached = true, providerId = PROVIDER) {
  const server = new EventEmitter();
  const docker = {
    getContainer: () => ({ start: async () => {}, remove: async () => {}, resize: async () => {} }),
  } as unknown as Docker;
  installCliLoginBannerWebSocket(server as Server, { docker });
  server.emit(
    'upgrade',
    {
      url: `/cli-login-banner/${providerId}${query}`,
      headers: { cookie: `${ACCESS_COOKIE}=synthetic-session` },
    },
    { write: vi.fn(), destroy: vi.fn() },
    Buffer.alloc(0),
  );
  await settle();
  if (attached) expect(stream.listenerCount('data')).toBe(1);
}
function assertNoCredentialText(...values: string[]) {
  const strings: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    // Error.message and Error.stack are not enumerable, but a logger serializes them.
    for (const key of Object.getOwnPropertyNames(value)) {
      strings.push(key);
      visit((value as Record<string, unknown>)[key]);
    }
  };
  visit(Object.values(h.log).flatMap((fn) => fn.mock.calls));
  const logged = strings.join('\n');
  const leaked = values.some((value) =>
    Array.from({ length: value.length - 5 }, (_, i) => value.slice(i, i + 6)).some((part) =>
      logged.includes(part),
    ),
  );
  expect(leaked).toBe(false);
}
function paste() {
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'token-input', token: CODE })));
}

describe('CLI login banner credential logging', () => {
  it('captures a wrapped Claude token without logging any six-character substring', async () => {
    await start();
    stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
    paste();
    stream.emit('data', Buffer.from(`${TOKEN.slice(0, 47)}\n${TOKEN.slice(47)}\n`));
    await settle();
    expect(h.save.mock.calls.some(([, input]) => input.value === TOKEN)).toBe(true);
    expect(
      h.log.info.mock.calls.some(
        ([fields, message]) =>
          message === 'claude oauth token captured from stdout' &&
          fields.providerId === PROVIDER &&
          fields.tokenLen === TOKEN.length,
      ),
    ).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  it('does not log device codes embedded in authorization URLs', async () => {
    providerName = 'grok';
    await start();
    stream.emit('data', Buffer.from(`https://accounts.x.ai/oauth2/device?user_code=${CODE}\n\n`));
    assertNoCredentialText(CODE);
  });

  it('does not log antigravity authorization URL parameters', async () => {
    providerName = 'antigravity';
    await start();
    stream.emit('data', Buffer.from(`https://accounts.google.com/o/oauth2/auth?code=${CODE}\n\n`));
    assertNoCredentialText(CODE);
  });

  it('does not log unparsed antigravity OAuth output', async () => {
    providerName = 'antigravity';
    await start();
    stream.emit('data', Buffer.from(`oauth2 code=${CODE}\n`));
    assertNoCredentialText(CODE);
  });

  it('does not log the rejected code echoed by the CLI', async () => {
    await start();
    stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
    paste();
    stream.emit('data', Buffer.from(`invalid token: ${CODE}\n`));
    assertNoCredentialText(CODE);
  });

  it('does not log or return partial credentials on capture timeout', async () => {
    await start();
    stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
    paste();
    stream.emit('data', Buffer.from(TOKEN.slice(0, 45)));
    await vi.advanceTimersByTimeAsync(60_000);
    assertNoCredentialText(TOKEN, CODE);
    const sent = JSON.stringify(ws.send.mock.calls);
    expect(sent.includes(TOKEN.slice(0, 20))).toBe(false);
  });

  it('does not log credentials supplied in the upgrade query', async () => {
    await start(`?code=${CODE}`);
    assertNoCredentialText(CODE);
  });

  it('does not log credential text carried by a stream error', async () => {
    await start();
    stream.emit('error', new Error(`synthetic transport failure: ${CODE}`));
    await settle();
    assertNoCredentialText(CODE);
  });

  it.each([true, false])('fix6 logs query-free upgrade paths (valid id: %s)', async (valid) => {
    const id = valid ? PROVIDER : 'malformed-provider';
    await start(`?code=${CODE}`, valid, id);
    const path = `/cli-login-banner/${id}`;
    expect(h.log.info.mock.calls.some(([fields]) => fields?.path === path)).toBe(true);
    if (!valid) expect(h.log.warn.mock.calls.some(([fields]) => fields?.path === path)).toBe(true);
    assertNoCredentialText(CODE);
  });

  it.each(['queue', 'stream', 'probe'])(
    'fix2 preserves the infrastructure %s error response',
    async (source) => {
      const message = 'Synthetic infrastructure failure';
      if (source === 'queue') h.queueError = new Error(message);
      if (source === 'probe') {
        providerName = 'grok';
        h.probeError = new Error(message);
      }
      await start('', source !== 'queue');
      if (source === 'stream') stream.emit('error', new Error(message));
      if (source === 'probe') {
        stream.emit('data', Buffer.from('https://accounts.x.ai/oauth2/device\n\nSigned in\n'));
      }
      await settle();
      expect(
        ws.send.mock.calls.some(([raw]) => {
          const frame = JSON.parse(raw);
          return frame.type === 'error' && frame.message === message;
        }),
      ).toBe(true);
    },
  );

  it('fix1 logs only the error class and nested code for a failed credential write', async () => {
    class DrizzleQueryError extends Error {}
    const cause = Object.assign(new Error(`synthetic driver params: ${TOKEN}`), { code: '23505' });
    h.save.mockRejectedValueOnce(
      new DrizzleQueryError(`synthetic query params: ${TOKEN}`, { cause }),
    );
    await start();
    stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
    paste();
    stream.emit('data', Buffer.from(TOKEN));
    await settle();
    assertNoCredentialText(TOKEN, CODE);
    expect(
      h.log.error.mock.calls.some(
        ([fields]) => fields?.error?.name === 'DrizzleQueryError' && fields.error.code === '23505',
      ),
    ).toBe(true);
    expect(JSON.stringify(ws.send.mock.calls).includes(TOKEN)).toBe(false);
  });

  it('does not log or return credential text carried by a save error', async () => {
    h.save.mockRejectedValueOnce(new Error(`synthetic save failure: ${TOKEN}`));
    await start();
    stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
    paste();
    stream.emit('data', Buffer.from(TOKEN));
    await settle();
    expect(h.log.error).toHaveBeenCalled();
    assertNoCredentialText(TOKEN, CODE);
    expect(JSON.stringify(ws.send.mock.calls).includes(TOKEN)).toBe(false);
  });
});
