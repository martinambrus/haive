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
  probe: vi.fn(),
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
      if (name !== 'cli-login-create') h.probe();
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
