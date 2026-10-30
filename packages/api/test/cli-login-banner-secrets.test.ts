import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { Duplex } from 'node:stream';
import type Docker from 'dockerode';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  ws: undefined as unknown,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  save: vi.fn(),
  attach: vi.fn(),
  start: vi.fn(),
  remove: vi.fn(),
  probe: vi.fn(),
  exec: vi.fn(),
  queueError: undefined as Error | undefined,
  createError: undefined as string | undefined,
  probeError: undefined as Error | string | undefined,
  // While set, a post-login probe job stays pending until it resolves.
  probeGate: undefined as Promise<void> | undefined,
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
vi.mock('../src/routes/terminal.js', () => ({ attachContainerStream: h.attach }));
vi.mock('../src/routes/docker-exec.js', () => ({ execInContainer: h.exec }));
vi.mock('../src/queues.js', () => ({
  getCliExecQueueEvents: () => ({}),
  getUsagePollQueue: () => ({ add: async () => ({}) }),
  getCliExecQueue: () => ({
    add: async (name: string) => {
      if (h.queueError) throw h.queueError;
      let delivered = false;
      if (name !== 'cli-login-create') h.probe();
      return {
        getState: async () => (delivered ? 'unknown' : 'active'),
        waitUntilFinished: async () => {
          // Completed jobs are removed and cannot supply a second container result.
          if (delivered) throw new Error('job removed');
          delivered = true;
          if (name !== 'cli-login-create' && h.probeGate) await h.probeGate;
          if (name !== 'cli-login-create' && h.probeError) throw h.probeError;
          return name === 'cli-login-create'
            ? h.createError
              ? { ok: false, error: h.createError }
              : { ok: true, containerRowId: 'row', dockerContainerId: 'container' }
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
  h.attach.mockReset();
  h.start.mockReset().mockResolvedValue(undefined);
  h.remove.mockReset().mockResolvedValue(undefined);
  h.exec.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  h.queueError = undefined;
  h.createError = undefined;
  h.probeError = undefined;
  h.probeGate = undefined;
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
  h.attach.mockResolvedValue(stream);
});
afterEach(async () => {
  ws.close();
  await settle();
  vi.useRealTimers();
});

async function start(query = '', attached = true, providerId = PROVIDER) {
  const server = new EventEmitter();
  const docker = {
    getContainer: () => ({ start: h.start, remove: h.remove, resize: async () => {} }),
  } as unknown as Docker;
  installCliLoginBannerWebSocket(server as Server, { docker });
  // The shared upgrade guard listens on the socket and the session registry tracks req.socket.
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
  });
  server.emit(
    'upgrade',
    {
      url: `/cli-login-banner/${providerId}${query}`,
      headers: { cookie: `${ACCESS_COOKIE}=synthetic-session` },
      socket,
    },
    socket,
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

describe('Claude OAuth token capture controls', () => {
  const token = (length: number) =>
    'sk-ant-oat01-' + 'Az9_xQ7-vR2'.repeat(Math.ceil(length / 10)).slice(0, length);

  async function ready() {
    await start();
    stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
    paste();
  }

  const crWrapCases = [
    ['CR', '\r'],
    ['CR LF', '\r\n'],
    ['CR CR LF', '\r\r\n'],
    ['LF', '\n'],
  ] as const;
  const wrapSplits = crWrapCases.flatMap(([label, wrap]) =>
    [90, 100].flatMap((bodyBeforeWrap) => {
      const wrapStart = 'sk-ant-oat01-'.length + bodyBeforeWrap;
      const splits = [
        ...Array.from({ length: wrap.length + 3 }, (_, i) => ({
          label: `split ${i - 1}`,
          offsets: [wrapStart + i - 1],
        })),
        {
          label: 'separate every wrap byte',
          offsets: Array.from({ length: wrap.length + 1 }, (_, i) => wrapStart + i),
        },
        { label: 'whole stream', offsets: [] },
      ];
      return splits.flatMap((split) =>
        ['data', 'end'].map((completion) => ({
          label: `${label}, ${bodyBeforeWrap} body chars, ${split.label}, ${completion}`,
          wrap,
          bodyBeforeWrap,
          offsets: split.offsets,
          completion,
        })),
      );
    }),
  );

  it.each(wrapSplits)(
    'fix-round3 CR boundary captures exactly once: $label',
    async ({ wrap, bodyBeforeWrap, offsets, completion }) => {
      const expected = token(bodyBeforeWrap + 5);
      const wrapStart = 'sk-ant-oat01-'.length + bodyBeforeWrap;
      const output =
        expected.slice(0, wrapStart) +
        wrap +
        expected.slice(wrapStart) +
        (completion === 'data' ? '\n\n' : '');
      await ready();
      let previous = 0;
      for (const offset of offsets) {
        stream.emit('data', Buffer.from(output.slice(previous, offset)));
        await settle();
        // Incomplete wraps must not save a plausible prefix or start its probe.
        expect(h.save.mock.calls.length === 0 && h.probe.mock.calls.length === 0).toBe(true);
        previous = offset;
      }
      stream.emit('data', Buffer.from(output.slice(previous)));
      await settle();
      if (completion === 'end') {
        expect(h.save.mock.calls.length === 0 && h.probe.mock.calls.length === 0).toBe(true);
      } else {
        expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected).toBe(
          true,
        );
        expect(h.probe.mock.calls.length === 1).toBe(true);
      }
      stream.emit('end');
      stream.emit('end');
      await settle();
      expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected).toBe(
        true,
      );
      expect(h.probe.mock.calls.length === 1).toBe(true);
      for (const type of ['auth-success', 'saved']) {
        expect(
          ws.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === type).length === 1,
        ).toBe(true);
      }
      assertNoCredentialText(expected, CODE);
    },
  );

  it.each(['\r', '\r\r', '\r\r\r'])(
    'fix-round3 CR boundary leaves a trailing %j pending until actual end',
    async (ending) => {
      await ready();
      for (const chunk of [TOKEN, ...ending]) {
        stream.emit('data', Buffer.from(chunk));
        await settle();
        expect(h.save.mock.calls.length === 0 && h.probe.mock.calls.length === 0).toBe(true);
      }
      stream.emit('end');
      stream.emit('end');
      await settle();
      expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(
        true,
      );
      expect(h.probe.mock.calls.length === 1).toBe(true);
      assertNoCredentialText(TOKEN, CODE);
    },
  );

  it.each([
    ['wide terminal', 95, 103],
    ['three token lines', 160, 80],
  ] as const)(
    'fix-round2 geometry refuses an ambiguous final fragment with %s',
    async (_label, length, width) => {
      const expected = token(length);
      const lines = Array.from({ length: Math.ceil(expected.length / width) }, (_, i) =>
        expected.slice(i * width, (i + 1) * width),
      );
      await ready();
      stream.emit('data', Buffer.from(`${lines.join('\n')} (valid for 1 year)\n`));
      stream.emit('end');
      await settle();
      expect(h.save.mock.calls.length === 0).toBe(true);
      assertNoCredentialText(expected, CODE);
    },
  );

  it.each(['Store this token securely', 'Done.'])(
    'fix-round2 geometry saves the exact wrapped token before %s',
    async (prose) => {
      await ready();
      stream.emit('data', Buffer.from(`${TOKEN.slice(0, 80)}\n${TOKEN.slice(80)}\n${prose}\n`));
      await settle();
      expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(
        true,
      );
      assertNoCredentialText(TOKEN, CODE);
    },
  );

  it('fix-round2 geometry refuses prose immediately after a one-line token', async () => {
    await ready();
    stream.emit('data', Buffer.from(`${TOKEN}\nStore this token\n`));
    stream.emit('end');
    await settle();
    expect(h.save.mock.calls.length === 0).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  it.each([
    ['short previous line', 95, true],
    ['full previous line', 147, false],
  ] as const)(
    'fix-round2 geometry ignores trailing padding on a %s',
    async (_label, length, saves) => {
      const expected = token(length);
      const first = expected.slice(0, 80).padEnd(84, ' ');
      const previous = expected.slice(80).padEnd(80, ' ');
      await ready();
      stream.emit('data', Buffer.from(`${first}\n${previous}\nDone.\n`));
      stream.emit('end');
      await settle();
      expect(
        saves
          ? h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected
          : h.save.mock.calls.length === 0,
      ).toBe(true);
      assertNoCredentialText(expected, CODE);
    },
  );

  it('fix-round2 geometry counts text before the prefix in the first line width', async () => {
    const expected = token(137);
    const before = 'Token: ';
    await ready();
    stream.emit(
      'data',
      Buffer.from(`${before}${expected.slice(0, 73)}\n${expected.slice(73)}\nDone.\n`),
    );
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected).toBe(
      true,
    );
    assertNoCredentialText(expected, CODE);
  });

  it('fix-round2 geometry counts leading blanks in the previous line width', async () => {
    await ready();
    stream.emit(
      'data',
      Buffer.from(`${TOKEN.slice(0, 80)}\n${' '.repeat(52)}${TOKEN.slice(80)}\nDone.\n`),
    );
    stream.emit('end');
    await settle();
    expect(h.save.mock.calls.length === 0).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  it.each([
    ['trailing blanks', ' \t\r\n'],
    ['cursor forward', '\x1b[2C\r\n'],
    ['CR CR LF', '\r\r\n'],
    ['LF CR', '\n\r'],
  ])('fix-round1 D2 captures an 80-column wrap with %s', async (_label, wrap) => {
    await ready();
    stream.emit('data', Buffer.from(`${TOKEN.slice(0, 80)}${wrap}${TOKEN.slice(80)}\n\n`));
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  it('fix-round1 D2 captures exactly or refuses a final fragment followed by prose', async () => {
    await ready();
    stream.emit(
      'data',
      Buffer.from(`${TOKEN.slice(0, 80)}\n${TOKEN.slice(80)} (valid for 1 year)\n`),
    );
    await settle();
    expect(h.save.mock.calls.every(([, input]) => input.value === TOKEN)).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  it('fix-round1 D2 captures exactly or refuses an escape split at the wrap', async () => {
    await ready();
    stream.emit('data', Buffer.from(`${TOKEN.slice(0, 80)}\x1b[`));
    stream.emit('data', Buffer.from(`32m\n${TOKEN.slice(80)}\x1b[0m\n\n`));
    await settle();
    expect(h.save.mock.calls.every(([, input]) => input.value === TOKEN)).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  const styled =
    `\x1b]0;synthetic\x1b\\\x1b[?25l\x1b7\x1b[32m${TOKEN.slice(0, 80)}\x1b[0m\r\n` +
    `\x1b[2C\x1b[1m${TOKEN.slice(80)}\x1b[0m\n\n`;
  it.each(Array.from({ length: styled.length - 1 }, (_, i) => i + 1))(
    'fix-round1 F1 captures a styled wrapped token split at offset %i',
    async (offset) => {
      await ready();
      stream.emit('data', Buffer.from(styled.slice(0, offset)));
      stream.emit('data', Buffer.from(styled.slice(offset)));
      await settle();
      expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(
        true,
      );
      assertNoCredentialText(TOKEN, CODE);
    },
  );

  it('fix-round1 F1 clears an incomplete escape when the user pastes again', async () => {
    await ready();
    stream.emit('data', Buffer.from('\x1b]unfinished'));
    paste();
    stream.emit('data', Buffer.from(`${TOKEN}\n\n`));
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  it.each([
    ['two-byte', 'é', 1],
    ['four-byte', '🧪', 1],
    ['four-byte', '🧪', 2],
    ['four-byte', '🧪', 3],
  ] as const)(
    'fix-round1 F4 preserves %s UTF-8 (%s) split at byte %i',
    async (_label, char, split) => {
      providerName = 'antigravity';
      await start();
      const bytes = Buffer.from(char);
      stream.emit('data', bytes.subarray(0, split));
      stream.emit('data', bytes.subarray(split));
      const output = ws.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter((frame) => frame.type === 'output')
        .map((frame) => frame.data)
        .join('');
      expect(output === char).toBe(true);
    },
  );

  it.each(['', '\n', '\r\n', '\n '])(
    'fix-round1 D1 captures exactly once at stream end after %j',
    async (ending) => {
      await ready();
      stream.emit('data', Buffer.from(`${TOKEN}${ending}`));
      expect(h.save.mock.calls.length === 0).toBe(true);
      stream.emit('end');
      // The save/probe is still awaiting its first promise: end must defer cleanup.
      expect(
        ws.readyState === 1 && !ws.send.mock.calls.some(([raw]) => JSON.parse(raw).type === 'exit'),
      ).toBe(true);
      stream.emit('end');
      await settle();
      expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(
        true,
      );
      expect(
        ws.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'auth-success').length === 1,
      ).toBe(true);
      expect(
        ws.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'saved').length === 1,
      ).toBe(true);
      assertNoCredentialText(TOKEN, CODE);
    },
  );

  it.each(['prefix', 'authorization URL', 'pasted code'])(
    'fix-round1 D1 keeps the %s gate at stream end',
    async (missing) => {
      await start();
      if (missing !== 'authorization URL') {
        stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
      }
      if (missing !== 'pasted code') paste();
      const output = missing === 'prefix' ? TOKEN.slice('sk-ant-oat01-'.length) : TOKEN;
      stream.emit('data', Buffer.from(output));
      stream.emit('end');
      await settle();
      expect(h.save.mock.calls.length === 0).toBe(true);
    },
  );

  it('fix-round1 D1 does not save again at end after a data capture', async () => {
    await ready();
    stream.emit('data', Buffer.from(`${TOKEN}\n\n`));
    stream.emit('end');
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(true);
  });

  it.each([513, 30000])('fix-round1 D4 refuses an oversized %i-character body', async (length) => {
    await ready();
    stream.emit('data', Buffer.from(`${token(length)}\n\n`));
    await settle();
    expect(h.save.mock.calls.length === 0).toBe(true);
  });

  it('fix-round1 D4 accepts the 512-character ceiling exactly', async () => {
    const expected = token(512);
    await ready();
    stream.emit('data', Buffer.from(`${expected}\n\n`));
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected).toBe(
      true,
    );
    assertNoCredentialText(expected, CODE);
  });

  it('fix-round1 D5 scans 30000 trailing blanks in under 50 ms', async () => {
    vi.useRealTimers();
    await ready();
    const bytes = Buffer.from(`${TOKEN.slice(0, 80)}\n${TOKEN.slice(80)}${' '.repeat(30000)}\n\n`);
    const began = performance.now();
    stream.emit('data', bytes);
    const elapsed = performance.now() - began;
    await settle();
    expect(elapsed < 50).toBe(true);
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  it('fix-round1 D3 refuses an ambiguous punctuated word after a one-line token', async () => {
    await ready();
    stream.emit('data', Buffer.from(`${TOKEN}\nDone.\n`));
    await settle();
    expect(h.save.mock.calls.length === 0).toBe(true);
    assertNoCredentialText(TOKEN, CODE);
  });

  it.each([95, 100, 90])('saves the complete %i-character body', async (length) => {
    const expected = token(length);
    await ready();
    stream.emit('data', Buffer.from(`${expected}\n\nStore this token securely\n`));
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected).toBe(
      true,
    );
    assertNoCredentialText(expected, CODE);
  });

  it.each([' ', '\n', '\n\n'])(
    'captures exactly or refuses a shorter token before prose separated by %j',
    async (separator) => {
      const expected = token(90);
      await ready();
      stream.emit('data', Buffer.from(`${expected}${separator}Store this token securely\n`));
      await settle();
      expect(
        separator === '\n'
          ? h.save.mock.calls.length === 0
          : h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected,
      ).toBe(true);
      assertNoCredentialText(expected, CODE);
    },
  );

  it.each(['.', '/', '=', ':'])(
    'ends a token at the non-alphabet delimiter %s',
    async (delimiter) => {
      const expected = token(100);
      await ready();
      stream.emit('data', Buffer.from(`${expected}${delimiter}prose\n`));
      await settle();
      expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected).toBe(
        true,
      );
    },
  );

  it('captures line wraps and ANSI styling without joining the following paragraph', async () => {
    const expected = token(100);
    await ready();
    stream.emit(
      'data',
      Buffer.from(
        `\x1b[32m${expected.slice(0, 47)}\x1b[0m\r\n  ` +
          `\x1b[1m${expected.slice(47, 80)}\x1b[0m\n\t${expected.slice(80)}\n\nKeep it safe\n`,
      ),
    );
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected).toBe(
      true,
    );
    assertNoCredentialText(expected, CODE);
  });

  it('keeps the first token when two tokens appear in one output', async () => {
    await ready();
    stream.emit('data', Buffer.from(`${TOKEN}\n\n${token(100)}\n\n`));
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === TOKEN).toBe(true);
  });

  it.each([20, 63, 64, 89])(
    'rejects a %i-character token body below the minimum',
    async (length) => {
      await ready();
      stream.emit('data', Buffer.from(`${token(length)}\n\nStore this token securely\n`));
      await settle();
      expect(h.save.mock.calls.length === 0).toBe(true);
    },
  );

  it.each(['', '\r\n  '])('waits for a boundary across a chunk ending in %j', async (wrap) => {
    const expected = token(100);
    await ready();
    stream.emit('data', Buffer.from(expected.slice(0, 108) + wrap));
    await settle();
    expect(h.save.mock.calls.length === 0).toBe(true);
    stream.emit('data', Buffer.from(`${expected.slice(108)}\n\n`));
    await settle();
    expect(h.save.mock.calls.length === 1 && h.save.mock.calls[0]?.[1].value === expected).toBe(
      true,
    );
  });

  it.each(['prefix', 'authorization URL', 'pasted code'])(
    'requires the existing %s signal',
    async (missing) => {
      await start();
      if (missing !== 'authorization URL') {
        stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
      }
      if (missing !== 'pasted code') paste();
      const output = missing === 'prefix' ? TOKEN.slice('sk-ant-oat01-'.length) : TOKEN;
      stream.emit('data', Buffer.from(`${output}\n\n`));
      await settle();
      expect(h.save.mock.calls.length === 0).toBe(true);
    },
  );
});

describe('CLI login banner credential logging', () => {
  it.each(['queue', 'probe', 'stream'] as const)(
    'sanitizes a structured DB failure from %s',
    async (source) => {
      const err = new DrizzleQueryError(
        'insert into secrets (value) values ($1)',
        [TOKEN],
        new Error(TOKEN),
      );
      if (source === 'queue') h.queueError = err;
      if (source === 'probe') {
        providerName = 'grok';
        h.probeError = err;
      }
      await start('', source !== 'queue');
      if (source === 'stream') stream.emit('error', err);
      if (source === 'probe')
        stream.emit('data', Buffer.from('https://accounts.x.ai/oauth2/device\n\nSigned in\n'));
      await settle();
      const sent = JSON.stringify(ws.send.mock.calls);
      expect(ws.send.mock.calls.some(([raw]) => JSON.parse(raw).type === 'error')).toBe(true);
      expect(
        Array.from({ length: TOKEN.length - 5 }, (_, i) => TOKEN.slice(i, i + 6)).some((part) =>
          sent.includes(part),
        ),
      ).toBe(false);
    },
  );

  it.each([
    'provider not found',
    'no adapter registered for synthetic',
    'Database operation failed (23505)',
  ])('fix7 forwards the worker reason: %s', async (message) => {
    h.createError = message;
    await start('', false);
    expect(
      ws.send.mock.calls.some(([raw]) => {
        const frame = JSON.parse(raw);
        return frame.type === 'error' && frame.message === message;
      }),
    ).toBe(true);
  });

  it('fix7 preserves the non-Error post-login fallback', async () => {
    providerName = 'grok';
    h.probeError = 'synthetic non-Error rejection';
    await start();
    stream.emit('data', Buffer.from('https://accounts.x.ai/oauth2/device\n\nSigned in\n'));
    await settle();
    expect(
      ws.send.mock.calls.some(([raw]) => {
        const frame = JSON.parse(raw);
        return frame.type === 'error' && frame.message === 'post-login probe failed';
      }),
    ).toBe(true);
  });

  it('captures a wrapped Claude token without logging any six-character substring', async () => {
    await start();
    stream.emit('data', Buffer.from('https://claude.ai/oauth/authorize\n\n'));
    paste();
    stream.emit('data', Buffer.from(`${TOKEN.slice(0, 47)}\n${TOKEN.slice(47)}\n\n`));
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
    stream.emit('data', Buffer.from(`${TOKEN}\n\n`));
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
    stream.emit('data', Buffer.from(`${TOKEN}\n\n`));
    await settle();
    expect(h.log.error).toHaveBeenCalled();
    assertNoCredentialText(TOKEN, CODE);
    expect(JSON.stringify(ws.send.mock.calls).includes(TOKEN)).toBe(false);
  });
});

describe('CLI login banner startup cleanup', () => {
  it.each([false, true])(
    'ends the stream when start fails (remove fails: %s)',
    async (removeFails) => {
      h.start.mockRejectedValueOnce(new Error('start unavailable'));
      h.remove.mockImplementationOnce(async () => {
        expect(stream.writableEnded).toBe(true);
        if (removeFails) throw new Error('remove unavailable');
      });
      await start('', false);
      expect(stream.writableEnded).toBe(true);
      expect(h.remove).toHaveBeenCalledWith({ force: true });
      expect(ws.readyState).toBe(3);
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'error', message: 'Failed to start login container' }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    'handles a stream error while container start is still pending (bound: %s)',
    async (bound) => {
      let finish!: () => void;
      h.start.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      await start('', false);
      expect(h.start).toHaveBeenCalledOnce();
      const failure = bound
        ? new DrizzleQueryError('select $1', [TOKEN], new Error(TOKEN))
        : new Error('attach socket failed');
      // EventEmitter throws here on the old code: no error listener exists yet.
      try {
        expect(() => stream.emit('error', failure)).not.toThrow();
        await settle();
        expect(stream.writableEnded).toBe(true);
        expect(h.remove).toHaveBeenCalledOnce();
        expect(ws.readyState).toBe(3);
        const errorFrame = {
          type: 'error',
          message: bound ? 'Database operation failed' : failure.message,
        };
        expect(ws.send.mock.calls.some(([raw]) => raw === JSON.stringify(errorFrame))).toBe(true);
      } finally {
        finish();
        await settle();
      }
      expect(stream.listenerCount('data')).toBe(0);
      expect(h.remove).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      if (bound) {
        assertNoCredentialText(TOKEN);
        expect(JSON.stringify(ws.send.mock.calls).includes(TOKEN)).toBe(false);
      }
    },
  );

  it.each(['attach', 'start'])('ends the stream when cancelled during %s', async (stage) => {
    if (stage === 'attach')
      h.attach.mockImplementationOnce(async () => {
        ws.close();
        return stream;
      });
    else
      h.start.mockImplementationOnce(async () => {
        ws.close();
      });
    await start('', false);
    expect(stream.writableEnded).toBe(true);
    expect(h.remove).toHaveBeenCalledOnce();
    expect(stream.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the stream and heartbeat if session timer setup fails', async () => {
    const timeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      if (args[1] === 10 * 60 * 1000) throw new Error('timer unavailable');
      return timeout(...args);
    }) as typeof setTimeout);
    try {
      await start('', false);
      expect(stream.writableEnded).toBe(true);
      expect(h.remove).toHaveBeenCalledOnce();
      expect(ws.readyState).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.mocked(globalThis.setTimeout).mockRestore();
    }
  });
});

describe('CLI login banner auth URL chunking', () => {
  // Synthetic, ~200 characters, hard-wrapped at 80 columns the way the CLI's PTY prints it.
  const CLAUDE_URL =
    'https://claude.ai/oauth/authorize?code=true&client_id=synthetic-client-id' +
    '&response_type=code&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcb' +
    '&code_challenge=SyntheticChallenge0123456789&state=SyntheticState01';
  const CLAUDE_LINES = Array.from({ length: Math.ceil(CLAUDE_URL.length / 80) }, (_, i) =>
    CLAUDE_URL.slice(i * 80, (i + 1) * 80),
  );
  const AMP_CODE = 'QRST-2468';

  // `body` is the URL as printed (wraps and colour included) and `end` what has to follow it before
  // it is known to be complete, so `done` is the offset into `raw` from which it is sent.
  const banner = (spec: {
    label: string;
    provider: CliProviderName;
    url: string;
    head: string;
    body?: string;
    end: string;
    rest: string;
    tokenPaste?: boolean;
    deviceCode?: string;
  }) => {
    const body = spec.body ?? spec.url;
    const printed = spec.head + body + spec.end;
    return { ...spec, body, raw: printed + spec.rest, done: printed.length };
  };
  type Banner = ReturnType<typeof banner>;

  const CLAUDE = banner({
    label: 'claude-code, URL wrapped over three lines',
    provider: 'claude-code',
    url: CLAUDE_URL,
    head: "\x1b]0;Claude Code\x07Browser didn't open? Use the url below to sign in\r\n\r\n",
    body: CLAUDE_LINES.map((line) => `\x1b[34m${line}\x1b[39m`).join('\r\n'),
    end: '\r\n\r\n',
    rest: 'Paste code here if prompted > ',
    tokenPaste: true,
  });
  const CODEX = banner({
    label: 'codex device login',
    provider: 'codex',
    url: 'https://auth.openai.com/codex/device',
    head: '1. Open this link in your browser and sign in to your account\r\n   \x1b[94m',
    end: '\x1b[0m\r\n\r\n',
    rest: '2. Enter this one-time code (expires in 15 minutes)\r\n   \x1b[94mABCD-12345\x1b[0m\r\n',
    tokenPaste: false,
  });
  const GROK = banner({
    label: 'grok device login',
    provider: 'grok',
    url: `https://accounts.x.ai/oauth2/device?user_code=${CODE}`,
    head: '\nTo sign in, open this URL in your browser:\n\n  ',
    end: '\n\n',
    rest: `Confirm this code in your browser:\n\n  ${CODE}\n\nWaiting for authorization...\n`,
    tokenPaste: false,
    deviceCode: CODE,
  });
  const AMP_DEVICE = banner({
    label: 'amp device login',
    provider: 'amp',
    url: `https://auth.ampcode.com/device?user_code=${AMP_CODE}`,
    head: 'To log in, visit:\r\n\r\n\x1b[34m\x1b[1m',
    end: '\x1b[22m\x1b[39m\r\n\r\n',
    rest: `and confirm that the code shown matches: \x1b[1m${AMP_CODE}\x1b[22m\r\n\r\nWaiting for confirmation in the browser...\r\n`,
    tokenPaste: false,
    deviceCode: AMP_CODE,
  });
  const AMP_PASTE = banner({
    label: 'amp paste-back login',
    provider: 'amp',
    url: `https://ampcode.com/auth/cli-login?authToken=${'a'.repeat(64)}`,
    head: 'If your browser does not open automatically, visit:\r\n\r\n\x1b[34m\x1b[1m',
    end: '\x1b[22m\x1b[39m\r\n\r\n',
    rest: '',
    tokenPaste: true,
  });
  const ANTIGRAVITY = banner({
    label: 'antigravity terminal login',
    provider: 'antigravity',
    url:
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-client.example.invalid' +
      '&response_type=code&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob' +
      '&scope=openid%20email&state=SyntheticState01',
    head: 'Sign in with Google\r\n\r\nOpen this URL in your browser:\r\n\r\n',
    end: '\r\n\r\n',
    rest: 'Enter the authorization code: ',
  });
  const banners = [CLAUDE, CODEX, GROK, AMP_DEVICE, AMP_PASTE, ANTIGRAVITY];

  const frames = () => ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
  const authUrlFrames = () => frames().filter((frame) => frame.type === 'auth-url');
  function expectOneAuthUrl(b: Banner) {
    const sent = authUrlFrames();
    expect(sent.length).toBe(1);
    expect(sent[0]?.url?.length).toBe(b.url.length);
    expect(sent[0]?.url === b.url).toBe(true);
    expect(sent[0]?.tokenPaste).toBe(b.tokenPaste);
    if (b.deviceCode) expect(sent[0]?.deviceCode === b.deviceCode).toBe(true);
    if (b.provider === 'grok') assertNoCredentialText(CODE);
  }

  const splits = banners.flatMap((b) =>
    Array.from({ length: b.raw.length - 1 }, (_, i) => ({ ...b, k: i + 1 })),
  );
  it.each(splits)('$label: two chunks split at offset $k', async (c) => {
    providerName = c.provider;
    await start();
    stream.emit('data', Buffer.from(c.raw.slice(0, c.k)));
    expect(authUrlFrames().length).toBe(c.k >= c.done ? 1 : 0);
    stream.emit('data', Buffer.from(c.raw.slice(c.k)));
    expectOneAuthUrl(c);
  });

  it.each(banners)('$label: one byte per chunk sends once, at the terminator', async (b) => {
    providerName = b.provider;
    await start();
    const wrong: number[] = [];
    for (let i = 0; i < b.raw.length; i++) {
      stream.emit('data', Buffer.from(b.raw.charAt(i)));
      if (authUrlFrames().length !== (i + 1 >= b.done ? 1 : 0)) wrong.push(i + 1);
    }
    expect(wrong).toEqual([]);
    expectOneAuthUrl(b);
  });

  const sameChunkEnds = [
    ['a blank line', '\n\n'],
    ['CRLF CRLF', '\r\n\r\n'],
    ['a closing colour then CRLF CRLF', '\x1b[39m\r\n\r\n'],
    ['a prose line right after', '\nprose here\n'],
    ['prose on the same line', ' trailing prose'],
  ] as const;
  it.each(banners.flatMap((b) => sameChunkEnds.map(([after, tail]) => ({ ...b, after, tail }))))(
    '$label: $after in the same chunk sends at once',
    async (c) => {
      providerName = c.provider;
      await start();
      stream.emit('data', Buffer.from(c.head + c.url + c.tail));
      expectOneAuthUrl(c);
    },
  );

  const streamEnds = [
    ['nothing', ''],
    ['a closing colour', '\x1b[39m'],
    ['a cut escape', '\x1b[3'],
  ] as const;
  it.each(banners.flatMap((b) => streamEnds.map(([after, tail]) => ({ ...b, after, tail }))))(
    '$label: the stream ending after the URL and $after sends it, then exit',
    async (c) => {
      providerName = c.provider;
      await start();
      stream.emit('data', Buffer.from(c.head + c.body + c.tail));
      await settle();
      expect(authUrlFrames().length).toBe(0);
      stream.emit('end');
      await settle();
      expectOneAuthUrl(c);
      const types = frames().map((frame) => frame.type);
      expect(types.indexOf('exit')).toBeGreaterThan(types.indexOf('auth-url'));
    },
  );

  const firstLineEnd = CLAUDE.body.indexOf('\r\n') + 2;
  const firstChunk = CLAUDE.head + CLAUDE.body.slice(0, firstLineEnd);
  const laterLines = CLAUDE.body.slice(firstLineEnd);

  it('sends a URL that has not visibly ended one second after it first appeared', async () => {
    providerName = 'grok';
    await start();
    stream.emit('data', Buffer.from(`${GROK.head}${GROK.url}\r\n`));
    await vi.advanceTimersByTimeAsync(999);
    expect(authUrlFrames().length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expectOneAuthUrl(GROK);
  });

  it('counts the second from when the URL first appeared, not from the last chunk', async () => {
    providerName = 'claude-code';
    await start();
    const idle = vi.getTimerCount();
    stream.emit('data', Buffer.from(firstChunk));
    await vi.advanceTimersByTimeAsync(600);
    stream.emit('data', Buffer.from(laterLines));
    expect(vi.getTimerCount()).toBe(idle + 1);
    await vi.advanceTimersByTimeAsync(399);
    expect(authUrlFrames().length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expectOneAuthUrl(CLAUDE);
  });

  it('is not held back by whitespace-free output that keeps arriving under the URL', async () => {
    providerName = 'grok';
    await start();
    stream.emit('data', Buffer.from(`${GROK.head}${GROK.url}\r\n`));
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(100);
      stream.emit('data', Buffer.from('⠋\r\n'));
    }
    const sent = authUrlFrames();
    expect(sent.length).toBe(1);
    expect(sent[0]?.url?.startsWith(GROK.url)).toBe(true);
  });

  it('cancels the wait when the URL ends in time', async () => {
    providerName = 'claude-code';
    await start();
    const idle = vi.getTimerCount();
    stream.emit('data', Buffer.from(firstChunk));
    expect(vi.getTimerCount()).toBe(idle + 1);
    await vi.advanceTimersByTimeAsync(500);
    stream.emit('data', Buffer.from(laterLines + CLAUDE.end));
    expectOneAuthUrl(CLAUDE);
    expect(vi.getTimerCount()).toBe(idle);
    await vi.advanceTimersByTimeAsync(5000);
    expect(authUrlFrames().length).toBe(1);
  });

  it.each([CLAUDE, CODEX, GROK])(
    '$label: closing the dialog inside the URL leaves no timer behind',
    async (b) => {
      providerName = b.provider;
      await start();
      const idle = vi.getTimerCount();
      stream.emit('data', Buffer.from(b.head + b.body));
      expect(vi.getTimerCount()).toBe(idle + 1);
      ws.close();
      await settle();
      expect(vi.getTimerCount()).toBe(0);
      stream.emit('data', Buffer.from('abc'));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([AMP_DEVICE, AMP_PASTE])(
    '$label: sending the URL starts the credentials poller',
    async (b) => {
      providerName = b.provider;
      await start();
      const idle = vi.getTimerCount();
      stream.emit('data', Buffer.from(b.raw));
      expectOneAuthUrl(b);
      expect(vi.getTimerCount()).toBe(idle + 1);
      ws.close();
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [8, 0],
    [9, 1],
  ])('antigravity: a URL %i characters past its prefix sends %i frames', async (extra, count) => {
    providerName = 'antigravity';
    await start();
    stream.emit(
      'data',
      Buffer.from(`https://accounts.google.com/o/oauth2/${'a'.repeat(extra)}\n\n`),
    );
    expect(authUrlFrames().length).toBe(count);
  });

  // agy's creds poller reads its token file every second: the first read is the baseline, a later
  // one that differs is a sign-in. Here the URL shows after the baseline read, the sign-in lands 500
  // ms into the second the open URL is held, and the probe it starts stays pending past that second.
  async function signInWhileUrlHeld() {
    providerName = 'antigravity';
    const signature = (letter: string) => ({
      exitCode: 0,
      stdout: `${letter.repeat(32)}\n`,
      stderr: '',
    });
    h.exec.mockResolvedValueOnce(signature('a')).mockResolvedValue(signature('b'));
    let release!: () => void;
    h.probeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start();
    await vi.advanceTimersByTimeAsync(1500);
    stream.emit('data', Buffer.from(ANTIGRAVITY.head + ANTIGRAVITY.body));
    await vi.advanceTimersByTimeAsync(500);
    expect(frames().some((frame) => frame.type === 'auth-success')).toBe(true);
    expect(authUrlFrames().length).toBe(0);
    return release;
  }

  it.each(['the second passes', 'the stream ends'])(
    'antigravity: no auth-url follows auth-success when %s',
    async (when) => {
      const release = await signInWhileUrlHeld();
      if (when === 'the stream ends') stream.emit('end');
      else await vi.advanceTimersByTimeAsync(1000);
      await settle();
      const types = frames().map((frame) => frame.type);
      expect(types.slice(types.indexOf('auth-success') + 1)).not.toContain('auth-url');
      release();
      await settle();
    },
  );

  const notExtracted = () =>
    h.log.info.mock.calls.filter(
      ([, message]) => message === 'antigravity oauth2 present but URL not extracted',
    ).length;

  it('antigravity: a URL that has not ended yet is not logged as one that was not extracted', async () => {
    providerName = 'antigravity';
    await start();
    const cut = ANTIGRAVITY.head.length + 60;
    stream.emit('data', Buffer.from(ANTIGRAVITY.raw.slice(0, cut)));
    expect(authUrlFrames().length).toBe(0);
    expect(notExtracted()).toBe(0);
    stream.emit('data', Buffer.from(ANTIGRAVITY.raw.slice(cut)));
    expectOneAuthUrl(ANTIGRAVITY);
    expect(notExtracted()).toBe(0);
  });

  it('antigravity: oauth2 output with no URL in it is logged as not extracted, once', async () => {
    providerName = 'antigravity';
    await start();
    stream.emit('data', Buffer.from('oauth2 consent screen\n'));
    stream.emit('data', Buffer.from('oauth2 consent screen again\n'));
    expect(authUrlFrames().length).toBe(0);
    expect(notExtracted()).toBe(1);
  });

  it('antigravity: output after the sign-in does not log the unsent URL as not extracted', async () => {
    const release = await signInWhileUrlHeld();
    await vi.advanceTimersByTimeAsync(1000);
    stream.emit('data', Buffer.from('⠋'));
    expect(authUrlFrames().length).toBe(0);
    expect(notExtracted()).toBe(0);
    release();
    await settle();
  });

  it('antigravity: output after the sign-in presses no Enter, even once the URL scrolled out', async () => {
    const release = await signInWhileUrlHeld();
    await vi.advanceTimersByTimeAsync(1000);
    const write = vi.spyOn(stream, 'write');
    // More repainted TUI output than the 64 KiB raw buffer holds pushes the URL, and its 'oauth2', out.
    stream.emit('data', Buffer.from('⠋'.repeat(70 * 1024)));
    await vi.advanceTimersByTimeAsync(1500);
    expect(write).not.toHaveBeenCalledWith('\r');
    release();
    await settle();
  });
});
