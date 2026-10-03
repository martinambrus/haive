import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  gdb: undefined as unknown,
  add: vi.fn(),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getGlobalKbSyncQueue: () => ({ add: h.add }),
  getTaskQueue: vi.fn(),
}));
vi.mock('../src/lib/task-start.js', () => ({
  enqueueStart: vi.fn(async () => {}),
  markQueuedForStart: async () => true,
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ db: h.gdb, settings: { namespace: 'default' } }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { GLOBAL_KB_DESCRIPTION_MAX, globalKbEntries } from '@haive/shared/global-kb';
import { enrichSchema, globalKbRoutes, updateSchema } from '../src/routes/global-kb.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ENTRY = '00000000-0000-4000-8000-0000000000b1';
const PROVIDER = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.route('/', globalKbRoutes);
app.onError(errorHandler);

const makeFake = () =>
  createFakeDb({ tasks: schema.tasks, cliProviders: schema.cliProviders, globalKbEntries });
let fake: ReturnType<typeof makeFake>;

const send = (method: string, url: string, body: unknown) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const stored = (id = ENTRY) => fake.rows(globalKbEntries).find((r) => r.id === id)!;

beforeEach(() => {
  h.add.mockReset();
  fake = makeFake();
  h.db = fake.db;
  h.gdb = fake.db;
  fake.insert(schema.cliProviders, { id: PROVIDER, userId: USER });
  fake.insert(globalKbEntries, {
    id: ENTRY,
    namespace: 'default',
    title: 'Never inline SVG',
    body: 'body',
    category: 'anti_pattern',
    facets: {},
    status: 'active',
    source: 'user',
    embedStatus: 'embedded',
    description: 'Before.',
  });
});

describe('the description in the request schemas', () => {
  it('lets an update set it or clear it, and refuses what is not text', () => {
    expect(updateSchema.safeParse({ description: 'Escape labels.' }).success).toBe(true);
    expect(updateSchema.safeParse({ description: null }).success).toBe(true);
    expect(updateSchema.safeParse({ description: 42 }).success).toBe(false);
  });

  it('lets an enrich request state one', () => {
    const base = {
      title: 'Never inline SVG',
      seedText: 'bloats the cache',
      cliProviderId: crypto.randomUUID(),
    };
    expect(enrichSchema.safeParse({ ...base, description: 'Never inline SVG.' }).success).toBe(
      true,
    );
    expect(enrichSchema.safeParse({ ...base, description: 42 }).success).toBe(false);
  });
});

describe('POST /entries and the description', () => {
  const entry = { title: 'Escape labels', body: 'body', category: 'best_practice' };

  it('stores what a person typed as one line', async () => {
    const res = await send('POST', '/entries', {
      ...entry,
      description: ' Escape\n every label. ',
    });

    expect(res.status).toBe(201);
    const { entry: created } = (await res.json()) as { entry: { id: string; description: string } };
    expect(created.description).toBe('Escape every label.');
    expect(stored(created.id).description).toBe('Escape every label.');
  });

  it('measures the cap after collapsing, so padding and line breaks do not count', async () => {
    const padded = `Escape${'\n'.repeat(400)}every label.`;
    const res = await send('POST', '/entries', { ...entry, description: padded });

    expect(res.status).toBe(201);
  });

  it('refuses text over the cap, and says what the cap is', async () => {
    const res = await send('POST', '/entries', {
      ...entry,
      description: 'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX + 1),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('description_too_long');
    expect(body.error).toContain(String(GLOBAL_KB_DESCRIPTION_MAX));
    expect(fake.rows(globalKbEntries)).toHaveLength(1);
  });

  it('stores nothing when there is none, or when it is blank', async () => {
    for (const description of [undefined, null, '', ' \n ']) {
      const res = await send('POST', '/entries', { ...entry, description });
      const { entry: created } = (await res.json()) as { entry: { id: string } };
      expect(stored(created.id).description).toBeNull();
    }
  });
});

describe('PATCH /entries/:id and the description', () => {
  it('saves a long edited markdown body intact and queues its re-embedding', async () => {
    const body = `## Corrected rule\n\n${'Keep **all** of this content.\n\n'.repeat(1000)}`;
    const res = await send('PATCH', `/entries/${ENTRY}`, { body });

    expect(res.status).toBe(200);
    expect(stored().body).toBe(body);
    expect(stored().description).toBe('Before.');
    expect(stored().status).toBe('active');
    expect(stored().embedStatus).toBe('pending');
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly the description cap without shortening it', async () => {
    const description = 'd'.repeat(GLOBAL_KB_DESCRIPTION_MAX);
    const res = await send('PATCH', `/entries/${ENTRY}`, { description });
    expect(res.status).toBe(200);
    expect(stored().description).toBe(description);
  });

  it('changes only the description, and neither marks the entry for re-embedding nor syncs it', async () => {
    const res = await send('PATCH', `/entries/${ENTRY}`, { description: ' Escape\nlabels. ' });

    expect(res.status).toBe(200);
    expect(stored().description).toBe('Escape labels.');
    expect(stored().embedStatus).toBe('embedded');
    expect(h.add).not.toHaveBeenCalled();
  });

  it('clears it with null, and with text that collapses to nothing', async () => {
    expect((await send('PATCH', `/entries/${ENTRY}`, { description: null })).status).toBe(200);
    expect(stored().description).toBeNull();

    fake.patch(globalKbEntries, ENTRY, { description: 'Before.' });
    expect((await send('PATCH', `/entries/${ENTRY}`, { description: ' \n ' })).status).toBe(200);
    expect(stored().description).toBeNull();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('refuses text over the cap, leaves the entry as it was, and syncs nothing', async () => {
    const res = await send('PATCH', `/entries/${ENTRY}`, {
      description: 'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX + 1),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      String(GLOBAL_KB_DESCRIPTION_MAX),
    );
    expect(stored().description).toBe('Before.');
    expect(h.add).not.toHaveBeenCalled();
  });

  it('still re-embeds and syncs when the description travels with a change to what is embedded', async () => {
    const res = await send('PATCH', `/entries/${ENTRY}`, {
      description: 'After.',
      title: 'Never inline any SVG',
    });

    expect(res.status).toBe(200);
    expect(stored().description).toBe('After.');
    expect(stored().embedStatus).toBe('pending');
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  it('does not sync a category edit either, since the category is not embedded', async () => {
    const res = await send('PATCH', `/entries/${ENTRY}`, { category: 'best_practice' });

    expect(res.status).toBe(200);
    expect(stored().description).toBe('Before.');
    expect(stored().embedStatus).toBe('embedded');
    expect(h.add).not.toHaveBeenCalled();
  });
});

describe('POST /enrich and the description', () => {
  const request = {
    title: 'Never inline SVG',
    seedText: 'bloats the cache',
    cliProviderId: PROVIDER,
  };
  const skeleton = () => fake.rows(globalKbEntries).find((r) => r.status === 'skeleton')!;
  const task = () => fake.rows(schema.tasks)[0]!;

  it('keeps capped author fields and long notes/scope/domain values intact', async () => {
    const title = 't'.repeat(300);
    const description = 'd'.repeat(GLOBAL_KB_DESCRIPTION_MAX);
    const seedText = 'Notes to enrich.\n'.repeat(1000);
    const tag = 't'.repeat(1000);
    const domain = 'd'.repeat(1000);
    const res = await send('POST', '/enrich', {
      ...request,
      title,
      description,
      seedText,
      facets: { tags: [tag] },
      egress: { mode: 'allowlist', domains: [domain] },
    });
    expect(res.status).toBe(201);
    expect(skeleton().title).toBe(title);
    expect(skeleton().description).toBe(description);
    expect(skeleton().seedText).toBe(seedText);
    expect(skeleton().facets).toEqual({ tags: [tag] });
    expect(task().description).toBe(seedText);
    expect((task().metadata as Record<string, unknown>).egress).toEqual({
      mode: 'allowlist',
      domains: [domain],
      ips: [],
    });
  });

  it.each([{ title: 't'.repeat(301) }, { namespace: 'n'.repeat(121) }])(
    'refuses over-limit author fields before creating anything: %j',
    async (fields) => {
      const res = await send('POST', '/enrich', { ...request, ...fields });
      expect(res.status).toBe(400);
      expect(fake.rows(schema.tasks)).toHaveLength(0);
      expect(fake.rows(globalKbEntries)).toHaveLength(1);
    },
  );

  it('keeps an author-stated description on the skeleton and in the task, beside the stated scope', async () => {
    const res = await send('POST', '/enrich', {
      ...request,
      description: ' Never inline\nSVG; reference a file. ',
    });

    expect(res.status).toBe(201);
    expect(skeleton().description).toBe('Never inline SVG; reference a file.');
    expect((task().metadata as Record<string, unknown>).authorDescription).toBe(
      'Never inline SVG; reference a file.',
    );
  });

  it('records no description when the author stated none', async () => {
    const res = await send('POST', '/enrich', request);

    expect(res.status).toBe(201);
    expect(skeleton().description).toBeNull();
    expect((task().metadata as Record<string, unknown>).authorDescription).toBeNull();
  });

  it('refuses text over the cap before creating anything', async () => {
    const res = await send('POST', '/enrich', {
      ...request,
      description: 'a'.repeat(GLOBAL_KB_DESCRIPTION_MAX + 1),
    });

    expect(res.status).toBe(400);
    expect(fake.rows(schema.tasks)).toHaveLength(0);
    expect(fake.rows(globalKbEntries).filter((r) => r.status === 'skeleton')).toHaveLength(0);
  });
});
