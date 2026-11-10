const authLock = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn(async () => {}) }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: authLock.acquire,
}));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  transactionOpen: false,
  auditLog: vi.fn(),
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/audit.js', async (original) => ({
  ...(await original<typeof import('../src/lib/audit.js')>()),
  logAuditEvent: h.auditLog,
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ add: h.add }),
  getUsagePollQueue: () => ({ add: vi.fn() }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  configService,
  DEFAULT_AGENT_RULES,
  envelopeDecrypt,
  logger,
  secretsService,
} from '@haive/shared';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const KEK = 'ab'.repeat(32);
const SECRET_VALUE = 'sk-test-value-123';

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

function setup(existing = false) {
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    cliProviders: schema.cliProviders,
    cliPackageVersions: schema.cliPackageVersions,
    cliProviderSecrets: schema.cliProviderSecrets,
    usageWindowSnapshots: schema.usageWindowSnapshots,
  });
  if (existing) {
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      name: 'claude-code',
      label: 'p',
      authMode: 'subscription',
      isolateAuth: false,
      rulesContent: DEFAULT_AGENT_RULES,
      envVars: { ANTHROPIC_BASE_URL: 'https://old.example' },
    });
  }
  const transaction = fake.db.transaction.bind(fake.db);
  fake.db.transaction = async (fn) => {
    h.transactionOpen = true;
    try {
      return await transaction(fn);
    } finally {
      h.transactionOpen = false;
    }
  };
  h.db = fake.db;
  return fake;
}

function send(method: string, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ENV = { ANTHROPIC_BASE_URL: 'https://api.example', ANTHROPIC_API_KEY: SECRET_VALUE };

beforeEach(() => {
  authLock.acquire.mockReset().mockResolvedValue(authLock.release);
  authLock.release.mockClear();
  h.transactionOpen = false;
  h.auditLog.mockReset();
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

afterEach(() => vi.restoreAllMocks());

function secretValues(fake: ReturnType<typeof setup>): Record<string, string> {
  return Object.fromEntries(
    fake
      .rows(schema.cliProviderSecrets)
      .map((r) => [
        r.secretName as string,
        envelopeDecrypt(
          { encryptedValue: r.encryptedValue as string, encryptedDek: r.encryptedDek as string },
          KEK,
        ),
      ]),
  );
}

describe('a provider saved through the API with a secret-looking env key', () => {
  it('create stores the key as a secret, not in envVars, and never echoes it', async () => {
    const fake = setup();
    const res = await send('POST', '/', {
      name: 'claude-code',
      label: 'p',
      authMode: 'api_key',
      envVars: ENV,
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET_VALUE);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example',
    });
    expect(secretValues(fake)).toEqual({ ANTHROPIC_API_KEY: SECRET_VALUE });
  });

  it('update stores the key as a secret, not in envVars, and never echoes it', async () => {
    const fake = setup(true);
    const res = await send('PATCH', `/${PROVIDER}`, { envVars: ENV });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET_VALUE);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example',
    });
    expect(secretValues(fake)).toEqual({ ANTHROPIC_API_KEY: SECRET_VALUE });
  });

  it('update overwrites a secret of the same name', async () => {
    const fake = setup(true);
    await send('PATCH', `/${PROVIDER}`, { envVars: { ANTHROPIC_API_KEY: 'old-value' } });
    await send('PATCH', `/${PROVIDER}`, { envVars: ENV });
    expect(secretValues(fake)).toEqual({ ANTHROPIC_API_KEY: SECRET_VALUE });
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(1);
  });

  it('update without envVars leaves envVars and secrets alone', async () => {
    const fake = setup(true);
    const res = await send('PATCH', `/${PROVIDER}`, { label: 'renamed' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.cliProviders)[0]!.envVars).toEqual({
      ANTHROPIC_BASE_URL: 'https://old.example',
    });
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  });
});

describe('cloning a provider saved before the split', () => {
  it('gives the clone the legacy key as a secret, never in envVars', async () => {
    const fake = setup();
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      name: 'claude-code',
      label: 'p',
      rulesContent: DEFAULT_AGENT_RULES,
      envVars: ENV,
    });
    const res = await send('POST', `/${PROVIDER}/clone`, {});
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET_VALUE);
    const clone = fake.rows(schema.cliProviders).find((r) => r.id !== PROVIDER)!;
    expect(clone.envVars).toEqual({ ANTHROPIC_BASE_URL: 'https://api.example' });
    const cloneSecrets = fake
      .rows(schema.cliProviderSecrets)
      .filter((r) => r.providerId === clone.id)
      .map((r) => r.secretName);
    expect(cloneSecrets).toEqual(['ANTHROPIC_API_KEY']);
  });
});

describe('POST /:providerId/secrets', () => {
  it('answers 201 for a new secret and 200 when it overwrites one, never echoing the value', async () => {
    const fake = setup(true);
    const first = await send('POST', `/${PROVIDER}/secrets`, {
      secretName: 'API_KEY',
      value: 'old-value',
    });
    expect(first.status).toBe(201);
    const second = await send('POST', `/${PROVIDER}/secrets`, {
      secretName: 'API_KEY',
      value: SECRET_VALUE,
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { secret: Record<string, unknown> };
    expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
    expect(body.secret).toMatchObject({ secretName: 'API_KEY' });
    expect(secretValues(fake)).toEqual({ API_KEY: SECRET_VALUE });
  });
});

describe('strict provider security updates', () => {
  const changes = [
    { networkPolicy: { mode: 'none', domains: [], ips: [] } },
    { egressDomains: ['api.example'] },
    { wrapperContent: 'echo hidden-wrapper' },
    { wrapperPath: '/hidden/wrapper' },
    { executablePath: '/hidden/cli' },
    { cliArgs: ['hidden-argument'] },
    { sandboxDockerfileExtra: 'RUN echo hidden-dockerfile' },
    { rulesContent: 'hidden-rules' },
    { modelfile: 'FROM hidden-model' },
    { envVars: { ANTHROPIC_BASE_URL: 'https://hidden.example' } },
  ];
  it.each(changes)('audit refusal rolls back %j without enqueuing', async (change) => {
    const fake = setup(true);
    const before = fake.rows(schema.cliProviders);
    fake.hooks.beforeInsert = async (table) => {
      if (table === schema.auditEvents) throw new Error('audit refused');
    };
    expect((await send('PATCH', '/' + PROVIDER, change)).status).toBe(500);
    expect(fake.rows(schema.cliProviders)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  });
  it('records changed field and environment names, never their values', async () => {
    const fake = setup(true);
    expect(
      (
        await send('PATCH', '/' + PROVIDER, {
          wrapperContent: 'hidden-wrapper',
          cliArgs: ['hidden-argument'],
          envVars: { ANTHROPIC_BASE_URL: 'https://hidden.example' },
        })
      ).status,
    ).toBe(200);
    expect(fake.rows(schema.auditEvents)).toMatchObject([
      {
        action: 'cli_provider.update',
        actorUserId: USER,
        targetId: PROVIDER,
        metadata: {
          fields: ['wrapperContent', 'cliArgs', 'envVars'],
          envNames: ['ANTHROPIC_BASE_URL'],
        },
      },
    ]);
    expect(JSON.stringify(fake.rows(schema.auditEvents))).not.toContain('hidden');
  });
  it('lists a removed environment name too', async () => {
    const fake = setup(true);
    expect((await send('PATCH', '/' + PROVIDER, { envVars: {} })).status).toBe(200);
    expect(fake.rows(schema.auditEvents)).toMatchObject([
      { metadata: { fields: ['envVars'], envNames: ['ANTHROPIC_BASE_URL'] } },
    ]);
  });
  it('writes no update row for unchanged security fields', async () => {
    const fake = setup(true);
    expect(
      (
        await send('PATCH', '/' + PROVIDER, {
          envVars: { ANTHROPIC_BASE_URL: 'https://old.example' },
        })
      ).status,
    ).toBe(200);
    expect(fake.rows(schema.auditEvents)).toEqual([]);
  });
});
describe('strict provider sign-out enqueue', () => {
  it('refuses enqueue when its audit insert fails', async () => {
    const fake = setup(true);
    fake.hooks.beforeInsert = async (table) => {
      if (table === schema.auditEvents) throw new Error('audit refused');
    };
    h.add.mockResolvedValue({ id: 'job-1' } as never);
    expect((await send('POST', '/' + PROVIDER + '/sign-out', {})).status).toBe(500);
    expect(h.add).not.toHaveBeenCalled();
  });
  it.each(['reject', 'missing-id'])('rolls the row back on enqueue %s', async (failure) => {
    const fake = setup(true);
    if (failure === 'reject') h.add.mockRejectedValue(new Error('queue refused'));
    else h.add.mockResolvedValue({} as never);
    expect((await send('POST', '/' + PROVIDER + '/sign-out', {})).status).toBe(500);
    expect(fake.rows(schema.auditEvents)).toEqual([]);
  });
  it('inserts the row before enqueue and retains it on success', async () => {
    const fake = setup(true);
    h.add.mockImplementation(async () => {
      expect(fake.rows(schema.auditEvents)).toMatchObject([
        { action: 'cli_provider.sign_out', actorUserId: USER, targetId: PROVIDER },
      ]);
      return { id: 'job-1' } as never;
    });
    expect((await send('POST', '/' + PROVIDER + '/sign-out', {})).status).toBe(202);
    expect(fake.rows(schema.auditEvents)).toHaveLength(1);
  });
});

it('does not audit a network policy whose object key order differs', async () => {
  const fake = setup(true);
  fake.patch(schema.cliProviders, PROVIDER, {
    networkPolicy: { ips: [], domains: [], mode: 'full' },
  });
  expect(
    (await send('PATCH', '/' + PROVIDER, { networkPolicy: { mode: 'full', domains: [], ips: [] } }))
      .status,
  ).toBe(200);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});

it('keeps a committed sign-out row while enqueue waits without a transaction', async () => {
  const fake = setup(true);
  vi.useFakeTimers();
  let release!: (value: never) => void;
  let reached!: () => void;
  const adding = new Promise<void>((resolve) => {
    reached = resolve;
  });
  h.add.mockImplementation(() => {
    reached();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const request = Promise.resolve(send('POST', '/' + PROVIDER + '/sign-out', {}));
  try {
    await adding;
    expect(h.transactionOpen).toBe(false);
    expect(fake.rows(schema.auditEvents)).toHaveLength(1);
    expect(h.auditLog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.rows(schema.auditEvents)).toHaveLength(1);
    expect(h.transactionOpen).toBe(false);
    expect(h.auditLog).not.toHaveBeenCalled();
  } finally {
    release({ id: 'late-job' } as never);
    await request;
    vi.useRealTimers();
  }
  expect((await request).status).toBe(202);
  expect(fake.rows(schema.auditEvents)).toHaveLength(1);
  expect(h.auditLog).toHaveBeenCalledOnce();
});

describe('empty provider security values are audit no-ops', () => {
  it.each([
    ['cliArgs', null, []],
    ['wrapperContent', '', ''],
    ['wrapperPath', '', ''],
    ['executablePath', '', ''],
    ['sandboxDockerfileExtra', '', ''],
    ['cliVersion', '', ''],
    ['envVars', null, {}],
  ])('does not audit an empty %s save', async (field, before, after) => {
    const fake = setup(true);
    fake.patch(schema.cliProviders, PROVIDER, { [field as string]: before });
    expect((await send('PATCH', '/' + PROVIDER, { [field as string]: after })).status).toBe(200);
    expect(fake.rows(schema.auditEvents)).toEqual([]);
  });
});

describe('strict provider creation', () => {
  it('refuses creation without an audit and queues nothing', async () => {
    const fake = setup();
    fake.hooks.beforeInsert = async (table) => {
      if (table === schema.auditEvents) throw new Error('audit refused');
    };
    expect(
      (await send('POST', '/', { name: 'claude-code', label: 'p', authMode: 'api_key' })).status,
    ).toBe(500);
    expect(fake.rows(schema.cliProviders)).toEqual([]);
    expect(fake.rows(schema.auditEvents)).toEqual([]);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('records only the configured security field and environment names', async () => {
    const fake = setup();
    expect(
      (
        await send('POST', '/', {
          name: 'claude-code',
          label: 'hidden-label',
          authMode: 'api_key',
          networkPolicy: { mode: 'none', domains: [], ips: [] },
          wrapperContent: 'hidden-wrapper',
          cliArgs: ['hidden-argument'],
          envVars: ENV,
          rulesContent: 'hidden-rules',
          modelfile: 'FROM hidden-model',
        })
      ).status,
    ).toBe(201);
    const rows = fake.rows(schema.auditEvents);
    const event = rows.find((row) => row.action === 'cli_provider.create');
    expect(event).toMatchObject({
      actorUserId: USER,
      targetType: 'cli_provider',
      targetId: fake.rows(schema.cliProviders)[0]!.id,
      metadata: {
        fields: [
          'networkPolicy',
          'wrapperContent',
          'cliArgs',
          'authMode',
          'rulesContent',
          'modelfile',
          'envVars',
        ],
        envNames: ['ANTHROPIC_BASE_URL'],
      },
    });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('hidden');
    expect(JSON.stringify(rows)).not.toContain(SECRET_VALUE);
  });
});

it('records rules and Modelfile updates by name without their content', async () => {
  const fake = setup(true);
  expect(
    (
      await send('PATCH', '/' + PROVIDER, {
        rulesContent: 'hidden-rules',
        modelfile: 'FROM hidden-model',
      })
    ).status,
  ).toBe(200);
  expect(fake.rows(schema.auditEvents)).toMatchObject([
    { action: 'cli_provider.update', metadata: { fields: ['rulesContent', 'modelfile'] } },
  ]);
  expect(JSON.stringify(fake.rows(schema.auditEvents))).not.toContain('hidden');
});

it.each(['reject', 'missing-id'])(
  'compensates only this sign-out row on %s and does not log success',
  async (failure) => {
    const fake = setup(true);
    fake.insert(schema.auditEvents, {
      actorUserId: USER,
      action: 'cli_provider.sign_out',
      targetType: 'cli_provider',
      targetId: PROVIDER,
    });
    const before = fake.rows(schema.auditEvents);
    let transactionAtAdd: boolean | undefined;
    let rowsAtAdd = 0;
    let loggedAtAdd = false;
    h.add.mockImplementation(async () => {
      transactionAtAdd = h.transactionOpen;
      rowsAtAdd = fake.rows(schema.auditEvents).length;
      loggedAtAdd = h.auditLog.mock.calls.length > 0;
      if (failure === 'reject') throw new Error('queue refused');
      return {} as never;
    });
    const result = await send('POST', '/' + PROVIDER + '/sign-out', {});
    expect(result.status).toBe(500);
    expect(transactionAtAdd).toBe(false);
    expect(rowsAtAdd).toBe(2);
    expect(loggedAtAdd).toBe(false);
    expect(fake.rows(schema.auditEvents)).toEqual(before);
    expect(h.auditLog).not.toHaveBeenCalled();
  },
);

it('preserves and logs a failed sign-out compensation without replacing the enqueue error', async () => {
  const fake = setup(true);
  const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
  fake.hooks.beforeDelete = async () => {
    throw new Error('delete refused');
  };
  h.add.mockResolvedValue({} as never);
  const result = await send('POST', '/' + PROVIDER + '/sign-out', {});
  expect(result.status).toBe(500);
  expect(await result.json()).toMatchObject({ code: 'sign_out_enqueue_failed' });
  expect(fake.rows(schema.auditEvents)).toHaveLength(1);
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ err: expect.any(Error), auditId: expect.any(String) }),
    expect.stringContaining('audit'),
  );
  expect(h.auditLog).not.toHaveBeenCalled();
});

it('a sign-out audit commit failure queues nothing', async () => {
  const fake = setup(true);
  h.add.mockResolvedValue({ id: 'job-1' } as never);
  fake.hooks.beforeCommit = async () => {
    throw new Error('commit refused');
  };
  expect((await send('POST', '/' + PROVIDER + '/sign-out', {})).status).toBe(500);
  expect(h.add).not.toHaveBeenCalled();
  expect(fake.rows(schema.auditEvents)).toEqual([]);
  expect(h.auditLog).not.toHaveBeenCalled();
});

describe('sign-out secret writers advance the generation under the auth lock', () => {
  it.each(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USAGE_OAUTH'])(
    'fences manual and environment writes of %s',
    async (secretName) => {
      const fake = setup(true);
      for (const method of secretName === 'CLAUDE_CODE_OAUTH_TOKEN'
        ? ['POST', 'PATCH']
        : ['POST']) {
        const before = fake.rows(schema.cliProviders)[0]!.authGeneration;
        const res = await send(
          method,
          `/${PROVIDER}${method === 'POST' ? '/secrets' : ''}`,
          method === 'POST'
            ? { secretName, value: 'new-token' }
            : { envVars: { [secretName]: 'new-token' } },
        );
        expect([200, 201]).toContain(res.status);
        expect(fake.rows(schema.cliProviders)[0]!.authGeneration).not.toBe(before);
      }
      const writes = secretName === 'CLAUDE_CODE_OAUTH_TOKEN' ? 2 : 1;
      expect(authLock.acquire).toHaveBeenCalledTimes(writes);
      expect(authLock.release).toHaveBeenCalledTimes(writes);
    },
  );
  it('refuses a login-secret write whose auth scope changed while the lock was taken', async () => {
    const fake = setup(true);
    const before = fake.rows(schema.cliProviders)[0]!;
    authLock.acquire.mockImplementationOnce(async () => {
      fake.patch(schema.cliProviders, PROVIDER, { isolateAuth: true });
      return authLock.release;
    });
    const res = await send('POST', `/${PROVIDER}/secrets`, {
      secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: 'new-token',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'cli_auth_busy' });
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
    expect(fake.rows(schema.cliProviders)[0]!.authGeneration).toBe(before.authGeneration);
    expect(authLock.release).toHaveBeenCalledOnce();
  });
  it.each(['POST', 'PATCH'])(
    'refuses a busy %s write with 409 and keeps the credential',
    async (method) => {
      const fake = setup(true);
      authLock.acquire.mockResolvedValue(null);
      const res = await send(
        method,
        `/${PROVIDER}${method === 'POST' ? '/secrets' : ''}`,
        method === 'POST'
          ? { secretName: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'new-token' }
          : { envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'new-token' } },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'cli_auth_busy',
        error:
          'CLI authentication is busy. Finish the current sign-in or credential update and try again.',
      });
      expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
      expect(fake.rows(schema.auditEvents)).toHaveLength(0);
    },
  );
});

describe('provider auth scope changes', () => {
  const changes = [{ isolateAuth: true }, { authMode: 'api_key' }] as const;
  for (const change of changes) {
    it.each(['old', 'new'] as const)(
      `refuses ${JSON.stringify(change)} while the %s scope is held`,
      async (held) => {
        const fake = setup(true);
        const before = fake.rows(schema.cliProviders)[0]!;
        const oldScope = cliAuthScope(before as any);
        const newScope = cliAuthScope({ ...before, ...change } as any);
        authLock.acquire.mockImplementation(async (_db, scope) => {
          expect(h.transactionOpen).toBe(false);
          return scope === (held === 'old' ? oldScope : newScope) ? null : authLock.release;
        });
        const res = await send('PATCH', `/${PROVIDER}`, change);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'cli_auth_busy' });
        expect(fake.rows(schema.cliProviders)[0]).toEqual(before);
        expect(fake.rows(schema.auditEvents)).toHaveLength(0);
        expect(authLock.release).toHaveBeenCalledTimes(authLock.acquire.mock.calls.length - 1);
      },
    );
    it(`changes ${JSON.stringify(change)} without advancing the generation and releases both scopes`, async () => {
      const fake = setup(true);
      const before = fake.rows(schema.cliProviders)[0]!;
      const scopes = [
        cliAuthScope(before as any),
        cliAuthScope({ ...before, ...change } as any),
      ].sort();
      const res = await send('PATCH', `/${PROVIDER}`, change);
      expect(res.status).toBe(200);
      expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
        ...change,
        authGeneration: before.authGeneration,
      });
      expect(authLock.acquire.mock.calls.map((call) => call[1])).toEqual(scopes);
      expect(authLock.release).toHaveBeenCalledTimes(2);
    });
  }
  it.each([false, true])(
    'reuses held scopes when a secret moves with isolateAuth=%s',
    async (isolated) => {
      const fake = setup(true);
      fake.patch(schema.cliProviders, PROVIDER, { isolateAuth: isolated });
      const before = fake.rows(schema.cliProviders)[0]!;
      const res = await send('PATCH', `/${PROVIDER}`, {
        isolateAuth: !isolated,
        envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'new-token' },
      });
      expect(res.status).toBe(200);
      expect(authLock.acquire.mock.calls.map((call) => call[1])).toEqual(
        [
          cliAuthScope(before as any),
          cliAuthScope({ ...before, isolateAuth: !isolated } as any),
        ].sort(),
      );
      expect(authLock.release).toHaveBeenCalledTimes(2);
      expect(fake.rows(schema.cliProviders)[0]!.authGeneration).not.toBe(before.authGeneration);
      expect(secretValues(fake)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'new-token' });
    },
  );
  it('acquires a scope once when isolated authMode changes also move a secret', async () => {
    const fake = setup(true);
    fake.patch(schema.cliProviders, PROVIDER, { isolateAuth: true });
    expect(
      (
        await send('PATCH', `/${PROVIDER}`, {
          authMode: 'api_key',
          envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'new-token' },
        })
      ).status,
    ).toBe(200);
    expect(authLock.acquire).toHaveBeenCalledOnce();
    expect(authLock.release).toHaveBeenCalledOnce();
  });
  it('releases both scopes after an audit refusal', async () => {
    const fake = setup(true);
    const before = fake.rows(schema.cliProviders)[0]!;
    fake.hooks.beforeInsert = async () => {
      throw new Error('audit refused');
    };
    expect((await send('PATCH', `/${PROVIDER}`, { isolateAuth: true })).status).toBe(500);
    expect(fake.rows(schema.cliProviders)[0]).toEqual(before);
    expect(authLock.acquire).toHaveBeenCalledTimes(2);
    expect(authLock.release).toHaveBeenCalledTimes(2);
  });
  it('takes no lock for unchanged auth settings and saves while the scope is held', async () => {
    const fake = setup(true);
    const before = fake.rows(schema.cliProviders)[0]!;
    authLock.acquire.mockResolvedValue(null);
    const res = await send('PATCH', `/${PROVIDER}`, {
      authMode: before.authMode,
      isolateAuth: before.isolateAuth,
      label: 'Renamed while signing in',
    });
    expect(res.status).toBe(200);
    expect(authLock.acquire).not.toHaveBeenCalled();
    expect(fake.rows(schema.cliProviders)[0]!.label).toBe('Renamed while signing in');
    expect(fake.rows(schema.cliProviders)[0]!.authGeneration).toBe(before.authGeneration);
  });
  it.each([
    { isolateAuth: true, envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'new-token' } },
    { authMode: 'api_key' },
  ])('refuses a stale scope read before writing %j', async (change) => {
    const fake = setup(true);
    authLock.acquire.mockImplementation(async () => {
      fake.patch(schema.cliProviders, PROVIDER, { authMode: 'api_key' });
      return authLock.release;
    });
    const res = await send('PATCH', `/${PROVIDER}`, change);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'cli_auth_busy' });
    expect(fake.rows(schema.cliProviders)[0]!.isolateAuth).toBe(false);
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
    expect(fake.rows(schema.auditEvents)).toHaveLength(0);
    expect(authLock.release).toHaveBeenCalledTimes(2);
  });
});

it.each([
  ['usage-auth', 'CLAUDE_USAGE_OAUTH'],
  ['secrets/CLAUDE_USAGE_OAUTH', 'CLAUDE_USAGE_OAUTH'],
  ['secrets/CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
])('busy auth delete %s returns a stable 409 without opening a transaction', async (path, name) => {
  const fake = setup(true);
  fake.insert(schema.cliProviderSecrets, {
    providerId: PROVIDER,
    secretName: name,
    encryptedValue: 'before',
    encryptedDek: 'before',
  });
  const before = fake.rows(schema.cliProviderSecrets);
  authLock.acquire.mockImplementation(async () => {
    expect(h.transactionOpen).toBe(false);
    return null;
  });
  const res = await app.request('/' + PROVIDER + '/' + path, { method: 'DELETE' });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    code: 'cli_auth_busy',
    error:
      'CLI authentication is busy. Finish the current sign-in or credential update and try again.',
  });
  expect(fake.rows(schema.cliProviderSecrets)).toEqual(before);
  expect(fake.rows(schema.auditEvents)).toHaveLength(0);
});

it('a non-auth secret delete stays unlocked even when authentication is busy', async () => {
  const fake = setup(true);
  fake.insert(schema.cliProviderSecrets, {
    providerId: PROVIDER,
    secretName: 'API_KEY',
    encryptedValue: 'before',
    encryptedDek: 'before',
  });
  authLock.acquire.mockResolvedValue(null);
  const res = await app.request('/' + PROVIDER + '/secrets/API_KEY', { method: 'DELETE' });
  expect(res.status).toBe(200);
  expect(authLock.acquire).not.toHaveBeenCalled();
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
});
