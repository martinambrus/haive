import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin',
  flags: new Map<string, boolean>(),
  settings: {} as Record<string, unknown>,
  set: vi.fn(async (_key: string, _value: string) => {}),
  setSecret: vi.fn(async (_key: string, _value: string, _label: string) => {}),
  connect: vi.fn(async (_settings: unknown, _db: unknown) => ({
    pg: async () => [],
    close: async () => {},
  })),
}));

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));
vi.mock('../src/queues.js', () => ({ getGlobalKbSyncQueue: vi.fn(), getTaskQueue: vi.fn() }));
vi.mock('../src/lib/task-start.js', () => ({
  enqueueStart: vi.fn(async () => {}),
  markQueuedForStart: async () => true,
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getBoolean: async (key: string, fallback: boolean) => h.flags.get(key) ?? fallback,
    set: h.set,
  },
  secretsService: { set: h.setSecret },
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  resolveGlobalKbSettings: async () => h.settings,
  resolveGlobalKbConnection: (settings: unknown, db: unknown) => h.connect(settings, db),
}));

import { Hono } from 'hono';
import { CONFIG_KEYS, SECRET_KEYS } from '@haive/shared';
import { adminRoutes } from '../src/routes/admin.js';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const STORED_STRING = 'postgres://kb:secret@central.example:5432/kb';
const SAVED = {
  enabled: true,
  digestEnabled: true,
  mode: 'internal',
  namespace: 'default',
  connectionString: null as string | null,
  ollamaUrl: 'http://ollama:11434',
  embedModel: 'qwen3-embedding:4b',
  embeddingDimensions: 2560,
  archiveRetentionDays: 30,
};
// What the settings page sends on every save: all of it, whatever the person touched.
const PAGE = {
  enabled: true,
  digestEnabled: true,
  mode: 'internal',
  namespace: 'default',
  ollamaUrl: 'http://ollama:11434',
  embedModel: 'qwen3-embedding:4b',
  embedDimensions: 2560,
  archiveRetentionDays: 30,
  connectionString: '',
};

const app = new Hono<AppEnv>();
app.route('/global-kb', globalKbRoutes);
app.route('/admin', adminRoutes);
app.onError(errorHandler);

const send = (method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const put = (body: unknown) => send('PUT', '/global-kb/config', body);
const written = () => h.set.mock.calls.map(([key, value]) => [key, value]);

beforeEach(() => {
  h.set.mockClear();
  h.setSecret.mockClear();
  h.connect.mockClear();
  h.role = 'admin';
  h.flags = new Map();
  h.settings = { ...SAVED };
});

describe('GET /global-kb/config', () => {
  const read = async () =>
    (await (await send('GET', '/global-kb/config')).json()) as Record<string, unknown>;

  it('tells an admin they may enforce, and a regular user they may not', async () => {
    expect((await read()).canEnforce).toBe(true);

    h.role = 'user';
    expect((await read()).canEnforce).toBe(false);
  });

  it('reports whether house rules are switched on, and still never the connection string', async () => {
    h.settings = { ...SAVED, mode: 'external', connectionString: STORED_STRING };
    const on = await read();
    h.flags.set(CONFIG_KEYS.GLOBAL_KB_HOUSE_RULES_ENABLED, false);
    const off = await read();

    expect(on.houseRulesEnabled).toBe(true);
    expect(off.houseRulesEnabled).toBe(false);
    expect(on.connectionStringSet).toBe(true);
    expect(JSON.stringify([on, off])).not.toContain('secret');
  });
});

describe('PUT /global-kb/config by a regular user', () => {
  beforeEach(() => {
    h.role = 'user';
    h.settings = { ...SAVED, connectionString: STORED_STRING };
  });

  it.each([
    ['enabled', { enabled: false }],
    ['namespace', { namespace: 'elsewhere' }],
    ['mode', { mode: 'external' }],
    ['connectionString', { connectionString: 'postgres://other:pw@elsewhere:5432/kb' }],
  ])('refuses a change of %s, and writes nothing at all', async (_field, change) => {
    const res = await put({ ...PAGE, ...change });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('admin_required');
    expect(h.set).not.toHaveBeenCalled();
    expect(h.setSecret).not.toHaveBeenCalled();
  });

  it('refuses each one alone, with nothing else in the request', async () => {
    for (const change of [{ enabled: false }, { namespace: 'x' }, { mode: 'external' }]) {
      expect((await put(change)).status).toBe(403);
    }
    expect(h.set).not.toHaveBeenCalled();
  });

  it('accepts the page sending back what is already stored, and the rest of what it edits', async () => {
    const res = await put({
      ...PAGE,
      connectionString: STORED_STRING,
      archiveRetentionDays: 7,
      digestEnabled: false,
    });

    expect(res.status).toBe(200);
    expect(written()).toContainEqual([CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS, '7']);
    expect(written()).toContainEqual([CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED, 'false']);
  });

  it('writes only the open settings of a full page save, never the protected ones it re-sends', async () => {
    const res = await put({ ...PAGE, connectionString: STORED_STRING, digestEnabled: false });

    expect(res.status).toBe(200);
    expect(written().map(([key]) => key)).toEqual(
      expect.arrayContaining([
        CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED,
        CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL,
        CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL,
        CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS,
        CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS,
      ]),
    );
    expect(h.set).toHaveBeenCalledTimes(5);
    expect(h.setSecret).not.toHaveBeenCalled();
  });

  it.each([
    ['enabled', { enabled: true }],
    ['namespace', { namespace: 'default' }],
    ['mode', { mode: 'internal' }],
    ['connectionString', { connectionString: STORED_STRING }],
  ])('accepts %s re-sent as stored, and writes nothing for it', async (_field, same) => {
    expect((await put(same)).status).toBe(200);

    expect(h.set).not.toHaveBeenCalled();
    expect(h.setSecret).not.toHaveBeenCalled();
  });

  it('accepts an untouched connection string, which the page sends as blank', async () => {
    expect((await put({ ...PAGE, connectionString: '  ' })).status).toBe(200);
  });

  it.each([
    ['the title list', { digestEnabled: false }],
    ['the Ollama URL', { ollamaUrl: 'http://elsewhere:11434' }],
    ['the embed model', { embedModel: 'nomic-embed-text' }],
    ['the embed dimensions', { embedDimensions: 768 }],
    ['the archive retention', { archiveRetentionDays: 0 }],
  ])('still lets a regular user change %s alone', async (_what, change) => {
    expect((await put(change)).status).toBe(200);
    expect(h.set).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /global-kb/config by an admin', () => {
  it.each([
    ['enabled', { enabled: false }, CONFIG_KEYS.GLOBAL_KB_ENABLED, 'false'],
    ['namespace', { namespace: 'elsewhere' }, CONFIG_KEYS.GLOBAL_KB_NAMESPACE, 'elsewhere'],
    [
      'mode',
      { mode: 'external', connectionString: STORED_STRING },
      CONFIG_KEYS.GLOBAL_KB_MODE,
      'external',
    ],
  ])('changes %s', async (_field, change, key, value) => {
    const res = await put({ ...PAGE, ...change });

    expect(res.status).toBe(200);
    expect(written()).toContainEqual([key, value]);
  });

  it('writes the protected settings a full page save re-sends, as only a regular user is held back', async () => {
    const res = await put({ ...PAGE, connectionString: STORED_STRING });

    expect(res.status).toBe(200);
    expect(written()).toEqual(
      expect.arrayContaining([
        [CONFIG_KEYS.GLOBAL_KB_ENABLED, 'true'],
        [CONFIG_KEYS.GLOBAL_KB_MODE, 'internal'],
        [CONFIG_KEYS.GLOBAL_KB_NAMESPACE, 'default'],
      ]),
    );
    expect(h.setSecret).toHaveBeenCalledWith(
      SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING,
      STORED_STRING,
      expect.any(String),
    );
  });

  it('stores a new connection string, trimmed, and never echoes it', async () => {
    const res = await put({ connectionString: `  ${STORED_STRING}  ` });

    expect(res.status).toBe(200);
    expect(h.setSecret).toHaveBeenCalledWith(
      SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING,
      STORED_STRING,
      expect.any(String),
    );
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  describe('refuses external mode with 400 when no connection string is stored or given', () => {
    it.each([
      ['none stored or given', { mode: 'external' }],
      ['a blank one given', { mode: 'external', connectionString: '  ' }],
    ])('%s', async (_name, change) => {
      const res = await put({ ...PAGE, ...change });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('connection_string_required');
      expect(h.set).not.toHaveBeenCalled();
      expect(h.setSecret).not.toHaveBeenCalled();
    });

    it('when the mode is only stored as external, and the request does not touch it', async () => {
      h.settings = { ...SAVED, mode: 'external' };

      expect((await put({ archiveRetentionDays: 5 })).status).toBe(400);
      expect(h.set).not.toHaveBeenCalled();
    });

    it('but not when a string is given with it, or already stored', async () => {
      expect((await put({ mode: 'external', connectionString: STORED_STRING })).status).toBe(200);

      h.settings = { ...SAVED, connectionString: STORED_STRING };
      expect((await put({ mode: 'external' })).status).toBe(200);
    });

    it('and a regular user is told they may not change the mode before they are told what it needs', async () => {
      h.role = 'user';

      expect((await put({ mode: 'external' })).status).toBe(403);
    });
  });
});

describe('POST /global-kb/test-db', () => {
  const CONNECTION = 'postgres://probe:pw@169.254.169.254:5432/kb';
  const probe = () =>
    send('POST', '/global-kb/test-db', { mode: 'external', connectionString: CONNECTION });

  it('is refused to a regular user, and opens no connection', async () => {
    h.role = 'user';

    expect((await probe()).status).toBe(403);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('tests the connection an admin names, and reports what it found', async () => {
    const reached = await probe();

    expect(reached.status).toBe(200);
    expect(await reached.json()).toEqual({ ok: true, message: 'External DB reachable' });
    expect(h.connect).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'external', connectionString: CONNECTION }),
      undefined,
    );

    h.connect.mockRejectedValueOnce(new Error('connect ECONNREFUSED 169.254.169.254:5432'));
    const refused = await probe();

    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({
      ok: false,
      message: 'connect ECONNREFUSED 169.254.169.254:5432',
    });
  });
});

describe('/admin/config/house-rules', () => {
  it('reads on when nothing is stored, and off when it is switched off', async () => {
    const read = async () =>
      ((await (await send('GET', '/admin/config/house-rules')).json()) as { enabled: boolean })
        .enabled;

    expect(await read()).toBe(true);
    h.flags.set(CONFIG_KEYS.GLOBAL_KB_HOUSE_RULES_ENABLED, false);
    expect(await read()).toBe(false);
  });

  it('is written by an admin as the string the readers parse', async () => {
    for (const enabled of [false, true]) {
      const res = await send('PUT', '/admin/config/house-rules', { enabled });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled });
      expect(h.set).toHaveBeenLastCalledWith(
        CONFIG_KEYS.GLOBAL_KB_HOUSE_RULES_ENABLED,
        String(enabled),
      );
    }
  });

  it('is refused to a regular user, for reading and for writing', async () => {
    h.role = 'user';

    expect((await send('GET', '/admin/config/house-rules')).status).toBe(403);
    expect((await send('PUT', '/admin/config/house-rules', { enabled: false })).status).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a boolean', async () => {
    expect((await send('PUT', '/admin/config/house-rules', { enabled: 'no' })).status).toBe(400);
    expect(h.set).not.toHaveBeenCalled();
  });
});
