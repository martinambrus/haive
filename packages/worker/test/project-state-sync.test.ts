import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq, getTableName, is, SQL, StringChunk } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import { CHECKOUT_HOLDING_TASK_STATUSES } from '@haive/shared';
import {
  canonicalJson,
  emptyProjectState,
  normalizeProjectState,
  renderContextColumnSchema,
  renderProjectState,
  type ProjectRender,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { writeProjectStateRecord } from '../src/project-state/write.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const STATE_DIR = '.haive-data/state';
const CAP = 1024 * 1024;
// The fake takes a lock only as this prefix, ONE interpolated string key and `, 0))`.
const LOCK = 'execute select pg_advisory_xact_lock(hashtextextended(';
// What the writer (write.ts) locks on: the sync must exclude it with the very same key.
const LOCK_KEY = `project-state:${REPO}`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
/** A jsonb value as Postgres hands it back: object keys by length, then bytes. Rows the database
 *  returns never hold the order a fresh object was built in, so a comparison that reads key order
 *  sees a change in every row it reads. */
const jsonb = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(jsonb);
  if (value === null || typeof value !== 'object') return value;
  const byKey = ([a]: [string, unknown], [b]: [string, unknown]) =>
    a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(byKey)
      .map(([key, member]) => [key, jsonb(member)]),
  );
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !done(); i++) await sleep(5);
  if (!done()) throw new Error('timed out waiting');
}

type Json = Record<string, unknown>;

// ---- fixtures --------------------------------------------------------------------------------
// Every set is already in the order the record writes it, so a column built from one needs no
// normalising to be compared with what the sync produces.

const render = (over: Partial<ProjectRender> = {}): ProjectRender => ({
  projectInfo: {
    name: 'acme',
    framework: 'drupal',
    docroot: 'web',
    runtimeVersions: { php: '8.3' },
  },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer', 'security-auditor'],
  customAgentSpecs: [{ id: 'billing-expert', title: 'Billing expert' }],
  lspLanguages: ['css', 'php-extended'],
  ...over,
});

const PER_INSTALL = {
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
  rtkEnabled: false,
};
const PER_INSTALL_KEYS = Object.keys(PER_INSTALL);
const PORTABLE_KEYS = [
  'acceptedAgentIds',
  'customAgentSpecs',
  'framework',
  'lspLanguages',
  'projectInfo',
];

/** A render context column: the portable fields, the per-install ones this install derived, and the
 *  RTK choice flag. */
const column = (r: ProjectRender, rtkChoiceRecorded = true): Json => ({
  ...r,
  ...PER_INSTALL,
  rtkChoiceRecorded,
});

const record = (r: ProjectRender | null): ProjectStateRecord => ({
  ...emptyProjectState(),
  render: r,
});
/** What the sync row holds for a record that carries only this render unit. */
const baseOf = (r: ProjectRender | null): unknown => json(normalizeProjectState(record(r)));

const BASE = render();
const TEAM = render({
  projectInfo: {
    name: 'acme',
    framework: 'drupal',
    docroot: 'docroot',
    runtimeVersions: { php: '8.4' },
  },
  framework: 'drupal10',
  acceptedAgentIds: ['code-reviewer', 'qa-lead'],
  customAgentSpecs: [{ id: 'billing-expert', title: 'Billing expert, second edition' }],
  lspLanguages: ['css', 'twig'],
});
const LATER = render({ framework: 'drupal11', lspLanguages: ['css', 'php-extended', 'twig'] });

/** A context as step 12 records it, sets deliberately unsorted: the record sorts them, and the sync
 *  of the checkout that wrote it must still find nothing to do. */
const contextA = (): Json => ({
  projectInfo: { name: 'acme', framework: 'drupal', docroot: 'web', testFrameworks: ['phpunit'] },
  framework: 'drupal',
  acceptedAgentIds: ['security-auditor', 'code-reviewer'],
  customAgentSpecs: [{ id: 'billing-expert', title: 'Billing expert' }],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  lspLanguages: ['php-extended', 'css'],
  rtkEnabled: true,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
});

const renderText = (r: ProjectRender = BASE): string =>
  renderProjectState(record(r)).get('project/render.json')!;
const formatText = (): string => renderProjectState(record(BASE)).get('format.json')!;

/** A project/render.json of exactly this many bytes that is otherwise valid. */
function renderTextOfSize(bytes: number): string {
  const sized = (pad: string) => canonicalJson({ ...BASE, projectInfo: { name: 'acme', pad } });
  const bare = Buffer.byteLength(sized(''));
  return sized('x'.repeat(bytes - bare));
}

// ---- the repository, its database and the statements it is sent -------------------------------

interface Seed {
  column?: unknown;
  sync?: { base: unknown; lastError?: string | null };
}

const isWrite = (event: string) => /^(update|insert|delete) /.test(event);
const writesTo = (trace: string[], table: string) =>
  trace.filter((e) => isWrite(e) && e.endsWith(` ${table}`));

/** The statements of a trace, split into those outside any transaction and one list per transaction. */
function transactions(trace: string[]): { outside: string[]; inside: string[][] } {
  const outside: string[] = [];
  const inside: string[][] = [];
  let current: string[] | null = null;
  for (const event of trace) {
    if (event === 'begin') current = [];
    else if (event === 'end') {
      if (current) inside.push(current);
      current = null;
    } else (current ?? outside).push(event);
  }
  return { outside, inside };
}

/** Whatever a sync wrote, it wrote inside one transaction whose first statement is the lock. */
function expectWritesUnderTheLock(trace: string[]): void {
  const { outside, inside } = transactions(trace);
  expect(outside.filter(isWrite)).toEqual([]);
  expect(inside.length).toBeLessThanOrEqual(1);
  for (const txn of inside) expect(txn[0]).toBe(LOCK);
}

/** Every file under a directory with its bytes, by relative path. */
async function treeOf(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out[abs.slice(root.length + 1)] = (await readFile(abs)).toString('base64');
  }
  return out;
}

type SelectBuilder = ReturnType<ReturnType<FakeDbHandle['select']>['from']>;

async function setup(seed: Seed = {}) {
  const root = await mkdtemp(join(tmpdir(), 'project-state-sync-'));
  dirs.push(root);
  const { repositories, projectStateSync: sync, tasks } = schema;
  const fake = createFakeDb({ repositories, projectStateSync: sync, tasks });
  // Columns the sync must leave as they are, set as persistDetection and the mirror import leave them.
  fake.insert(repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
    status: 'ready',
    statusMessage: 'The previous folder was not a usable checkout; it was kept at /aside.',
    updatedAt: new Date(1000),
    rtkEnabled: true,
    renderContext: jsonb(seed.column ?? null),
  });
  fake.insert(repositories, { id: OTHER, userId: USER, name: 'other', source: 'blank' });
  if (seed.sync) {
    fake.insert(sync, {
      repositoryId: REPO,
      baseSnapshot: jsonb(seed.sync.base),
      lastError: seed.sync.lastError ?? null,
      updatedAt: new Date(0),
    });
  }

  const events: string[] = [];
  const lockKeys: string[] = [];
  let quiet = false;
  const hook = {
    onLock: null as ((key: string) => void | Promise<void>) | null,
    onCommit: null as (() => Promise<void>) | null,
    /** Awaited before an insert, an update or a delete writes. */
    onWrite: null as (() => Promise<void>) | null,
    /** Runs once, as the sync row is first read, before the read is made. */
    onFirstSyncRead: null as (() => void) | null,
  };
  const syncRead = () => {
    const once = hook.onFirstSyncRead;
    hook.onFirstSyncRead = null;
    once?.();
  };
  fake.hooks.beforeLock = async (key) => {
    lockKeys.push(key);
    await hook.onLock?.(key);
  };
  const written = (verb: string) => async (table: PgTable) => {
    if (quiet) return;
    await hook.onWrite?.();
    events.push(`${verb} ${getTableName(table)}`);
  };
  fake.hooks.beforeUpdate = written('update');
  fake.hooks.beforeInsert = written('insert');
  fake.hooks.beforeDelete = written('delete');
  fake.hooks.beforeCommit = () => hook.onCommit?.();

  const describeSql = (query: unknown): string => {
    const first = is(query, SQL) ? query.queryChunks[0] : undefined;
    return first instanceof StringChunk ? first.value.join('') : '(not sql text)';
  };
  const traceQuery = (query: SelectBuilder, table: string): SelectBuilder => {
    const proxy: SelectBuilder = new Proxy(query, {
      get(target, prop) {
        const member: unknown = Reflect.get(target, prop);
        if (typeof member !== 'function' || prop === 'then') return member;
        return (...args: unknown[]) => {
          if (prop === 'for') events.push(`select ${table} for ${String(args[0])}`);
          const out: unknown = (member as (...a: unknown[]) => unknown).apply(target, args);
          return out === target ? proxy : out;
        };
      },
    });
    return proxy;
  };
  const traced = (handle: FakeDbHandle): FakeDbHandle =>
    new Proxy(handle, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === 'transaction') {
          return (fn: (tx: FakeDbHandle) => Promise<unknown>) => {
            events.push('begin');
            return (value as FakeDbHandle['transaction'])((tx) => fn(traced(tx))).finally(() =>
              events.push('end'),
            );
          };
        }
        if (prop === 'select') {
          return (...args: Parameters<FakeDbHandle['select']>) => {
            const builder = (value as FakeDbHandle['select'])(...args);
            return {
              from: (table: PgTable) => {
                const name = getTableName(table);
                events.push(`select ${name}`);
                if (table === sync) syncRead();
                return traceQuery(builder.from(table), name);
              },
            };
          };
        }
        if (prop === 'execute') {
          return (query: unknown) => {
            events.push(`execute ${describeSql(query)}`);
            return (value as FakeDbHandle['execute'])(query);
          };
        }
        if (prop === 'query') {
          return new Proxy(value as object, {
            get: (tables, table) =>
              new Proxy(Reflect.get(tables, table) as object, {
                get:
                  (api, method) =>
                  (...args: unknown[]) => {
                    events.push(`read ${String(table)}.${String(method)}`);
                    if (table === 'projectStateSync') syncRead();
                    return (Reflect.get(api, method) as (...a: unknown[]) => unknown)(...args);
                  },
              }),
          });
        }
        return value;
      },
    });
  const db = traced(fake.db as unknown as FakeDbHandle) as unknown as Database;

  const put = async (rel: string, data: string | Buffer) => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), data);
  };
  const putRecord = async (r: ProjectStateRecord) => {
    for (const [rel, text] of renderProjectState(r)) await put(`${STATE_DIR}/${rel}`, text);
  };
  const putRecordSync = (r: ProjectStateRecord) => {
    for (const [rel, text] of renderProjectState(r)) {
      const abs = join(root, STATE_DIR, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  };

  const run = async (over: { repositoryId?: string; repoPath?: string } = {}) => {
    const start = events.length;
    const result = await syncProjectStateFromCheckout(db, {
      repositoryId: over.repositoryId ?? REPO,
      repoPath: over.repoPath ?? root,
    });
    return { outcome: result.outcome as string, trace: events.slice(start) };
  };
  const write = (c: Json, rtkChoiceRecorded: boolean): Promise<readonly string[]> =>
    writeProjectStateRecord(db, {
      repositoryId: REPO,
      repoPath: root,
      context: c as never,
      rtkChoiceRecorded,
    });

  const columnOf = (id = REPO): unknown =>
    fake.rows(repositories).find((r) => r.id === id)?.renderContext ?? null;
  const syncRows = () => fake.rows(sync);
  const syncRow = () => syncRows().find((r) => r.repositoryId === REPO);
  const dump = () =>
    json({ repositories: fake.rows(repositories), projectStateSync: fake.rows(sync) });
  /** Test-side changes, as another transaction's commit would make them: no statement is recorded. */
  const patchColumn = (value: unknown) =>
    fake.patch(repositories, REPO, { renderContext: jsonb(value) });
  const patchBase = (value: unknown) => {
    const row = syncRow();
    if (row) fake.patch(sync, row.id as string, { baseSnapshot: jsonb(value), lastError: null });
    else
      fake.insert(sync, {
        repositoryId: REPO,
        baseSnapshot: jsonb(value),
        lastError: null,
        updatedAt: new Date(0),
      });
  };
  const dropSyncRow = async () => {
    quiet = true;
    try {
      await fake.db.delete(sync).where(eq(sync.repositoryId, REPO));
    } finally {
      quiet = false;
    }
  };
  const addTask = (type: string, status: string, repositoryId = REPO) =>
    fake.insert(tasks, { id: randomUUID(), userId: USER, repositoryId, type, status, title: 't' });

  return {
    root,
    fake,
    hook,
    events,
    lockKeys,
    put,
    putRecord,
    putRecordSync,
    run,
    write,
    columnOf,
    syncRows,
    syncRow,
    dump,
    patchColumn,
    patchBase,
    dropSyncRow,
    addTask,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A repository this install last wrote (or synced) as `r`: its column, and the base to match. */
const synced = (r: ProjectRender, rtkChoiceRecorded = true): Seed => ({
  column: column(r, rtkChoiceRecorded),
  sync: { base: baseOf(r) },
});

// ---- the cases -------------------------------------------------------------------------------

describe('syncProjectStateFromCheckout: the fixtures', () => {
  it('uses columns the column schema accepts, so nothing below fails over a bad fixture', () => {
    for (const r of [BASE, TEAM, LATER]) {
      expect(renderContextColumnSchema.safeParse(column(r)).success).toBe(true);
    }
    expect(renderContextColumnSchema.safeParse(contextA()).success).toBe(false);
    expect(
      renderContextColumnSchema.safeParse({ ...contextA(), rtkChoiceRecorded: true }).success,
    ).toBe(true);
  });

  it('defers on the statuses the shared list holds, which leave out created', () => {
    expect(CHECKOUT_HOLDING_TASK_STATUSES).not.toContain('created');
    expect([...CHECKOUT_HOLDING_TASK_STATUSES].sort()).toEqual(
      ['paused', 'queued', 'running', 'waiting_pr', 'waiting_user'].sort(),
    );
  });
});

describe('syncProjectStateFromCheckout: a first import', () => {
  it('fills a NULL column with the record render unit and the RTK choice, and no per-install field', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    const filled = json(s.columnOf()) as Json;
    expect(filled).toEqual({ ...BASE, rtkChoiceRecorded: true });
    expect(Object.keys(filled).sort()).toEqual([...PORTABLE_KEYS, 'rtkChoiceRecorded']);
    for (const key of PER_INSTALL_KEYS) expect(filled).not.toHaveProperty(key);
    expect(renderContextColumnSchema.safeParse(filled).success).toBe(true);
  });

  it('creates the sync row from the render unit alone, with no error', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));

    await s.run();

    const rows = s.syncRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.repositoryId).toBe(REPO);
    expect(json(row.baseSnapshot)).toEqual(baseOf(BASE));
    expect(row.lastError ?? null).toBeNull();
    expect(row.updatedAt).toBeTruthy();
  });

  it('changes nothing but the render context column and the sync row, the checkout included', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));
    const before = json(s.fake.rows(schema.repositories)) as Json[];
    const filesBefore = await treeOf(s.root);

    const { trace } = await s.run();

    expect(await treeOf(s.root)).toEqual(filesBefore);
    const after = json(s.fake.rows(schema.repositories)) as Json[];
    const withoutColumn = (rows: Json[]) => rows.map(({ renderContext: _column, ...rest }) => rest);
    expect(withoutColumn(after)).toEqual(withoutColumn(before));
    expect(writesTo(trace, 'repositories')).toHaveLength(1);
    expect(trace.filter(isWrite).filter((e) => !e.endsWith(' repositories'))).toEqual([
      expect.stringMatching(/^(insert|update) project_state_sync$/),
    ]);
  });

  it('imports a record that also carries files no unit claims, as a newer release may write', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));
    await s.put(`${STATE_DIR}/future/notes.json`, '{"from":"a newer release"}\n');

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({ ...BASE, rtkChoiceRecorded: true });
  });

  it('reads a checkout whose root is reached through a link', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));
    const via = join(await mkdtemp(join(tmpdir(), 'project-state-sync-via-')), 'checkout');
    dirs.push(dirname(via));
    await symlink(s.root, via);

    const { outcome } = await s.run({ repoPath: via });

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({ ...BASE, rtkChoiceRecorded: true });
  });

  it('takes the record over a different column that has no sync row, keeping the per-install fields and the RTK flag', async () => {
    const s = await setup({ column: column(render({ framework: 'drupal7' }), false) });
    await s.putRecord(record(BASE));

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({ ...BASE, ...PER_INSTALL, rtkChoiceRecorded: false });
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(BASE));
  });
});

describe('syncProjectStateFromCheckout: a second sync of the same files', () => {
  it('writes nothing: no update of the repository and no sync row upsert', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));
    await s.run();
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('unchanged');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });

  it('finds nothing to do in the checkout whose own writer made the record, sets unsorted in its column', async () => {
    const s = await setup();
    await s.write(contextA(), true);
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('unchanged');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });

  it('clears the error an earlier sync left, and writes only the sync row to do it', async () => {
    const s = await setup({
      ...synced(BASE),
      sync: { base: baseOf(BASE), lastError: 'an earlier refusal' },
    });
    await s.putRecord(record(BASE));

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('unchanged');
    expect(s.syncRow()?.lastError ?? null).toBeNull();
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(BASE));
    expect(writesTo(trace, 'repositories')).toEqual([]);
    expect(writesTo(trace, 'project_state_sync')).toHaveLength(1);
    expectWritesUnderTheLock(trace);
  });
});

describe('syncProjectStateFromCheckout: a teammate changed the record (base equals local)', () => {
  it('applies every changed key, keeping the per-install fields and the RTK flag the column had', async () => {
    const s = await setup(synced(BASE, false));
    await s.putRecord(record(TEAM));

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({ ...TEAM, ...PER_INSTALL, rtkChoiceRecorded: false });
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(TEAM));
    expect(s.syncRow()?.lastError ?? null).toBeNull();
    expect(writesTo(trace, 'repositories')).toHaveLength(1);
    expect(writesTo(trace, 'project_state_sync')).toHaveLength(1);
    expectWritesUnderTheLock(trace);
  });

  it('keeps an RTK choice that was made', async () => {
    const s = await setup(synced(BASE, true));
    await s.putRecord(record(TEAM));

    await s.run();

    expect(json(s.columnOf())).toEqual({ ...TEAM, ...PER_INSTALL, rtkChoiceRecorded: true });
  });
});

describe('syncProjectStateFromCheckout: a change made on this install (base equals incoming)', () => {
  // The sync does not rewrite the checkout's record, so the base stays the record it holds: a base
  // moved to the local value would make the next sync revert the local change.
  const local = render({
    framework: 'drupal7',
    acceptedAgentIds: ['code-reviewer'],
    lspLanguages: ['blade', 'css', 'php-extended'],
  });

  it('is kept, and nothing is written at all', async () => {
    const s = await setup({ column: column(local), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(BASE));
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('unchanged');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });

  it('keeps a union of set members the first sync made, and the next sync writes nothing', async () => {
    const ours = render({ lspLanguages: ['css', 'php-extended', 'twig'] });
    const theirs = render({ lspLanguages: ['blade', 'css', 'php-extended'] });
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));

    const first = await s.run();
    expect(first.outcome).toBe('applied');
    const union = ['blade', 'css', 'php-extended', 'twig'];
    expect((json(s.columnOf()) as Json).lspLanguages).toEqual(union);

    const before = s.dump();
    const second = await s.run();
    expect(second.outcome).toBe('unchanged');
    expect(second.trace.filter(isWrite)).toEqual([]);
    expect((json(s.columnOf()) as Json).lspLanguages).toEqual(union);
    expect(s.dump()).toEqual(before);
  });
});

describe('syncProjectStateFromCheckout: both sides changed a key, differently', () => {
  const ours = render({ framework: 'drupal7' });
  const theirs = render({ framework: 'drupal10' });

  it('keeps the local value, keeps the old base for that key and names the key in last_error', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));
    const columnBefore = json(s.columnOf());

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('conflict');
    expect(json(s.columnOf())).toEqual(columnBefore);
    expect(writesTo(trace, 'repositories')).toEqual([]);
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(BASE));
    const error = s.syncRow()?.lastError;
    expect(typeof error).toBe('string');
    expect(error).toMatch(/conflict/i);
    expect(error).toContain('framework');
    expect(error).not.toContain('acceptedAgentIds');
    expectWritesUnderTheLock(trace);
  });

  it('finds the same conflict again on the next sync, and writes nothing to say so', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));
    await s.run();
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('conflict');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });

  it('applies the keys that did not conflict beside it, and keeps the old base for the ones that did', async () => {
    const local = render({ framework: 'drupal7', acceptedAgentIds: ['code-reviewer'] });
    const incoming = render({
      framework: 'drupal10',
      acceptedAgentIds: ['code-reviewer', 'qa-lead'],
      lspLanguages: ['css', 'php-extended', 'twig'],
    });
    const s = await setup({ column: column(local, false), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(incoming));

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('conflict');
    expect(json(s.columnOf())).toEqual({
      ...local,
      lspLanguages: ['css', 'php-extended', 'twig'],
      ...PER_INSTALL,
      rtkChoiceRecorded: false,
    });
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(
      baseOf(
        render({
          framework: BASE.framework,
          acceptedAgentIds: BASE.acceptedAgentIds,
          lspLanguages: ['css', 'php-extended', 'twig'],
        }),
      ),
    );
    const error = s.syncRow()?.lastError;
    expect(error).toContain('framework');
    expect(error).toContain('acceptedAgentIds');
    expect(error).not.toContain('lspLanguages');
    expect(writesTo(trace, 'repositories')).toHaveLength(1);
    expectWritesUnderTheLock(trace);
  });
});

describe('syncProjectStateFromCheckout: a column the schema would not accept once written', () => {
  it('is refused and left as it was, with the reason on the sync row', async () => {
    const stale = { ...column(BASE), aKeyNoReleaseWrites: 1 };
    const s = await setup({ column: stale, sync: { base: baseOf(BASE) } });
    await s.putRecord(record(TEAM));

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('refused');
    expect(json(s.columnOf())).toEqual(stale);
    expect(writesTo(trace, 'repositories')).toEqual([]);
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(BASE));
    expect(typeof s.syncRow()?.lastError).toBe('string');
    expect((s.syncRow()?.lastError as string).length).toBeGreaterThan(0);
    expectWritesUnderTheLock(trace);
  });
});

describe('syncProjectStateFromCheckout: a local record the codec would refuse', () => {
  // projectInfo and customAgentSpecs hold any JSON, so the codec's depth bound is the only one:
  // the column is rendered as a record before it is merged, as the checkout's record is parsed.
  const nest = (levels: number): Record<string, unknown> => {
    let value: unknown = 'leaf';
    for (let i = 0; i < levels; i++) value = { a: value };
    return value as Record<string, unknown>;
  };
  const SHAPES: Record<string, (levels: number) => ProjectRender> = {
    projectInfo: (levels) => render({ projectInfo: nest(levels) }),
    customAgentSpecs: (levels) =>
      render({ customAgentSpecs: [{ id: 'billing-expert', deep: nest(levels) }] }),
  };
  const accepted = (r: ProjectRender): boolean => {
    try {
      renderProjectState(record(r));
      return true;
    } catch {
      return false;
    }
  };
  /** The deepest nesting the codec accepts, measured: one level more and it throws. */
  const deepest = (shape: (levels: number) => ProjectRender): number => {
    let levels = 1;
    while (levels < 500 && accepted(shape(levels + 1))) levels += 1;
    return levels;
  };
  const putRaw = async (s: Setup, r: ProjectRender) => {
    await s.put(`${STATE_DIR}/format.json`, formatText());
    await s.put(`${STATE_DIR}/project/render.json`, canonicalJson(r));
  };

  it('is measured here: the codec refuses a path of 64 keys, so projectInfo holds 63 objects and a record file holds the same', () => {
    expect(deepest(SHAPES.projectInfo!)).toBe(63);
    expect(deepest(SHAPES.customAgentSpecs!)).toBe(61);
  });

  describe.each(Object.keys(SHAPES))('a column whose %s', (name) => {
    const shape = SHAPES[name]!;
    const limit = deepest(shape);
    // The record on disk changes the framework and nothing else, so it applies beside any column.
    const onDisk = record(render({ framework: 'drupal10' }));

    it('is nested one level past what the codec accepts: refused and left as it was, no row made', async () => {
      const s = await setup({ column: column(shape(limit + 1)) });
      await s.putRecord(onDisk);
      const before = s.dump();

      const { outcome, trace } = await s.run();

      expect(outcome).toBe('refused');
      expect(trace.filter(isWrite)).toEqual([]);
      expect(s.dump()).toEqual(before);
    });

    it('is nested far past it, on a repository with a sync row: the reason on the row names the depth', async () => {
      const seeded = { column: column(shape(limit + 7)), sync: { base: baseOf(BASE) } };
      const s = await setup(seeded);
      await s.putRecord(onDisk);

      const first = await s.run();

      expect(first.outcome).toBe('refused');
      expect(json(s.columnOf())).toEqual(json(seeded.column));
      expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(BASE));
      expect(s.syncRow()?.lastError).toMatch(/deep|nest|depth/i);
      expect(s.syncRow()?.lastError).not.toMatch(/\n/);
      expect(writesTo(first.trace, 'repositories')).toEqual([]);
      expectWritesUnderTheLock(first.trace);
    });

    it('is nested as deep as the codec accepts: not refused, the record on disk applies beside it', async () => {
      const s = await setup({ column: column(shape(limit)), sync: { base: baseOf(BASE) } });
      await s.putRecord(onDisk);

      const { outcome } = await s.run();

      expect(outcome).toBe('applied');
      expect(json(s.columnOf())).toEqual({
        ...shape(limit),
        framework: 'drupal10',
        ...PER_INSTALL,
        rtkChoiceRecorded: true,
      });
    });

    it('is bounded as a record file is: the same depth is imported and one more is refused', async () => {
      const at = await setup();
      await putRaw(at, shape(limit));
      const past = await setup();
      await putRaw(past, shape(limit + 1));

      expect((await at.run()).outcome).toBe('applied');
      expect((await past.run()).outcome).toBe('refused');
      expect(past.columnOf()).toBeNull();
      expect(past.syncRows()).toEqual([]);
    });
  });
});

/** A valid record in the checkout, then one defect, whatever it is. */
const REFUSED: [string, (s: Setup) => Promise<void>][] = [
  [
    'a link in place of project/render.json',
    async (s) => {
      await s.put('.haive-data/elsewhere.json', renderText());
      await rm(join(s.root, STATE_DIR, 'project/render.json'));
      await symlink('../../elsewhere.json', join(s.root, STATE_DIR, 'project/render.json'));
    },
  ],
  [
    'a link in place of format.json',
    async (s) => {
      await s.put('.haive-data/elsewhere-format.json', formatText());
      await rm(join(s.root, STATE_DIR, 'format.json'));
      await symlink('../elsewhere-format.json', join(s.root, STATE_DIR, 'format.json'));
    },
  ],
  [
    'a link in place of the project directory',
    async (s) => {
      await s.put('.haive-data/elsewhere/render.json', renderText());
      await rm(join(s.root, STATE_DIR, 'project'), { recursive: true });
      await symlink('../elsewhere', join(s.root, STATE_DIR, 'project'));
    },
  ],
  [
    'a link among files no unit claims',
    async (s) => {
      await s.put('.haive-data/elsewhere.json', '{}\n');
      await symlink('../elsewhere.json', join(s.root, STATE_DIR, 'notes.json'));
    },
  ],
  [
    'a link in place of the state directory',
    async (s) => {
      await rename(join(s.root, STATE_DIR), join(s.root, '.haive-data/elsewhere-state'));
      await symlink('elsewhere-state', join(s.root, STATE_DIR));
    },
  ],
  [
    'a pipe among the files',
    async (s) => {
      await mkdir(join(s.root, STATE_DIR, 'settings'), { recursive: true });
      execFileSync('mkfifo', [join(s.root, STATE_DIR, 'settings/pipe.json')]);
    },
  ],
  [
    'a render file that is not valid UTF-8',
    async (s) => {
      const text = renderText();
      const cut = text.indexOf('acme');
      await s.put(
        `${STATE_DIR}/project/render.json`,
        Buffer.concat([
          Buffer.from(text.slice(0, cut)),
          Buffer.from([0xff, 0xfe]),
          Buffer.from(text.slice(cut)),
        ]),
      );
    },
  ],
  [
    'a render file one byte over the 1 MiB cap',
    async (s) => {
      await s.put(`${STATE_DIR}/project/render.json`, renderTextOfSize(CAP + 1));
    },
  ],
  [
    'a format.json from a newer release',
    async (s) => {
      await s.put(`${STATE_DIR}/format.json`, '{\n  "schemaVersion": 2\n}\n');
    },
  ],
  [
    'a render file that is not JSON',
    async (s) => {
      await s.put(`${STATE_DIR}/project/render.json`, '{ "framework": \n');
    },
  ],
  [
    'a render file holding merge conflict markers',
    async (s) => {
      await s.put(
        `${STATE_DIR}/project/render.json`,
        `<<<<<<< HEAD\n${renderText()}=======\n${renderText(TEAM)}>>>>>>> origin/main\n`,
      );
    },
  ],
  [
    'a render file that is missing a field',
    async (s) => {
      await s.put(
        `${STATE_DIR}/project/render.json`,
        canonicalJson({ framework: 'drupal', projectInfo: {} }),
      );
    },
  ],
  [
    'a record with no format.json',
    async (s) => {
      await rm(join(s.root, STATE_DIR, 'format.json'));
    },
  ],
];

describe('syncProjectStateFromCheckout: a record it refuses', () => {
  describe.each(REFUSED)('%s', (_what, damage) => {
    it('leaves a NULL column alone and creates no sync row', async () => {
      const s = await setup();
      await s.putRecord(record(BASE));
      await damage(s);
      const before = s.dump();

      const { outcome, trace } = await s.run();

      expect(outcome).toBe('refused');
      expect(s.columnOf()).toBeNull();
      expect(s.syncRows()).toEqual([]);
      expect(trace.filter(isWrite)).toEqual([]);
      expect(s.dump()).toEqual(before);
    });

    it('leaves the column and the base alone and says why in last_error, once', async () => {
      const s = await setup(synced(BASE));
      await s.putRecord(record(BASE));
      await damage(s);
      const before = s.dump() as { projectStateSync: Json[] };

      const first = await s.run();

      expect(first.outcome).toBe('refused');
      expect(json(s.columnOf())).toEqual(column(BASE));
      const row = s.syncRow();
      expect(json(row?.baseSnapshot)).toEqual(baseOf(BASE));
      expect(typeof row?.lastError).toBe('string');
      expect((row?.lastError as string).length).toBeGreaterThan(0);
      expect(row?.lastError).not.toMatch(/\n/);
      expect(writesTo(first.trace, 'repositories')).toEqual([]);
      expect(writesTo(first.trace, 'project_state_sync')).toHaveLength(1);
      expect(s.syncRows()).toHaveLength(before.projectStateSync.length);
      expectWritesUnderTheLock(first.trace);

      const second = await s.run();
      expect(second.outcome).toBe('refused');
      expect(second.trace.filter(isWrite)).toEqual([]);
    });
  });

  it('never follows a link above the state directory: a record behind one is not imported', async () => {
    const s = await setup();
    await s.put('elsewhere/state/format.json', formatText());
    await s.put('elsewhere/state/project/render.json', renderText());
    await symlink('elsewhere', join(s.root, '.haive-data'));

    const { outcome, trace } = await s.run();

    expect(['absent', 'refused']).toContain(outcome);
    expect(s.columnOf()).toBeNull();
    expect(s.syncRows()).toEqual([]);
    expect(trace.filter(isWrite)).toEqual([]);
  });
});

describe('syncProjectStateFromCheckout: a repository with a live onboarding or upgrade', () => {
  describe.each(['onboarding', 'onboarding_upgrade'])('an %s task', (type) => {
    it.each([...CHECKOUT_HOLDING_TASK_STATUSES])(
      'defers while it is %s, writing nothing',
      async (status) => {
        const s = await setup();
        await s.putRecord(record(BASE));
        s.addTask(type, status);
        const before = s.dump();

        const { outcome, trace } = await s.run();

        expect(outcome).toBe('deferred');
        expect(trace.filter(isWrite)).toEqual([]);
        expect(s.dump()).toEqual(before);
        expect(s.columnOf()).toBeNull();
        expect(s.syncRows()).toEqual([]);
      },
    );

    it.each(['created', 'completed', 'failed', 'cancelled'])(
      'does not defer when it is %s',
      async (status) => {
        const s = await setup();
        await s.putRecord(record(BASE));
        s.addTask(type, status);

        const { outcome } = await s.run();

        expect(outcome).toBe('applied');
        expect(json(s.columnOf())).toEqual({ ...BASE, rtkChoiceRecorded: true });
      },
    );
  });

  it('writes nothing while deferred even when there is a change and a sync row to write it to', async () => {
    const s = await setup({ ...synced(BASE), sync: { base: baseOf(BASE), lastError: 'earlier' } });
    await s.putRecord(record(TEAM));
    s.addTask('onboarding_upgrade', 'running');
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('deferred');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });

  it('imports once the task has finished: a deferral is not remembered', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));
    const taskId = randomUUID();
    s.fake.insert(schema.tasks, {
      id: taskId,
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding',
      status: 'running',
      title: 't',
    });
    expect((await s.run()).outcome).toBe('deferred');

    s.fake.patch(schema.tasks, taskId, { status: 'completed' });

    expect((await s.run()).outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({ ...BASE, rtkChoiceRecorded: true });
  });

  it.each(['workflow', 'run_app', 'kb_author', 'plan_build'])(
    'does not defer for a running %s task',
    async (type) => {
      const s = await setup();
      await s.putRecord(record(BASE));
      s.addTask(type, 'running');

      expect((await s.run()).outcome).toBe('applied');
    },
  );

  it('does not defer for an onboarding task of another repository', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));
    s.addTask('onboarding', 'running', OTHER);

    expect((await s.run()).outcome).toBe('applied');
  });
});

describe('syncProjectStateFromCheckout: a base that moved since the files were read', () => {
  it('reports superseded and writes nothing when a writer recorded a newer base', async () => {
    const s = await setup(synced(BASE));
    await s.putRecord(record(TEAM));
    s.hook.onLock = () => {
      s.patchColumn(column(LATER));
      s.patchBase(baseOf(LATER));
    };

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('superseded');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(json(s.columnOf())).toEqual(column(LATER));
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(LATER));
    expect(s.syncRow()?.lastError ?? null).toBeNull();
  });

  it('reports superseded when the first sync row appeared meanwhile, and does not take over its column', async () => {
    const s = await setup();
    await s.putRecord(record(TEAM));
    s.hook.onLock = () => {
      s.patchColumn(column(LATER));
      s.patchBase(baseOf(LATER));
    };

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('superseded');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(json(s.columnOf())).toEqual(column(LATER));
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(LATER));
  });

  it('reports superseded when the sync row was removed meanwhile, and brings nothing back', async () => {
    const s = await setup(synced(BASE));
    await s.putRecord(record(TEAM));
    s.hook.onLock = async () => {
      s.patchColumn(null);
      await s.dropSyncRow();
    };

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('superseded');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.columnOf()).toBeNull();
    expect(s.syncRows()).toEqual([]);
  });

  it('reads the base before the files, so a writer that finishes in between is seen', async () => {
    const s = await setup(synced(BASE));
    await s.putRecord(record(BASE));
    // The writer commits its record the moment the sync first asks for the base.
    s.hook.onFirstSyncRead = () => {
      s.putRecordSync(record(LATER));
      s.patchColumn(column(LATER));
      s.patchBase(baseOf(LATER));
    };

    const { outcome, trace } = await s.run();

    expect(['unchanged', 'superseded']).toContain(outcome);
    expect(trace.filter(isWrite)).toEqual([]);
    expect(json(s.columnOf())).toEqual(column(LATER));
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(LATER));
  });

  it('waits for a writer holding the lock, then reports superseded and does not overwrite it', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    let locks = 0;
    s.hook.onLock = () => {
      locks += 1;
    };
    // The writer has taken the lock and is about to write; the fake has no isolation, so anything
    // it wrote before this point would already be visible to the sync's first read.
    s.hook.onWrite = async () => {
      writes += 1;
      if (writes > 1) return;
      s.events.push('writer: holding the lock');
      await gate;
      s.events.push('writer: released');
    };

    let writer: Promise<unknown> = Promise.resolve();
    let syncing: Promise<{ outcome: string }> = Promise.resolve({ outcome: '' });
    try {
      writer = s.write(contextA(), true);
      await waitFor(() => s.events.includes('writer: holding the lock'));
      let settled = false;
      syncing = s.run().finally(() => (settled = true));
      await waitFor(() => locks === 2 || settled);
      await sleep(40);
      const held = s.events.indexOf('writer: holding the lock');
      expect(s.events.slice(held + 1).filter(isWrite)).toEqual([]);
      expect(settled).toBe(false);

      release();
      const [, result] = await Promise.all([writer, syncing]);

      expect(result.outcome).toBe('superseded');
      expect(json(s.columnOf())).toEqual({ ...contextA(), rtkChoiceRecorded: true });
      expect(s.syncRows()).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([writer, syncing]);
    }
  });
});

describe('syncProjectStateFromCheckout: nothing to import', () => {
  const NOTHING: [string, (s: Setup) => Promise<void>][] = [
    ['no state directory and no .haive-data', async () => {}],
    [
      'only the legacy mirror files',
      async (s) => {
        for (const name of ['environment', 'tooling', 'exclusions', 'plan']) {
          await s.put(`.haive-data/${name}.json`, '{"schemaVersion":1}\n');
        }
      },
    ],
    [
      'a record with a format file and no render unit',
      async (s) => {
        await s.putRecord(emptyProjectState());
      },
    ],
    [
      'a record whose only unit is one this release does not map',
      async (s) => {
        await s.putRecord({ ...emptyProjectState(), cli: ['claude-code'] });
      },
    ],
  ];

  describe.each(NOTHING)('%s', (_what, arrange) => {
    it('is absent for a repository with no column and no sync row, and writes nothing', async () => {
      const s = await setup();
      await arrange(s);
      const before = s.dump();

      const { outcome, trace } = await s.run();

      expect(outcome).toBe('absent');
      expect(trace.filter(isWrite)).toEqual([]);
      expect(s.dump()).toEqual(before);
    });

    it('is absent for a repository that has both, and writes nothing, its error included', async () => {
      const s = await setup({
        ...synced(BASE),
        sync: { base: baseOf(BASE), lastError: 'earlier' },
      });
      await arrange(s);
      const before = s.dump();

      const { outcome, trace } = await s.run();

      expect(outcome).toBe('absent');
      expect(trace.filter(isWrite)).toEqual([]);
      expect(s.dump()).toEqual(before);
    });
  });
});

describe('syncProjectStateFromCheckout: units this release does not map', () => {
  const settings = Object.assign(Object.create(null) as Record<string, unknown>, {
    'scope-exclude-globs': ['vendor/**'],
    'review-dimensions': ['security'],
  });
  const full = (over: Partial<ProjectStateRecord> = {}): ProjectStateRecord => ({
    environment: { envDetectData: { project: { name: 'acme' } }, confirmedValues: {} },
    render: BASE,
    cli: ['claude-code', 'codex'],
    settings,
    claims: [
      {
        path: '.claude/agents/code-reviewer.md',
        templateId: 'agent.code-reviewer',
        kind: 'agent',
        schemaVersion: 1,
        templateHash: 'a'.repeat(64),
        writtenHash: 'b'.repeat(64),
        haiveVersion: '0.0.0-dev',
      },
    ],
    bundles: [{ source: 'git:https://example.com/bundle.git', name: 'bundle' }],
    ...over,
  });

  it('are neither applied nor kept in the base', async () => {
    const s = await setup();
    await s.putRecord(full());
    const reposBefore = json(s.fake.rows(schema.repositories)) as Json[];

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({ ...BASE, rtkChoiceRecorded: true });
    const base = json(s.syncRow()?.baseSnapshot) as Json;
    expect(base).toEqual(baseOf(BASE));
    expect(base.environment).toBeNull();
    expect(base.cli).toEqual([]);
    expect(base.claims).toEqual([]);
    expect(base.bundles).toEqual([]);
    expect(base.settings).toEqual({});
    const after = json(s.fake.rows(schema.repositories)) as Json[];
    const without = (rows: Json[]) => rows.map(({ renderContext: _c, ...rest }) => rest);
    expect(without(after)).toEqual(without(reposBefore));
  });

  it('changing them in the checkout does not make the next sync write anything', async () => {
    const s = await setup();
    await s.putRecord(full());
    await s.run();
    const before = s.dump();
    await rm(join(s.root, STATE_DIR), { recursive: true });
    await s.putRecord(
      full({
        environment: { envDetectData: { project: { name: 'renamed' } }, confirmedValues: { a: 1 } },
        cli: ['codex'],
        claims: [],
        bundles: [],
      }),
    );

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('unchanged');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });
});

describe('syncProjectStateFromCheckout: the lock and the transaction', () => {
  it('takes the lock first in the one transaction that writes, and reads the repository FOR UPDATE before it writes', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('applied');
    const { outside, inside } = transactions(trace);
    expect(inside).toHaveLength(1);
    const txn = inside[0]!;
    expect(txn[0]).toBe(LOCK);
    expect(outside.filter(isWrite)).toEqual([]);
    expect(txn.filter((e) => e === LOCK)).toHaveLength(1);
    const forUpdate = txn.indexOf('select repositories for update');
    expect(forUpdate).toBeGreaterThan(0);
    expect(forUpdate).toBeLessThan(txn.findIndex(isWrite));
    expect(s.lockKeys).toEqual([LOCK_KEY]);
  });

  it('takes the same lock key as the writer, and its own repository key for another repository', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));
    await s.run();
    await s.write(contextA(), true);

    const elsewhere = await mkdtemp(join(tmpdir(), 'project-state-sync-other-'));
    dirs.push(elsewhere);
    await mkdir(join(elsewhere, STATE_DIR, 'project'), { recursive: true });
    for (const [rel, text] of renderProjectState(record(BASE))) {
      await writeFile(join(elsewhere, STATE_DIR, rel), text);
    }
    await s.run({ repositoryId: OTHER, repoPath: elsewhere });

    const [fromSync, fromWriter, fromOther] = s.lockKeys;
    expect(s.lockKeys).toHaveLength(3);
    expect(fromSync).toBe(fromWriter);
    expect(fromOther).not.toBe(fromSync);
    expect(fromOther).toBe(`project-state:${OTHER}`);
  });

  it.each(['the second write fails', 'the commit fails'])(
    'writes the column and the sync row together: when %s, both are as they were',
    async (when) => {
      const s = await setup(synced(BASE));
      await s.putRecord(record(TEAM));
      const before = s.dump();
      let writes = 0;
      let commits = 0;
      s.hook.onWrite = async () => {
        writes += 1;
        if (when === 'the second write fails' && writes === 2) throw new Error('database refused');
      };
      s.hook.onCommit = async () => {
        commits += 1;
        if (when === 'the commit fails') throw new Error('database refused');
      };

      await s.run().catch(() => undefined);

      // Both statements were sent, so there was something to take back.
      expect(writes).toBeGreaterThanOrEqual(2);
      expect(commits).toBe(when === 'the commit fails' ? 1 : 0);
      expect(s.dump()).toEqual(before);
    },
  );

  it('reads the files before the transaction opens and does not read them again inside it', async () => {
    const s = await setup(synced(BASE));
    await s.putRecord(record(TEAM));
    // The checkout changes while the sync waits for the lock.
    s.hook.onLock = () => {
      s.putRecordSync(record(LATER));
    };

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({ ...TEAM, ...PER_INSTALL, rtkChoiceRecorded: true });
  });

  it('reads the column under the lock: a per-install field a writer changed after the files were read survives', async () => {
    const s = await setup(synced(BASE));
    await s.putRecord(record(TEAM));
    const codexTargets = [{ dir: '.codex/agents', format: 'toml' }];
    // Another writer commits per-install fields only, so the base does not move.
    s.hook.onLock = () => {
      s.patchColumn({ ...column(BASE), agentTargets: codexTargets });
    };

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({
      ...TEAM,
      ...PER_INSTALL,
      agentTargets: codexTargets,
      rtkChoiceRecorded: true,
    });
  });
});
