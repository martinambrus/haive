import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    c.set('userRole', 'admin');
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
import { configService, DEFAULT_AGENT_RULES } from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const MESSAGE = 'An ollama provider needs a model (set the model field).';

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

function setup(row?: { name: string; model: string | null }) {
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    cliProviders: schema.cliProviders,
    cliPackageVersions: schema.cliPackageVersions,
    cliProviderSecrets: schema.cliProviderSecrets,
  });
  if (row) {
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      label: 'p',
      enabled: true,
      rulesContent: DEFAULT_AGENT_RULES,
      ...row,
    });
  }
  h.db = fake.db;
  return fake;
}

function post(body: Record<string, unknown>) {
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'p', authMode: 'api_key', ...body }),
  });
}

function patch(body: Record<string, unknown>) {
  return app.request(`/${PROVIDER}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

describe('saving an ollama provider without a model', () => {
  it.each([[{}], [{ model: null }], [{ model: '   ' }]])(
    'refuses a create with model %j',
    async (extra) => {
      const fake = setup();
      const res = await post({ name: 'ollama', ...extra });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(MESSAGE);
      expect(fake.rows(schema.cliProviders)).toHaveLength(0);
    },
  );

  it.each([[null], ['   ']])('refuses an update that clears the model to %j', async (model) => {
    const fake = setup({ name: 'ollama', model: 'qwen3-coder:30b' });
    const res = await patch({ model });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(MESSAGE);
    expect(fake.rows(schema.cliProviders)[0]!.model).toBe('qwen3-coder:30b');
  });

  it('still saves an ollama provider that has a model', async () => {
    setup();
    const res = await post({ name: 'ollama', model: 'qwen3-coder:30b' });
    expect(res.status).toBe(201);
  });

  it('still updates an ollama provider to another model', async () => {
    const fake = setup({ name: 'ollama', model: 'qwen3-coder:30b' });
    const res = await patch({ model: 'qwen3-coder:480b-cloud' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.cliProviders)[0]!.model).toBe('qwen3-coder:480b-cloud');
  });

  it('still saves a provider of another CLI without a model', async () => {
    setup();
    const res = await post({ name: 'claude-code', authMode: 'subscription', isolateAuth: true });
    expect(res.status).toBe(201);
  });

  it('still lets a provider of another CLI clear its model', async () => {
    setup({ name: 'claude-code', model: 'claude-opus' });
    const res = await patch({ model: null });
    expect(res.status).toBe(200);
  });

  it('leaves an existing modelless ollama row editable when the update does not touch the model', async () => {
    setup({ name: 'ollama', model: null });
    const res = await patch({ enabled: false });
    expect(res.status).toBe(200);
  });
});

describe('cloning an ollama provider', () => {
  const clone = () => app.request(`/${PROVIDER}/clone`, { method: 'POST' });

  it('refuses to clone one without a model, and adds no row', async () => {
    const fake = setup({ name: 'ollama', model: null });
    const res = await clone();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(MESSAGE);
    expect(fake.rows(schema.cliProviders)).toHaveLength(1);
  });

  it('still clones one that has a model', async () => {
    const fake = setup({ name: 'ollama', model: 'qwen3-coder:30b' });
    const res = await clone();
    expect(res.status).toBe(201);
    const rows = fake.rows(schema.cliProviders);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.model)).toEqual(['qwen3-coder:30b', 'qwen3-coder:30b']);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('T550: provider enqueue compensation', () => {
  it('retries a failed model enqueue on an unchanged save', async () => {
    const fake = setup({ name: 'ollama', model: 'qwen3-coder:30b' });
    h.add.mockRejectedValueOnce(new Error('transport failed'));
    expect((await patch({ model: 'qwen3-coder:32b' })).status).toBe(500);
    expect(fake.rows(schema.cliProviders)[0]?.modelProvisionStatus).toBe('failed');
    expect((await patch({ model: 'qwen3-coder:32b' })).status).toBe(200);
    expect(h.add).toHaveBeenCalledTimes(2);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
      modelProvisionStatus: 'provisioning',
      modelProvisionError: null,
    });
  });

  it.each(['image', 'model'])(
    'keeps overlapping %s attempt B pending when A times out in the same millisecond',
    async (kind) => {
      vi.useFakeTimers();
      const fake = setup({ name: 'ollama', model: 'qwen3-coder:30b' });
      const entered = Promise.withResolvers<void>();
      h.add.mockImplementationOnce(() => {
        entered.resolve();
        return new Promise(() => {});
      });
      let attempt = 0;
      const run = () =>
        kind === 'image'
          ? app.request(`/${PROVIDER}/sandbox-image/build`, { method: 'POST' })
          : patch({ modelfile: `FROM qwen3-coder:30b\nPARAMETER num_ctx ${++attempt * 32}` });
      const attemptA = run();
      await entered.promise;
      const tokenKey = kind === 'image' ? 'sandboxImageEnqueueId' : 'modelProvisionEnqueueId';
      const stampA = fake.rows(schema.cliProviders)[0]?.[tokenKey];
      expect((await run()).status).toBe(kind === 'image' ? 202 : 200);
      expect(h.add).toHaveBeenCalledTimes(2);
      const stampB = fake.rows(schema.cliProviders)[0]?.[tokenKey];
      await vi.advanceTimersByTimeAsync(2000);
      expect((await attemptA).status).toBe(500);
      expect(fake.rows(schema.cliProviders)[0]).toMatchObject(
        kind === 'image'
          ? { sandboxImageBuildStatus: 'building', sandboxImageBuildError: null }
          : { modelProvisionStatus: 'provisioning', modelProvisionError: null },
      );
      expect(stampB).not.toEqual(stampA);
    },
  );

  it.each(['model save', 'metadata save'])(
    'still compensates the image attempt across an independent %s',
    async (operation) => {
      const fake = setup({ name: 'ollama', model: 'qwen3-coder:30b' });
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<undefined>();
      h.add.mockImplementationOnce(() => {
        entered.resolve();
        return held.promise;
      });
      const attemptA = app.request(`/${PROVIDER}/sandbox-image/build`, { method: 'POST' });
      await entered.promise;
      expect(
        (
          await patch(
            operation === 'model save' ? { model: 'qwen3-coder:32b' } : { label: 'renamed' },
          )
        ).status,
      ).toBe(200);
      held.reject(new Error('known rejection'));
      expect((await attemptA).status).toBe(500);
      expect(fake.rows(schema.cliProviders)[0]?.sandboxImageBuildStatus).toBe('failed');
      if (operation === 'model save')
        expect(fake.rows(schema.cliProviders)[0]?.modelProvisionStatus).toBe('provisioning');
    },
  );

  it.each(['create', 'clone', 'update', 'force-build'])(
    'bounds a hung %s and releases every pending status',
    async (site) => {
      vi.useFakeTimers();
      const fake = setup(
        site === 'create' ? undefined : { name: 'ollama', model: 'qwen3-coder:30b' },
      );
      h.add.mockImplementation(() => new Promise(() => {}));
      const run =
        site === 'create'
          ? post({ name: 'ollama', model: 'qwen3-coder:30b' })
          : site === 'clone'
            ? app.request(`/${PROVIDER}/clone`, { method: 'POST' })
            : site === 'update'
              ? patch({ model: 'qwen3-coder:32b' })
              : app.request(`/${PROVIDER}/sandbox-image/build`, { method: 'POST' });
      let response: Response | undefined;
      const pending = Promise.resolve(run).then((r) => {
        response = r;
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(response?.status).toBe(500);
      await pending;
      const rows = fake.rows(schema.cliProviders);
      expect(
        rows.some(
          (row) =>
            row.sandboxImageBuildStatus === 'building' ||
            row.modelProvisionStatus === 'provisioning',
        ),
      ).toBe(false);
      const saved = site === 'clone' ? rows.find((row) => row.id !== PROVIDER)! : rows[0]!;
      if (site !== 'force-build') expect(saved.modelProvisionStatus).toBe('failed');
      if (site !== 'update') expect(saved.sandboxImageBuildStatus).toBe('failed');
      expect(h.add).toHaveBeenCalledTimes(site === 'create' || site === 'clone' ? 2 : 1);
    },
  );
  it('attempts model provisioning even when the image add rejects immediately', async () => {
    const fake = setup();
    h.add.mockRejectedValue(new Error('transport failed'));
    expect((await post({ name: 'ollama', model: 'qwen3-coder:30b' })).status).toBe(500);
    expect(h.add).toHaveBeenCalledTimes(2);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
      sandboxImageBuildStatus: 'failed',
      modelProvisionStatus: 'failed',
    });
  });
  it('keeps a worker result that lands before a lost acknowledgement', async () => {
    const fake = setup();
    h.add.mockImplementation(async () => {
      for (const row of fake.rows(schema.cliProviders))
        fake.patch(schema.cliProviders, String(row.id), {
          sandboxImageBuildStatus: 'ready',
          modelProvisionStatus: 'ready',
        });
      throw new Error('acknowledgement lost');
    });
    expect((await post({ name: 'ollama', model: 'qwen3-coder:30b' })).status).toBe(500);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
      sandboxImageBuildStatus: 'ready',
      modelProvisionStatus: 'ready',
    });
  });
});
