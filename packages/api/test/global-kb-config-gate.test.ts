import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin',
  flags: new Map<string, boolean>(),
  settings: {} as Record<string, unknown>,
  events: [] as string[],
  lockFails: false,
  readFails: false,
  settingsReads: 0,
  gate: null as Promise<void> | null,
  set: vi.fn(async (key: string, _value: string) => {
    h.events.push(`set:${key}`);
  }),
  setSecret: vi.fn(async (_key: string, _value: string, _label: string) => {
    h.events.push('set-secret');
  }),
  deleteSecret: vi.fn(async (_key: string) => {
    h.events.push('delete-secret');
    h.settings = { ...h.settings, connectionString: null };
  }),
  db: undefined as unknown,
  auditFails: [] as string[],
  auditExecutors: [] as unknown[],
  audits: [] as { table: unknown; row: unknown }[],
  auditLog: { info: vi.fn(), error: vi.fn() },
  vectorType: null as string | null,
  checks: [] as unknown[],
  connect: vi.fn(async (_settings: unknown, _db: unknown) => ({
    pg: Object.assign(async () => [], {
      begin: async (run: (tx: unknown) => Promise<unknown>) => {
        if (h.gate) await h.gate;
        h.events.push('begin');
        const tx = Object.assign(
          async (strings: TemplateStringsArray) => {
            if (strings.join('').includes('pg_advisory_xact_lock')) {
              if (h.lockFails) throw new Error('lock wait timed out');
              h.events.push('lock');
            }
            return [];
          },
          {
            unsafe: async (text: string) => {
              if (text.startsWith('SET')) return [];
              h.events.push('read');
              if (h.readFails) throw new Error('statement timeout');
              return rows(text);
            },
          },
        );
        try {
          const result = await run(tx);
          h.events.push('commit');
          return result;
        } catch (err) {
          h.events.push('rollback');
          throw err;
        }
      },
      end: async () => {},
    }),
    close: async () => {
      h.events.push('close');
    },
  })),
}));

const rows = (text: string) => {
  if (!text.includes('format_type')) return [];
  return h.vectorType === null ? [] : [{ type: h.vectorType }];
};

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
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
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...actual,
    logger: new Proxy(actual.logger, {
      get: (target, prop, receiver) =>
        prop === 'child'
          ? (bindings: { module?: string }) =>
              bindings.module === 'audit' ? h.auditLog : target.child(bindings)
          : Reflect.get(target, prop, receiver),
    }),
    configService: {
      getFresh: async (key: string) => (h.flags.has(key) ? String(h.flags.get(key)) : null),
      getBoolean: async (key: string, fallback: boolean) => h.flags.get(key) ?? fallback,
      set: h.set,
    },
    secretsService: { set: h.setSecret, delete: h.deleteSecret },
  };
});
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  resolveGlobalKbSettings: async () => {
    h.settingsReads += 1;
    return h.settings;
  },
  resolveGlobalKbConnection: (settings: unknown, db: unknown, opts?: unknown) => {
    if (opts !== undefined) h.checks.push(opts);
    return h.connect(settings, db);
  },
  withGlobalKb: async () => {
    throw new Error('the dims check must not ensure the schema');
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
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
const auditDb = () => {
  const open = (rows: { table: unknown; row: unknown }[]): Record<string, unknown> => {
    const tx = {
      insert: (table: unknown) => ({
        values: async (row: unknown) => {
          if (h.auditFails.includes((row as { action: string }).action)) {
            throw new Error('audit insert refused');
          }
          h.events.push('audit');
          h.auditExecutors.push(tx);
          rows.push({ table, row });
        },
      }),
      transaction: async (inner: (child: unknown) => Promise<unknown>) => {
        const child: typeof rows = [];
        const result = await inner(open(child));
        rows.push(...child);
        return result;
      },
    };
    return tx;
  };
  return {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      const rows: { table: unknown; row: unknown }[] = [];
      const result = await run(open(rows));
      h.audits.push(...rows);
      return result;
    },
  };
};

const actions = () => h.audits.map(({ row }) => (row as { action: string }).action);

beforeEach(() => {
  h.set.mockClear();
  h.setSecret.mockClear();
  h.deleteSecret.mockClear();
  h.connect.mockClear();
  h.db = auditDb();
  h.audits = [];
  h.auditExecutors = [];
  h.auditFails = [];
  h.auditLog.info.mockClear();
  h.auditLog.error.mockClear();
  h.vectorType = null;
  h.events = [];
  h.lockFails = false;
  h.readFails = false;
  h.checks = [];
  h.role = 'admin';
  h.flags = new Map();
  h.settings = { ...SAVED };
});

afterEach(() => {
  // A failed audit row fails the save; none may be swallowed into this logger.
  expect(h.auditLog.error).not.toHaveBeenCalled();
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

  it('writes the protected settings a full page save re-sends, as only a regular user is held back, but not the stored string', async () => {
    h.settings = { ...SAVED, connectionString: STORED_STRING };
    const res = await put({ ...PAGE, connectionString: STORED_STRING });

    expect(res.status).toBe(200);
    expect(written()).toEqual(
      expect.arrayContaining([
        [CONFIG_KEYS.GLOBAL_KB_ENABLED, 'true'],
        [CONFIG_KEYS.GLOBAL_KB_MODE, 'internal'],
        [CONFIG_KEYS.GLOBAL_KB_NAMESPACE, 'default'],
      ]),
    );
    expect(h.setSecret).not.toHaveBeenCalled();
  });

  it('stores a new connection string, trimmed, and never echoes it', async () => {
    const res = await put({ mode: 'external', connectionString: `  ${STORED_STRING}  ` });

    expect(res.status).toBe(200);
    expect(h.setSecret).toHaveBeenCalledWith(
      SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING,
      STORED_STRING,
      expect.any(String),
      h.auditExecutors[0],
    );
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  it.each([
    ['with none stored', null],
    ['in place of the stored one', STORED_STRING],
  ])('refuses a new connection string %s while the store stays internal', async (_how, stored) => {
    h.settings = { ...SAVED, connectionString: stored };
    const res = await put({ ...PAGE, connectionString: 'postgres://other:pw@elsewhere:5432/kb' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('connection_string_unused');
    expect(h.set).not.toHaveBeenCalled();
    expect(h.setSecret).not.toHaveBeenCalled();
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

describe('PUT /global-kb/config audit trail', () => {
  const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
  const AUDIT_USER = `audit-u-${randomUUID().slice(0, 8)}`;
  const AUDIT_PASS = `audit-p-${randomUUID().slice(0, 8)}`;
  const AUDIT_HOST = 'db.example.test';
  const target = new URL(`postgres://${AUDIT_HOST}/kb`);
  target.username = AUDIT_USER;
  target.password = AUDIT_PASS;
  const NEW_STRING = target.toString();
  const traces = () =>
    JSON.stringify([
      h.audits.map(({ row }) => row),
      h.auditLog.info.mock.calls,
      h.auditLog.error.mock.calls,
    ]);

  beforeEach(() => {
    h.db = auditDb();
  });

  it('records one event for the string and one for the settings when an admin sets it, and no part of the string', async () => {
    const res = await put({ ...PAGE, mode: 'external', connectionString: NEW_STRING });

    expect(res.status).toBe(200);
    expect(h.setSecret).toHaveBeenCalledWith(
      SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING,
      NEW_STRING,
      expect.any(String),
      h.auditExecutors[0],
    );
    expect(actions()).toEqual(['global_kb.connection_string.update', 'config.global_kb']);
    expect(h.audits[0]?.table).toBe(schema.auditEvents);
    expect(h.audits[0]?.row).toEqual({
      actorUserId: ADMIN_ID,
      action: 'global_kb.connection_string.update',
      targetType: 'global_kb',
      targetId: null,
      metadata: { connectionStringSet: true },
      createdAt: expect.anything(),
    });
    expect(h.audits[1]?.row).toMatchObject({ metadata: { connectionStringChanged: true } });
    expect(h.auditLog.info).toHaveBeenCalledTimes(2);
    expect(h.auditLog.info.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: ADMIN_ID,
      action: 'global_kb.connection_string.update',
      connectionStringSet: true,
    });
    for (const part of [NEW_STRING, AUDIT_USER, AUDIT_PASS, AUDIT_HOST]) {
      expect(traces()).not.toContain(part);
    }
  });

  it.each([
    ['sends none', { archiveRetentionDays: 7 }],
    [
      'sends it blank, as the page does while the field is untouched',
      { ...PAGE, connectionString: '  ' },
    ],
  ])('records only the settings when an admin saves other settings and %s', async (_how, body) => {
    const res = await put(body);

    expect(res.status).toBe(200);
    expect(h.set).toHaveBeenCalled();
    expect(h.setSecret).not.toHaveBeenCalled();
    expect(actions()).toEqual(['config.global_kb']);
    expect(h.audits[0]?.row).toMatchObject({ metadata: { connectionStringChanged: false } });
  });

  it.each([
    ['as stored', STORED_STRING],
    ['with spaces around it', `  ${STORED_STRING}  `],
  ])(
    'stores nothing and records nothing when an admin re-sends the stored string %s',
    async (_how, sent) => {
      h.settings = { ...SAVED, mode: 'external', connectionString: STORED_STRING };
      const res = await put({ connectionString: sent });

      expect(res.status).toBe(200);
      expect(h.setSecret).not.toHaveBeenCalled();
      expect(h.audits).toEqual([]);
      expect(h.auditLog.info).not.toHaveBeenCalled();
    },
  );

  describe('by a regular user', () => {
    beforeEach(() => {
      h.role = 'user';
      h.settings = { ...SAVED, connectionString: STORED_STRING };
    });

    it('records nothing for a connection string that is refused', async () => {
      const res = await put({ ...PAGE, connectionString: NEW_STRING });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('admin_required');
      expect(h.setSecret).not.toHaveBeenCalled();
      expect(h.audits).toEqual([]);
      expect(h.auditLog.info).not.toHaveBeenCalled();
    });

    it('records only the settings for the stored one re-sent, which is accepted and not written', async () => {
      const res = await put({ ...PAGE, connectionString: STORED_STRING });

      expect(res.status).toBe(200);
      expect(h.setSecret).not.toHaveBeenCalled();
      expect(actions()).toEqual(['config.global_kb']);
    });
  });
});

describe('PUT /global-kb/config storing the connection string before the settings', () => {
  const NEW_STRING = 'postgres://kb:pw@new.example:5432/kb';
  const MODE = `set:${CONFIG_KEYS.GLOBAL_KB_MODE}`;

  beforeEach(() => {
    h.db = auditDb();
  });

  it('stores the string and records its one audit row before it writes the mode that switches to it', async () => {
    const res = await put({ mode: 'external', connectionString: NEW_STRING });

    expect(res.status).toBe(200);
    expect(h.events).toEqual(['audit', 'set-secret', 'audit', MODE]);
    expect(h.setSecret).toHaveBeenCalledTimes(1);
  });

  it('refuses a new string sent with the mode that leaves for the built-in store, and writes nothing', async () => {
    h.settings = { ...SAVED, mode: 'external', connectionString: STORED_STRING };
    const res = await put({ mode: 'internal', connectionString: NEW_STRING });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('connection_string_unused');
    expect(h.events).toEqual([]);
  });

  it('stores them ahead of every setting of a full page save too', async () => {
    const res = await put({ ...PAGE, mode: 'external', connectionString: NEW_STRING });

    expect(res.status).toBe(200);
    expect(h.events.slice(0, 3)).toEqual(['audit', 'set-secret', 'audit']);
    expect(h.events).toContain(MODE);
    expect(h.events.filter((event) => event === 'audit')).toHaveLength(2);
  });

  it('keeps the single write of a save that sends only the mode', async () => {
    h.settings = { ...SAVED, connectionString: STORED_STRING };
    const res = await put({ mode: 'external' });

    expect(res.status).toBe(200);
    expect(h.events).toEqual(['audit', MODE]);
  });

  it('keeps the single write of a save that sends only the string', async () => {
    h.settings = { ...SAVED, mode: 'external', connectionString: STORED_STRING };
    const res = await put({ connectionString: NEW_STRING });

    expect(res.status).toBe(200);
    expect(h.events).toEqual(['audit', 'set-secret']);
  });

  describe('when the same save changes the embedding width and re-sends the stored string', () => {
    const RESEND = { ...PAGE, embedDimensions: 1024, connectionString: STORED_STRING };

    beforeEach(() => {
      h.settings = { ...SAVED, connectionString: STORED_STRING };
    });

    it('stores nothing and records nothing when the width lock refuses the new width', async () => {
      h.vectorType = 'vector(2560)';
      const res = await put(RESEND);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('embed_dimensions_locked');
      expect(h.setSecret).not.toHaveBeenCalled();
      expect(h.events).toEqual(['begin', 'lock', 'read', 'rollback', 'close']);
    });

    it('stores nothing and records nothing when the store cannot be reached', async () => {
      h.connect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const res = await put(RESEND);

      expect(res.status).toBe(500);
      expect(h.setSecret).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    });

    it('stores nothing for it when the width is accepted either, and records only the settings', async () => {
      const res = await put(RESEND);

      expect(res.status).toBe(200);
      expect(h.setSecret).not.toHaveBeenCalled();
      expect(h.events.filter((event) => event === 'audit')).toHaveLength(1);
      expect(h.events.slice(-2)).toEqual(['commit', 'close']);
      expect(h.events.indexOf('audit')).toBeLessThan(h.events.indexOf(MODE));
    });
  });
});

describe('PUT /global-kb/config removing the stored connection string', () => {
  const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
  const CLEAR = { clearConnectionString: true };
  const OTHER_STRING = 'postgres://other:pw@elsewhere:5432/kb';
  const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;
  const untouched = () => {
    expect(h.deleteSecret).not.toHaveBeenCalled();
    expect(h.setSecret).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
    expect(h.auditLog.info).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    h.settings = { ...SAVED, connectionString: STORED_STRING };
    h.db = auditDb();
  });

  it('deletes the secret once and records one event with no part of it, while the store is the built-in one', async () => {
    const res = await put(CLEAR);

    expect(res.status).toBe(200);
    expect(h.deleteSecret).toHaveBeenCalledTimes(1);
    expect(h.deleteSecret).toHaveBeenCalledWith(
      SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING,
      h.auditExecutors[0],
    );
    expect(h.setSecret).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.table).toBe(schema.auditEvents);
    expect(h.audits[0]?.row).toEqual({
      actorUserId: ADMIN_ID,
      action: 'global_kb.connection_string.update',
      targetType: 'global_kb',
      targetId: null,
      metadata: { connectionStringSet: false },
      createdAt: expect.anything(),
    });
    expect(h.auditLog.info).toHaveBeenCalledTimes(1);
    expect(h.auditLog.info.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: ADMIN_ID,
      action: 'global_kb.connection_string.update',
      connectionStringSet: false,
    });
    expect(
      JSON.stringify([h.audits.map(({ row }) => row), h.auditLog.info.mock.calls]),
    ).not.toContain('secret');
    expect(((await res.json()) as { connectionStringSet: boolean }).connectionStringSet).toBe(
      false,
    );
  });

  it.each([
    ['a blank connection string', { connectionString: '' }],
    ['a whitespace one', { connectionString: '   ' }],
    ['a full page save whose connection string is blank', { ...PAGE }],
  ])(
    'counts %s sent with the flag as no new string, and still removes the stored one',
    async (_what, extra) => {
      const res = await put({ ...extra, ...CLEAR });

      expect(res.status).toBe(200);
      expect(h.deleteSecret).toHaveBeenCalledTimes(1);
      expect(
        actions().filter((action) => action === 'global_kb.connection_string.update'),
      ).toHaveLength(1);
    },
  );

  describe('is refused with 409 while the store it leaves in place is the external one', () => {
    it('when the store is saved as external', async () => {
      h.settings = { ...SAVED, mode: 'external', connectionString: STORED_STRING };
      const res = await put(CLEAR);

      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe('connection_string_in_use');
      untouched();
    });

    it('when the same save switches the store to it, writing no other setting either', async () => {
      const res = await put({ ...PAGE, mode: 'external', ...CLEAR });

      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe('connection_string_in_use');
      untouched();
    });
  });

  it('is allowed when the same save switches the store to the built-in one, and removes the string only after the mode is written', async () => {
    h.settings = { ...SAVED, mode: 'external', connectionString: STORED_STRING };
    const res = await put({ mode: 'internal', ...CLEAR });

    expect(res.status).toBe(200);
    expect(h.events).toEqual([
      'audit',
      `set:${CONFIG_KEYS.GLOBAL_KB_MODE}`,
      'audit',
      'delete-secret',
    ]);
    expect(actions()).toEqual(['config.global_kb', 'global_kb.connection_string.update']);
    expect(h.audits[0]?.row).toMatchObject({ metadata: { connectionStringChanged: false } });
  });

  it.each([
    ['a new connection string', { connectionString: OTHER_STRING }],
    [
      'a full page save that names a new connection string',
      { ...PAGE, connectionString: OTHER_STRING },
    ],
  ])(
    'is refused with 400 when the flag is sent with %s, and changes nothing',
    async (_what, body) => {
      const res = await put({ ...body, ...CLEAR });

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('connection_string_set_and_clear');
      untouched();
    },
  );

  it.each([
    ['alone', CLEAR],
    ['with the rest of a full page save', { ...PAGE, ...CLEAR }],
  ])(
    'is refused to a regular user sending the flag %s, who deletes and writes nothing',
    async (_how, body) => {
      h.role = 'user';
      const res = await put(body);

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('admin_required');
      untouched();
    },
  );

  it.each([
    ['blank', { ...PAGE, connectionString: '' }],
    ['whitespace', { ...PAGE, connectionString: '   ' }],
    ['absent', { archiveRetentionDays: 7 }],
    [
      'absent next to an explicit false flag',
      { archiveRetentionDays: 7, clearConnectionString: false },
    ],
  ])('deletes nothing for a save whose connection string is %s', async (_how, body) => {
    const res = await put(body);

    expect(res.status).toBe(200);
    expect(h.deleteSecret).not.toHaveBeenCalled();
    expect(actions()).toEqual(['config.global_kb']);
  });
});

describe('PUT /global-kb/config with a different embedding width', () => {
  const widen = { ...PAGE, embedDimensions: 1024 };

  it('is refused with 409 while the store has a vector column of another width, rows or not, and writes nothing', async () => {
    h.vectorType = 'vector(2560)';
    const res = await put(widen);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('embed_dimensions_locked');
    expect(h.set).not.toHaveBeenCalled();
    expect(h.setSecret).not.toHaveBeenCalled();
  });

  it('is refused for a regular user too, before any other field of the save is written', async () => {
    h.vectorType = 'vector(2560)';
    h.role = 'user';

    expect((await put({ ...widen, digestEnabled: false })).status).toBe(409);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('reads the store under a connect timeout and a deadline', async () => {
    h.vectorType = 'vector(2560)';
    await put(widen);

    expect(h.checks).toEqual([
      expect.objectContaining({ connectTimeoutSeconds: expect.any(Number), fetchTypes: false }),
    ]);
  });

  it('is accepted when the store has no vector column or no table yet', async () => {
    const res = await put(widen);

    expect(res.status).toBe(200);
    expect(written()).toContainEqual([CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS, '1024']);
  });

  it('is accepted when the column already has the new width', async () => {
    h.vectorType = 'vector(1024)';
    const res = await put(widen);

    expect(res.status).toBe(200);
    expect(written()).toContainEqual([CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS, '1024']);
  });

  it('is refused when the column carries no width, which no new width can match', async () => {
    h.vectorType = 'vector';

    expect((await put(widen)).status).toBe(409);
  });

  it('is refused together with a store switch, whose vectors it cannot read', async () => {
    const res = await put({ ...widen, mode: 'external', connectionString: 'postgres://u:p@db/kb' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'embed_dimensions_with_store_change',
    );
    expect(h.checks).toEqual([]);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('writes the save inside the schema lock, after the width is read, and commits last', async () => {
    const res = await put({ ...widen, namespace: 'other', embedModel: 'model-z' });

    expect(res.status).toBe(200);
    expect(h.events).toEqual([
      'begin',
      'lock',
      'read',
      'audit',
      `set:${CONFIG_KEYS.GLOBAL_KB_ENABLED}`,
      `set:${CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED}`,
      `set:${CONFIG_KEYS.GLOBAL_KB_MODE}`,
      `set:${CONFIG_KEYS.GLOBAL_KB_NAMESPACE}`,
      `set:${CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL}`,
      `set:${CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL}`,
      `set:${CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS}`,
      `set:${CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS}`,
      'commit',
      'close',
    ]);
  });

  it('writes nothing and rolls back on a width mismatch', async () => {
    h.vectorType = 'vector(2560)';
    const res = await put(widen);

    expect(res.status).toBe(409);
    expect(h.events).toEqual(['begin', 'lock', 'read', 'rollback', 'close']);
  });

  it('fails the request, writing nothing, when the lock cannot be taken', async () => {
    h.lockFails = true;
    const res = await put(widen);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.events).not.toContain('commit');
  });

  it('fails the request, writing nothing, when the width cannot be read', async () => {
    h.readFails = true;
    const res = await put(widen);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.setSecret).not.toHaveBeenCalled();
    expect(h.events).not.toContain('commit');
  });

  it('fails the request, writing nothing, when the store cannot be reached', async () => {
    h.connect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await put(widen);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('lets a second save read the settings only after the first one is done', async () => {
    let release!: () => void;
    h.gate = new Promise<void>((resolve) => (release = resolve));
    const first = put(widen);
    await vi.waitFor(() => expect(h.connect).toHaveBeenCalled());
    const readsBefore = h.settingsReads;
    const second = put({ ...PAGE, namespace: 'other' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.settingsReads).toBe(readsBefore);

    release();
    h.gate = null;
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(h.settingsReads).toBeGreaterThan(readsBefore);
  });

  it('is not checked, and accepted, when the width is unchanged', async () => {
    h.vectorType = 'vector(2560)';
    const res = await put(PAGE);

    expect(res.status).toBe(200);
    expect(h.checks).toEqual([]);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.events).toEqual(expect.not.arrayContaining(['begin']));
  });

  it('opens no connection for a save that leaves the width alone', async () => {
    expect((await put({ digestEnabled: false })).status).toBe(200);

    expect(h.connect).not.toHaveBeenCalled();
    expect(h.set).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /global-kb/config settings audit', () => {
  const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';

  it('records one row with every setting before, read past the cache, and after', async () => {
    h.flags.set(CONFIG_KEYS.GLOBAL_KB_ENABLED, true);
    h.flags.set(CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED, false);
    const res = await put({ ...PAGE, enabled: false });

    expect(res.status).toBe(200);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.table).toBe(schema.auditEvents);
    expect(h.audits[0]?.row).toEqual({
      actorUserId: ADMIN_ID,
      action: 'config.global_kb',
      targetType: 'system',
      targetId: null,
      metadata: {
        from: {
          enabled: 'true',
          digestEnabled: 'false',
          mode: null,
          namespace: null,
          ollamaUrl: null,
          embedModel: null,
          embedDimensions: null,
          archiveRetentionDays: null,
        },
        to: {
          enabled: 'false',
          digestEnabled: 'true',
          mode: 'internal',
          namespace: 'default',
          ollamaUrl: 'http://ollama:11434',
          embedModel: 'qwen3-embedding:4b',
          embedDimensions: '2560',
          archiveRetentionDays: '30',
        },
        connectionStringChanged: false,
      },
      createdAt: expect.anything(),
    });
  });

  it('keeps what a regular user may not write at its stored value', async () => {
    h.role = 'user';
    h.flags.set(CONFIG_KEYS.GLOBAL_KB_ENABLED, true);
    const res = await put({ ...PAGE, digestEnabled: false });

    expect(res.status).toBe(200);
    expect(h.audits[0]?.row).toMatchObject({
      action: 'config.global_kb',
      metadata: {
        from: { enabled: 'true', digestEnabled: null, mode: null, namespace: null },
        to: { enabled: 'true', digestEnabled: 'false', mode: null, namespace: null },
      },
    });
  });

  it('records nothing for a save that writes no setting', async () => {
    h.role = 'user';

    expect((await put({ enabled: true, mode: 'internal' })).status).toBe(200);
    expect(h.audits).toEqual([]);
  });

  it('records what was written before a failed write as partial, and fails the save', async () => {
    h.set
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('redis down'));
    const res = await put({ ...PAGE, enabled: false });

    expect(res.status).toBe(500);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.row).toMatchObject({
      action: 'config.global_kb',
      metadata: {
        from: { enabled: null, digestEnabled: null, mode: null },
        to: { enabled: 'false', digestEnabled: 'true', mode: 'internal' },
        connectionStringChanged: false,
        partial: true,
      },
    });
    expect(Object.keys((h.audits[0]?.row as { metadata: { to: object } }).metadata.to)).toEqual([
      'enabled',
      'digestEnabled',
      'mode',
    ]);
  });
});

describe('PUT /global-kb/config audit rows are strict', () => {
  const NEW_STRING = 'postgres://kb:pw@new.example:5432/kb';
  const STRING_ACTION = 'global_kb.connection_string.update';
  const nothingRecorded = () => {
    expect(h.audits).toEqual([]);
    expect(h.auditLog.info).not.toHaveBeenCalled();
  };

  it('fails the save and stores no string when its row is refused', async () => {
    h.auditFails = [STRING_ACTION];
    const res = await put({ mode: 'external', connectionString: NEW_STRING });

    expect(res.status).toBe(500);
    expect(h.setSecret).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it('takes its row back when the string cannot be stored', async () => {
    h.setSecret.mockRejectedValueOnce(new Error('secrets down'));
    const res = await put({ mode: 'external', connectionString: NEW_STRING });

    expect(res.status).toBe(500);
    expect(h.set).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it('fails the save and writes no setting when the settings row is refused', async () => {
    h.auditFails = ['config.global_kb'];
    const res = await put({ ...PAGE, enabled: false });

    expect(res.status).toBe(500);
    expect(h.set).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it('takes the settings row back when the first write fails', async () => {
    h.set.mockRejectedValueOnce(new Error('redis down'));
    const res = await put({ ...PAGE, enabled: false });

    expect(res.status).toBe(500);
    nothingRecorded();
  });

  it('fails the save and keeps the string when the removal row is refused', async () => {
    h.settings = { ...SAVED, connectionString: STORED_STRING };
    h.auditFails = [STRING_ACTION];
    const res = await put({ clearConnectionString: true });

    expect(res.status).toBe(500);
    expect(h.deleteSecret).not.toHaveBeenCalled();
    nothingRecorded();
  });

  it('takes the removal row back when the string cannot be deleted', async () => {
    h.settings = { ...SAVED, connectionString: STORED_STRING };
    h.deleteSecret.mockRejectedValueOnce(new Error('secrets down'));
    const res = await put({ clearConnectionString: true });

    expect(res.status).toBe(500);
    nothingRecorded();
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
      h.db,
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
  beforeEach(() => {
    h.db = {
      transaction: async (run: (tx: unknown) => unknown) => {
        const tx = {
          execute: async () => [],
          insert: () => ({ values: async () => undefined }),
          transaction: (inner: (t: unknown) => unknown) => inner(tx),
        };
        return run(tx);
      },
    };
  });

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
