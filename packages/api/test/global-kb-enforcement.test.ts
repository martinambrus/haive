import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  gdb: undefined as unknown,
  add: vi.fn(),
  role: 'admin',
  houseRules: true,
  successors: [] as unknown[],
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
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ADMIN);
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => h.houseRules },
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ db: h.gdb, settings: { namespace: 'default' } }),
}));

import { Hono } from 'hono';
import { SQL, StringChunk, is } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  HOUSE_RULES_ALWAYS_CAP_BYTES,
  enforcementState,
  globalKbEntries,
  houseRuleApprovalHash,
  houseRuleBytes,
  houseRuleContentToken,
  houseRuleShortIds,
  renderHouseRuleEntry,
  type EnforceSpec,
  type GlobalKbEntry,
} from '@haive/shared/global-kb';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ENTRY = '00000000-0000-4000-8000-0000000000b1';
const SECOND = '00000000-0000-4000-8000-0000000000b2';
const PREDECESSOR = '00000000-0000-4000-8000-0000000000b3';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const PROVIDER = '00000000-0000-4000-8000-0000000000c1';
const T0 = new Date(Date.UTC(2026, 9, 3, 12, 0, 0));
const TITLE = 'Never inline SVG';
const DESCRIPTION = 'Reference a file instead of inlining SVG.';
const BODY = '# Never inline SVG\n\nReference a file instead.';
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const E_ACUTE = String.fromCodePoint(0xe9);
const BACKSLASH = String.fromCharCode(92);
const FILES: EnforceSpec = { mode: 'files', globs: ['**/*.twig', 'src/**/*.php'] };
const ALWAYS: EnforceSpec = { mode: 'always' };
const HEAVY = E_ACUTE.repeat(Math.ceil(HOUSE_RULES_ALWAYS_CAP_BYTES * 0.3));

const app = new Hono<AppEnv>();
app.route('/', globalKbRoutes);
app.onError(errorHandler);

const makeFake = () =>
  createFakeDb({ tasks: schema.tasks, cliProviders: schema.cliProviders, globalKbEntries });
let fake: ReturnType<typeof makeFake>;
let vectorStatements: string[];
let rawStatements: string[];

const statementText = (query: unknown): string =>
  is(query, SQL)
    ? query.queryChunks
        .map((chunk) => (is(chunk, StringChunk) ? chunk.value.join('') : '?'))
        .join('')
    : '';

// The fake runs only the corpus lock; any other raw statement, the vector table's, is recorded.
function lenient<T extends { execute: (query: unknown) => Promise<unknown> }>(handle: T): T {
  return {
    ...handle,
    execute: async (query: unknown) => {
      rawStatements.push(statementText(query));
      try {
        return await handle.execute(query);
      } catch (err) {
        if (!String(err).includes('unsupported execute')) throw err;
        vectorStatements.push(statementText(query));
        return h.successors;
      }
    },
  } as T;
}

type Json = Record<string, any>;
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const asJson = async (res: Response): Promise<Json> => (await res.json()) as Json;

const stored = (id = ENTRY) => fake.rows(globalKbEntries).find((r) => r.id === id)!;
const asEntry = (id = ENTRY) => stored(id) as unknown as GlobalKbEntry;
const tokenOf = (id = ENTRY) => houseRuleContentToken(asEntry(id));
// A rule counts as a prompt prints it, with a short id that is longer when `among` shares a prefix.
const alwaysBytes = (id: string, among: string[]): number =>
  houseRuleBytes(asEntry(id), { enforce: ALWAYS, shortId: houseRuleShortIds(among).get(id)! });
const approve = (id: string, spec: EnforceSpec) =>
  fake.patch(globalKbEntries, id, {
    enforce: spec,
    enforcedHash: houseRuleApprovalHash(asEntry(id), spec),
    enforcedAt: T0,
    enforcedBy: ADMIN,
  });
const enforce = (body: Record<string, unknown>, id = ENTRY) =>
  send('PUT', `/entries/${id}/enforcement`, { expectedHash: tokenOf(id), ...body });
const enforcementOf = (id: string): string =>
  enforcementState(asEntry(id) as never, { namespace: 'default', houseRulesEnabled: true }).state;
const unenforce = (id = ENTRY) => send('DELETE', `/entries/${id}/enforcement`);
const patch = (body: Record<string, unknown>, id = ENTRY) => send('PATCH', `/entries/${id}`, body);
const addEntry = (id: string, over: Record<string, unknown> = {}) =>
  fake.insert(globalKbEntries, {
    id,
    namespace: 'default',
    userId: ADMIN,
    title: `Rule ${id.slice(-2)}`,
    body: BODY,
    category: 'best_practice',
    facets: { framework: ['drupal'] },
    status: 'active',
    source: 'user',
    embedStatus: 'embedded',
    description: DESCRIPTION,
    updatedAt: T0,
    ...over,
  });

beforeEach(() => {
  h.add.mockReset();
  h.role = 'admin';
  h.houseRules = true;
  h.successors = [];
  vectorStatements = [];
  rawStatements = [];
  fake = makeFake();
  h.db = fake.db;
  h.gdb = {
    ...lenient(fake.db),
    transaction: (fn: (tx: never) => Promise<unknown>) =>
      fake.db.transaction((tx) => fn(lenient(tx) as never)),
  };
  fake.insert(schema.cliProviders, { id: PROVIDER, userId: ADMIN });
  addEntry(ENTRY, { title: TITLE, category: 'anti_pattern' });
});

describe('the enforcement routes are for admins', () => {
  beforeEach(() => {
    h.role = 'user';
  });

  it('refuse a regular user on PUT and change nothing', async () => {
    const res = await enforce(ALWAYS);

    expect(res.status).toBe(403);
    expect(stored().enforce).toBeNull();
    expect(stored().enforcedHash).toBeNull();
  });

  it('refuse a regular user on DELETE and leave the approval in force', async () => {
    approve(ENTRY, FILES);
    const before = stored().enforcedHash;

    const res = await unenforce();

    expect(res.status).toBe(403);
    expect(stored().enforcedHash).toBe(before);
  });

  it('leave every other global KB route to a regular user', async () => {
    expect((await patch({ description: 'Edited.' })).status).toBe(200);
  });
});

describe('PUT /entries/:id/enforcement', () => {
  it('stores what the admin approved, bound to the stored text, with who and when', async () => {
    const res = await enforce(FILES);

    expect(res.status).toBe(200);
    expect(stored().enforce).toEqual(FILES);
    expect(stored().enforcedHash).toBe(houseRuleApprovalHash(asEntry(), FILES));
    expect(stored().enforcedAt).toBeInstanceOf(Date);
    expect(stored().enforcedBy).toBe(ADMIN);
    const { entry } = await asJson(res);
    expect(entry.contentToken).toBe(tokenOf());
    expect(entry.enforcementState).toEqual({
      state: 'enforced',
      mode: 'files',
      globs: FILES.globs,
    });
  });

  it('replaces the previous settings when the mode changes', async () => {
    expect((await enforce(FILES)).status).toBe(200);

    const res = await enforce(ALWAYS);

    expect(res.status).toBe(200);
    expect(stored().enforce).toEqual(ALWAYS);
    expect((await asJson(res)).entry.enforcementState).toEqual({
      state: 'enforced',
      mode: 'always',
    });
  });

  it('accepts a title and a description that are not one line, which the prompt carries as one', async () => {
    const title = ' Never\tinline  SVG\n';
    expect((await patch({ title })).status).toBe(200);
    fake.patch(globalKbEntries, ENTRY, {
      description: 'Reference a file\ninstead  of inlining SVG. ',
    });

    const res = await enforce(FILES);

    expect(res.status).toBe(200);
    expect(enforcementOf(ENTRY)).toBe('enforced');
    expect(stored().title).toBe(title);
    const shortId = houseRuleShortIds([ENTRY]).get(ENTRY)!;
    expect(renderHouseRuleEntry(asEntry(), { enforce: FILES, shortId })).toBe(
      `### Rule ${shortId}: Never inline SVG\nCategory: Anti-pattern\nReference a file instead of inlining SVG.\nApplies to files matching: **/*.twig, src/**/*.php\n\n${BODY}`,
    );
  });

  it('changes nothing the embedding reads, and queues no sync', async () => {
    expect((await enforce(FILES)).status).toBe(200);
    expect((await unenforce()).status).toBe(200);

    expect(stored().updatedAt).toEqual(T0);
    expect(stored().embedStatus).toBe('embedded');
    expect(h.add).not.toHaveBeenCalled();
    expect(vectorStatements).toEqual([]);
  });

  describe('refuses with 409', () => {
    it('an entry that is not active', async () => {
      for (const status of ['draft', 'archived']) {
        fake.patch(globalKbEntries, ENTRY, { status });

        const res = await enforce(FILES);

        expect(res.status).toBe(409);
        expect((await asJson(res)).code).toBe('not_active');
        expect(stored().enforcedHash).toBeNull();
      }
    });

    it('an entry of another namespace', async () => {
      fake.patch(globalKbEntries, ENTRY, { namespace: 'elsewhere' });

      const res = await enforce(FILES);

      expect(res.status).toBe(409);
      expect((await asJson(res)).code).toBe('other_namespace');
      expect(stored().enforcedHash).toBeNull();
    });

    it('a token that is not the one of the stored text', async () => {
      const res = await enforce({ ...FILES, expectedHash: `hr1:${'0'.repeat(64)}` });

      expect(res.status).toBe(409);
      expect((await asJson(res)).code).toBe('token_mismatch');
      expect(stored().enforcedHash).toBeNull();
    });

    it('a token read before an edit', async () => {
      const seen = tokenOf();
      fake.patch(globalKbEntries, ENTRY, { body: `${BODY}\n\nOne more line.` });

      const res = await enforce({ ...FILES, expectedHash: seen });

      expect(res.status).toBe(409);
      expect((await asJson(res)).code).toBe('token_mismatch');
      expect(stored().enforcedHash).toBeNull();
    });
  });

  describe('the always-on cap', () => {
    beforeEach(() => {
      addEntry(SECOND, { body: HEAVY });
      fake.patch(globalKbEntries, ENTRY, { body: HEAVY });
    });

    it('counts UTF-8 bytes, and the 409 carries the numbers', async () => {
      expect(HEAVY.length * 2).toBeLessThan(HOUSE_RULES_ALWAYS_CAP_BYTES);
      expect((await enforce(ALWAYS, ENTRY)).status).toBe(200);

      const res = await enforce(ALWAYS, SECOND);

      expect(res.status).toBe(409);
      const body = await asJson(res);
      expect(body.code).toBe('always_cap');
      expect(body.usedBytes).toBe(alwaysBytes(ENTRY, [ENTRY, SECOND]));
      expect(body.entryBytes).toBe(alwaysBytes(SECOND, [ENTRY, SECOND]));
      expect(body.capBytes).toBe(HOUSE_RULES_ALWAYS_CAP_BYTES);
      expect(body.usedBytes + body.entryBytes).toBeGreaterThan(body.capBytes);
      expect(stored(SECOND).enforcedHash).toBeNull();
    });

    it('counts a short id of 8 digits unless an enforced rule shares them', async () => {
      const OTHER = 'f0000000-0000-4000-8000-0000000000b9';
      addEntry(OTHER, { body: HEAVY });
      expect((await enforce(ALWAYS, ENTRY)).status).toBe(200);

      const body = await asJson(await enforce(ALWAYS, OTHER));

      // SECOND shares ENTRY's prefix but is not enforced, so no prompt prints it beside ENTRY.
      expect(body.code).toBe('always_cap');
      expect(body.usedBytes).toBe(alwaysBytes(ENTRY, [ENTRY, OTHER]));
      expect(body.usedBytes).toBeLessThan(alwaysBytes(ENTRY, [ENTRY, SECOND]));
      expect(body.entryBytes).toBe(alwaysBytes(OTHER, [OTHER]));
    });

    it('refuses one entry that is over the cap alone', async () => {
      fake.patch(globalKbEntries, SECOND, { body: E_ACUTE.repeat(HOUSE_RULES_ALWAYS_CAP_BYTES) });

      const res = await enforce(ALWAYS, SECOND);

      expect(res.status).toBe(409);
      expect((await asJson(res)).usedBytes).toBe(0);
    });

    it('does not count the entry being enforced again', async () => {
      expect((await enforce(ALWAYS, ENTRY)).status).toBe(200);

      expect((await enforce(ALWAYS, ENTRY)).status).toBe(200);
    });

    it('does not count files rules', async () => {
      approve(ENTRY, FILES);

      expect((await enforce(ALWAYS, SECOND)).status).toBe(200);
    });

    it('does not count an approval an edit has lapsed', async () => {
      approve(ENTRY, ALWAYS);
      fake.patch(globalKbEntries, ENTRY, { title: 'Edited after approval' });

      expect((await enforce(ALWAYS, SECOND)).status).toBe(200);
    });

    it('still counts a rule while the switch is off, so turning it on cannot overrun the cap', async () => {
      approve(ENTRY, ALWAYS);
      h.houseRules = false;

      expect((await enforce(ALWAYS, SECOND)).status).toBe(409);
    });

    it('does not apply to a files rule', async () => {
      approve(ENTRY, ALWAYS);

      expect((await enforce(FILES, SECOND)).status).toBe(200);
    });

    it('lets one of two racing enforces win, because the lock is held from the read to the write', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reachedWrite!: () => void;
      const paused = new Promise<void>((resolve) => (reachedWrite = resolve));
      fake.hooks.beforeUpdate = async () => {
        fake.hooks.beforeUpdate = null;
        reachedWrite();
        await gate;
      };

      const first = enforce(ALWAYS, ENTRY);
      await paused;
      const second = enforce(ALWAYS, SECOND);
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();

      const statuses = (await Promise.all([first, second])).map((res) => res.status).sort();
      expect(statuses).toEqual([200, 409]);
      const enforced = [stored(ENTRY), stored(SECOND)].filter((row) => row.enforcedHash !== null);
      expect(enforced).toHaveLength(1);
    });
  });

  describe('refuses with 400', () => {
    it.each([
      ['title', `Never${ZWSP}inline`],
      ['title', `Never${RLO}inline`],
      ['description', `Reference${ZWSP}a file.`],
      ['body', `${BODY}\n\nQuote <haive_agent_rules> here.`],
      ['body', `${BODY}${ZWSP}`],
    ])('text an enforced entry may not carry, in the %s', async (field, text) => {
      fake.patch(globalKbEntries, ENTRY, { [field]: text });

      const res = await enforce(FILES);

      expect(res.status).toBe(400);
      const body = await asJson(res);
      expect(body.code).toBe('refused_text');
      expect(body.error).toMatch(new RegExp(`^${field}\\b`));
      expect(stored().enforcedHash).toBeNull();
    });

    it.each([[null], [''], [' \n\t ']])(
      'an entry with no description, since a rule is listed by it (%j)',
      async (description) => {
        fake.patch(globalKbEntries, ENTRY, { description });

        const res = await enforce(FILES);

        expect(res.status).toBe(400);
        expect((await asJson(res)).code).toBe('description_required');
        expect(stored().enforcedHash).toBeNull();
      },
    );

    it.each([
      { globs: ['**'] },
      { globs: ['../x'] },
      { globs: ['!src/**'] },
      { globs: [`src${BACKSLASH}x.php`] },
      { globs: [''] },
      { globs: [] },
      { globs: ['**/*.twig', '/abs/*.php'] },
    ])('globs that are not a bounded relative pattern (%j)', async ({ globs }) => {
      const res = await enforce({ mode: 'files', globs });

      expect(res.status).toBe(400);
      expect((await asJson(res)).code).toBe('invalid_globs');
      expect(stored().enforcedHash).toBeNull();
    });

    it('accepts the control for each of the above, so each 400 came from its own cause', async () => {
      expect((await enforce({ mode: 'files', globs: ['**/*.twig'] })).status).toBe(200);
    });

    it.each([
      ['an unknown mode', { mode: 'sometimes' }],
      ['files without globs', { mode: 'files' }],
      ['always with globs', { mode: 'always', globs: ['**/*.twig'] }],
      ['a key it does not take', { mode: 'always', enforcedHash: 'hr1:forged' }],
      ['no mode', {}],
    ])('a request that is not a mode, its globs and the token: %s', async (_name, body) => {
      const res = await enforce(body);

      expect(res.status).toBe(400);
      expect((await asJson(res)).code).toBe('invalid_body');
      expect(stored().enforcedHash).toBeNull();
    });

    it('a request with no token, or none at all', async () => {
      for (const body of [{ mode: 'always' }, null]) {
        expect((await send('PUT', `/entries/${ENTRY}/enforcement`, body)).status).toBe(400);
      }
    });
  });

  it('answers 404 for an entry that does not exist', async () => {
    const res = await send('PUT', `/entries/${MISSING}/enforcement`, {
      ...ALWAYS,
      expectedHash: tokenOf(),
    });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /entries/:id/enforcement', () => {
  it('removes the approval and keeps the last settings, who and when', async () => {
    approve(ENTRY, FILES);

    const res = await unenforce();

    expect(res.status).toBe(200);
    expect(stored().enforcedHash).toBeNull();
    expect(stored().enforce).toEqual(FILES);
    expect(stored().enforcedAt).toEqual(T0);
    expect(stored().enforcedBy).toBe(ADMIN);
    expect(stored().updatedAt).toEqual(T0);
    expect((await asJson(res)).entry.enforcementState).toEqual({ state: 'cleared' });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('answers 200 again for an approval that has already lapsed', async () => {
    approve(ENTRY, FILES);
    fake.patch(globalKbEntries, ENTRY, { status: 'archived', enforcedHash: null });

    expect((await unenforce()).status).toBe(200);
  });

  it('reads an entry of another namespace as cleared, not paused, once its approval is gone', async () => {
    approve(ENTRY, FILES);
    fake.patch(globalKbEntries, ENTRY, { namespace: 'elsewhere' });

    const res = await unenforce();

    expect(res.status).toBe(200);
    expect(stored().enforcedHash).toBeNull();
    expect((await asJson(res)).entry.enforcementState).toEqual({ state: 'cleared' });
  });

  it('answers 404 for an entry that was never enforced, and for one that does not exist', async () => {
    const never = await unenforce();
    expect(never.status).toBe(404);
    expect((await asJson(never)).code).toBe('not_enforced');

    expect((await unenforce(MISSING)).status).toBe(404);
  });
});

describe('every entry a route returns carries its token and enforcement state', () => {
  const read = async (id = ENTRY) => asJson(await send('GET', `/entries/${id}`));

  it('on GET /entries/:id, one state for each situation', async () => {
    const none = await read();
    expect(none.entry.contentToken).toBe(tokenOf());
    expect(none.entry.enforcementState).toEqual({ state: 'none' });

    approve(ENTRY, FILES);
    expect((await read()).entry.enforcementState).toEqual({
      state: 'enforced',
      mode: 'files',
      globs: FILES.globs,
    });

    h.houseRules = false;
    expect((await read()).entry.enforcementState).toEqual({ state: 'switched_off' });
    h.houseRules = true;

    fake.patch(globalKbEntries, ENTRY, { enforcedHash: null });
    expect((await read()).entry.enforcementState).toEqual({ state: 'cleared' });

    approve(ENTRY, FILES);
    fake.patch(globalKbEntries, ENTRY, { body: `${BODY}\n\nEdited.` });
    const edited = await read();
    expect(edited.entry.enforcementState).toEqual({ state: 'edited' });
    expect(edited.entry.contentToken).toBe(tokenOf());

    fake.patch(globalKbEntries, ENTRY, { namespace: 'elsewhere' });
    expect((await read()).entry.enforcementState).toEqual({ state: 'edited' });

    approve(ENTRY, FILES);
    expect((await read()).entry.enforcementState).toEqual({ state: 'other_namespace' });

    fake.patch(globalKbEntries, ENTRY, {
      namespace: 'default',
      status: 'archived',
      supersededAt: T0,
      enforcedHash: null,
    });
    expect((await read()).entry.enforcementState).toEqual({ state: 'superseded' });
  });

  it('on GET /entries/:id, with the always-on meter and the successor it already had', async () => {
    addEntry(SECOND, { body: HEAVY });
    approve(SECOND, ALWAYS);

    const body = await read();

    expect(body.usedBytes).toBe(alwaysBytes(SECOND, [ENTRY, SECOND]));
    expect(body.capBytes).toBe(HOUSE_RULES_ALWAYS_CAP_BYTES);
    expect(body.entryBytes).toBe(alwaysBytes(ENTRY, [ENTRY, SECOND]));
    expect(body.activeSuccessor).toBeNull();

    fake.patch(globalKbEntries, ENTRY, { status: 'archived' });
    h.successors = [{ id: SECOND, title: 'Rule' }];
    expect((await read()).activeSuccessor).toEqual({ id: SECOND, title: 'Rule' });
  });

  it('on GET /entries/:id, counting an anti-pattern by its title alone, as the heading carries no category text', async () => {
    const { entryBytes } = await read();

    expect(entryBytes).toBe(Buffer.byteLength(`### ${TITLE}\n${DESCRIPTION}\n\n${BODY}`, 'utf8'));
  });

  it('on POST /entries and POST /enrich, where nothing is enforced yet', async () => {
    const created = await send('POST', '/entries', {
      title: 'Escape labels',
      body: 'body',
      category: 'best_practice',
    });
    expect(created.status).toBe(201);
    const { entry } = await asJson(created);
    expect(entry.contentToken).toMatch(/^hr1:[0-9a-f]{64}$/);
    expect(entry.enforcementState).toEqual({ state: 'none' });

    const enriched = await send('POST', '/enrich', {
      title: TITLE,
      seedText: 'bloats the cache',
      cliProviderId: PROVIDER,
    });
    expect(enriched.status).toBe(201);
    const skeleton = (await asJson(enriched)).entry;
    expect(skeleton.contentToken).toMatch(/^hr1:[0-9a-f]{64}$/);
    expect(skeleton.enforcementState).toEqual({ state: 'none' });
  });

  it('on PATCH, where an edit has already lapsed the approval', async () => {
    approve(ENTRY, FILES);
    const before = tokenOf();

    const res = await patch({ body: `${BODY}\n\nEdited.` });

    expect(res.status).toBe(200);
    const { entry } = await asJson(res);
    expect(entry.enforcementState).toEqual({ state: 'cleared' });
    expect(entry.contentToken).toBe(tokenOf());
    expect(entry.contentToken).not.toBe(before);
    expect(stored().enforcedHash).toBeNull();
  });
});

describe('an edit ends the approval for good', () => {
  beforeEach(() => approve(ENTRY, FILES));

  it.each([
    ['body', { body: `${BODY}\n\nEdited.` }],
    ['title', { title: 'Never inline any SVG' }],
    ['description', { description: 'Reference a file, never inline SVG.' }],
    ['category', { category: 'best_practice' }],
    ['scope', { facets: { framework: ['drupal'], language: ['php'] } }],
  ])('on a changed %s, keeping the last settings and who approved', async (_field, change) => {
    expect((await patch(change)).status).toBe(200);

    expect(stored().enforcedHash).toBeNull();
    expect(stored().enforce).toEqual(FILES);
    expect(stored().enforcedBy).toBe(ADMIN);
    expect(stored().enforcedAt).toEqual(T0);
  });

  it('so a revert to the approved text stays not enforced', async () => {
    expect((await patch({ title: 'Edited' })).status).toBe(200);

    const res = await patch({ title: TITLE });

    expect((await asJson(res)).entry.enforcementState).toEqual({ state: 'cleared' });
    expect(stored().enforcedHash).toBeNull();
  });

  it('but not on a patch that writes the values it already has', async () => {
    const hash = stored().enforcedHash;

    const res = await patch({
      title: TITLE,
      body: BODY,
      description: DESCRIPTION,
      category: 'anti_pattern',
      facets: { framework: ['drupal'] },
    });

    expect(res.status).toBe(200);
    expect(stored().enforcedHash).toBe(hash);
    expect((await asJson(res)).entry.enforcementState.state).toBe('enforced');
  });

  it('but not on a status change, which is not content', async () => {
    const hash = stored().enforcedHash;

    expect((await patch({ status: 'archived' })).status).toBe(200);

    expect(stored().enforcedHash).toBe(hash);
  });

  it('and cannot be used to get past the always-on cap by reverting', async () => {
    addEntry(SECOND, { body: HEAVY });
    fake.patch(globalKbEntries, ENTRY, { body: HEAVY });
    expect((await enforce(ALWAYS, ENTRY)).status).toBe(200);
    expect((await patch({ title: 'Lapsed by an edit' })).status).toBe(200);
    expect((await enforce(ALWAYS, SECOND)).status).toBe(200);

    expect((await patch({ title: TITLE })).status).toBe(200);

    const states = [ENTRY, SECOND].map((id) => enforcementOf(id));
    expect(states).toEqual(['cleared', 'enforced']);
    expect((await enforce(ALWAYS, ENTRY)).status).toBe(409);
  });
});

describe('PATCH and what it re-embeds', () => {
  it('leaves a category-only edit alone', async () => {
    const res = await patch({ category: 'best_practice' });

    expect(res.status).toBe(200);
    expect(stored().category).toBe('best_practice');
    expect(stored().embedStatus).toBe('embedded');
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each([
    ['title', { title: 'Never inline any SVG' }],
    ['body', { body: `${BODY}\n\nMore.` }],
  ])('re-embeds a changed %s, once', async (_field, change) => {
    expect((await patch(change)).status).toBe(200);

    expect(stored().embedStatus).toBe('pending');
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add.mock.calls[0]![1]).toMatchObject({ entryId: ENTRY, reason: 'upsert' });
  });

  it('does not re-embed a title or body sent back unchanged', async () => {
    const res = await patch({ title: TITLE, body: BODY });

    expect(res.status).toBe(200);
    expect(stored().embedStatus).toBe('embedded');
    expect(h.add).not.toHaveBeenCalled();
  });

  it('does not re-embed a scope edit, which already corrects the chunks in its own transaction', async () => {
    const res = await patch({ facets: { framework: ['drupal'], language: ['php'] } });

    expect(res.status).toBe(200);
    expect(vectorStatements.some((sql) => sql.includes('UPDATE ai_rag_embeddings'))).toBe(true);
    expect(stored().embedStatus).toBe('embedded');
    expect(h.add).not.toHaveBeenCalled();
  });

  it('re-embeds an entry that becomes active, and only then', async () => {
    fake.patch(globalKbEntries, ENTRY, { status: 'draft' });

    expect((await patch({ status: 'active' })).status).toBe(200);
    expect(stored().embedStatus).toBe('pending');
    expect(h.add).toHaveBeenCalledTimes(1);

    h.add.mockReset();
    fake.patch(globalKbEntries, ENTRY, { embedStatus: 'embedded' });
    expect((await patch({ status: 'active' })).status).toBe(200);
    expect(stored().embedStatus).toBe('embedded');
    expect(h.add).not.toHaveBeenCalled();
  });

  it('queues nothing for an archive, whose vectors go in the same transaction', async () => {
    const res = await patch({ status: 'archived' });

    expect(res.status).toBe(200);
    expect(vectorStatements.some((sql) => sql.includes('DELETE FROM ai_rag_embeddings'))).toBe(
      true,
    );
    expect(h.add).not.toHaveBeenCalled();
  });

  it('archives the entry a draft replaces when the draft becomes active', async () => {
    addEntry(PREDECESSOR, { title: 'Old rule' });
    fake.patch(globalKbEntries, ENTRY, { status: 'draft', supersedesEntryId: PREDECESSOR });

    expect((await patch({ status: 'active' })).status).toBe(200);

    expect(stored(PREDECESSOR).status).toBe('archived');
    expect(stored(PREDECESSOR).supersededAt).toBeInstanceOf(Date);
    expect(h.add.mock.calls.map(([, payload]) => [payload.entryId, payload.reason])).toEqual([
      [ENTRY, 'upsert'],
      [PREDECESSOR, 'delete'],
    ]);
  });

  it('does not archive the entry again when an active entry is activated once more', async () => {
    addEntry(PREDECESSOR, { title: 'Reactivated rule' });
    fake.patch(globalKbEntries, ENTRY, { supersedesEntryId: PREDECESSOR });

    expect((await patch({ status: 'active' })).status).toBe(200);

    expect(stored(PREDECESSOR).status).toBe('active');
    expect(stored(PREDECESSOR).supersededAt).toBeNull();
    expect(h.add).not.toHaveBeenCalled();
    expect(vectorStatements).toEqual([]);
  });
});

describe('the writers of one corpus take its lock before they write', () => {
  const eventsOf = async (run: () => Response | Promise<Response>): Promise<string[]> => {
    const events: string[] = [];
    fake.hooks.beforeLock = (key) => void events.push(`lock ${key}`);
    fake.hooks.beforeUpdate = () => void events.push('update');
    fake.hooks.beforeDelete = () => void events.push('delete');
    expect((await run()).status).toBe(200);
    return events;
  };

  it('on PATCH', async () => {
    expect(await eventsOf(() => patch({ title: 'Never inline any SVG' }))).toEqual([
      'lock gkb-entries:default',
      'update',
    ]);
  });

  it('on DELETE of an entry', async () => {
    expect(await eventsOf(() => send('DELETE', `/entries/${ENTRY}`))).toEqual([
      'lock gkb-entries:default',
      'delete',
    ]);
    expect(fake.rows(globalKbEntries).some((row) => row.id === ENTRY)).toBe(false);
  });

  it('on enforcing, and on removing an enforcement', async () => {
    expect(await eventsOf(() => enforce(FILES))).toEqual(['lock gkb-entries:default', 'update']);
    expect(await eventsOf(() => unenforce())).toEqual(['lock gkb-entries:default', 'update']);
  });

  it('keyed on the entry namespace, so installs sharing a store serialize per corpus', async () => {
    fake.patch(globalKbEntries, ENTRY, { namespace: 'elsewhere' });

    const events = await eventsOf(() => patch({ title: 'Never inline any SVG' }));

    expect(events[0]).toBe('lock gkb-entries:elsewhere');
  });

  it('and answer 404 for a missing entry without locking anything', async () => {
    const events: string[] = [];
    fake.hooks.beforeLock = (key) => void events.push(key);

    expect((await patch({ title: 'x' }, MISSING)).status).toBe(404);
    expect((await send('DELETE', `/entries/${MISSING}`)).status).toBe(404);
    expect(events).toEqual([]);
  });
});

const lockingRoutes: [string, () => Response | Promise<Response>][] = [
  ['PATCH', () => patch({ title: 'Never inline any SVG' })],
  ['DELETE of an entry', () => send('DELETE', `/entries/${ENTRY}`)],
  ['PUT enforcement', () => enforce(FILES)],
  ['DELETE enforcement', () => unenforce()],
];

describe('the writers of one corpus bound their wait for its lock, then take it', () => {
  it.each(lockingRoutes)('on %s, in the same transaction', async (_route, run) => {
    approve(ENTRY, FILES);

    expect((await run()).status).toBe(200);

    const lockStatements = rawStatements.filter((text) =>
      /lock_timeout|pg_advisory_xact_lock/.test(text),
    );
    expect(lockStatements).toEqual([
      "SET LOCAL lock_timeout = '30000ms'",
      'select pg_advisory_xact_lock(hashtextextended(?, 0))',
    ]);
    expect(vectorStatements.some((text) => text.includes('lock_timeout'))).toBe(false);
  });
});

describe('a wait for the corpus lock that runs out', () => {
  const timedOut = () =>
    new Error('Failed query: select pg_advisory_xact_lock(hashtextextended($1, 0))', {
      cause: Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      }),
    });

  it.each(lockingRoutes)('answers 503 on %s, and changes nothing', async (_route, run) => {
    approve(ENTRY, FILES);
    const before = stored();
    fake.hooks.beforeLock = () => {
      throw timedOut();
    };

    const res = await run();

    expect(res.status).toBe(503);
    expect((await asJson(res)).error).toBe(
      'Another change to this knowledge base is in progress; try again',
    );
    expect(stored()).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each(lockingRoutes)(
    'stays a 500 on %s when the lock fails for another reason',
    async (_route, run) => {
      fake.hooks.beforeLock = () => {
        throw new Error('terminating connection due to administrator command');
      };

      expect((await run()).status).toBe(500);
    },
  );
});

describe('an id that is not a uuid names no entry', () => {
  const BAD = 'not-a-uuid';
  const requests: [string, () => Response | Promise<Response>][] = [
    ['GET', () => send('GET', `/entries/${BAD}`)],
    ['PATCH', () => send('PATCH', `/entries/${BAD}`, { title: 'Never inline any SVG' })],
    ['DELETE', () => send('DELETE', `/entries/${BAD}`)],
    [
      'PUT enforcement',
      () => send('PUT', `/entries/${BAD}/enforcement`, { ...ALWAYS, expectedHash: tokenOf() }),
    ],
    ['DELETE enforcement', () => send('DELETE', `/entries/${BAD}/enforcement`)],
  ];

  it.each(requests)('answers 404 on %s, before any query', async (_route, run) => {
    h.gdb = new Proxy(
      {},
      {
        get: (_target, name) => {
          throw new Error(`a query ran: ${String(name)}`);
        },
      },
    );

    const res = await run();

    expect(res.status).toBe(404);
    expect((await asJson(res)).error).toBe('global KB entry not found');
  });
});
