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
import {
  CHECKOUT_HOLDING_TASK_STATUSES,
  normalizeContent,
  pendingImportedMcpServers,
  sha256Hex,
} from '@haive/shared';
import {
  canonicalJson,
  claimFileName,
  emptyProjectState,
  normalizeProjectState,
  portableBundleSource,
  renderContextColumnSchema,
  renderProjectState,
  type ProjectRender,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { refreshProjectState } from '../src/project-state/refresh.js';
import { resolveRenderContext } from '../src/step-engine/_upgrade-render.js';
import { writeProjectStateColumn, writeProjectStateRecord } from '../src/project-state/write.js';
import {
  rebaseProjectStateOnCheckout,
  syncProjectStateFromCheckout,
} from '../src/project-state/sync.js';

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
  customAgentSpecs: [
    { id: 'billing-expert', title: 'Billing expert', description: 'Knows the billing module' },
  ],
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

const promoted = (c: Json): Json => ({ ...c, cliTargets: ['claude-code'] });

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
  customAgentSpecs: [
    {
      id: 'billing-expert',
      title: 'Billing expert, second edition',
      description: 'Knows the billing module',
    },
  ],
  lspLanguages: ['css', 'twig'],
});
const LATER = render({ framework: 'drupal11', lspLanguages: ['css', 'php-extended', 'twig'] });

/** A context as step 12 records it, sets deliberately unsorted: the record sorts them, and the sync
 *  of the checkout that wrote it must still find nothing to do. */
const contextA = (): Json => ({
  projectInfo: { name: 'acme', framework: 'drupal', docroot: 'web', testFrameworks: ['phpunit'] },
  framework: 'drupal',
  acceptedAgentIds: ['security-auditor', 'code-reviewer'],
  customAgentSpecs: [
    { id: 'billing-expert', title: 'Billing expert', description: 'Knows the billing module' },
  ],
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
  const { repositories, projectStateSync: sync, tasks, onboardingArtifacts } = schema;
  const conflicts = schema.projectStateConflicts;
  const fake = createFakeDb({
    repositories,
    projectStateSync: sync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: conflicts,
    tasks,
    taskSteps: schema.taskSteps,
    onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
  });
  // Columns the sync must leave as they are, set as persistDetection and the mirror import leave them.
  fake.insert(repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
    status: 'ready',
    statusMessage: 'The previous folder was not a usable checkout; it was kept at /aside.',
    updatedAt: new Date(1000),
    // Holds no value, so the render-only checkouts below are coherent with it; the settings cases set it.
    rtkEnabled: null,
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
    onWrite: null as ((table: PgTable) => Promise<void>) | null,
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
    await hook.onWrite?.(table);
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
  const rebase = () => rebaseProjectStateOnCheckout(db, { repositoryId: REPO, repoPath: root });
  const write = (c: Json, rtkChoiceRecorded: boolean): Promise<readonly string[]> =>
    writeProjectStateRecord(db, {
      repositoryId: REPO,
      repoPath: root,
      context: c as never,
      rtkChoiceRecorded,
    }).then((result) => result.written);

  const columnOf = (id = REPO): unknown =>
    fake.rows(repositories).find((r) => r.id === id)?.renderContext ?? null;
  const syncRows = () => fake.rows(sync);
  const syncRow = () => syncRows().find((r) => r.repositoryId === REPO);
  const conflictRows = (id = REPO) => fake.rows(conflicts).filter((r) => r.repositoryId === id);
  const pending = (id = REPO) => conflictRows(id).filter((r) => r.resolvedAt == null);
  const dump = () =>
    json({
      repositories: fake.rows(repositories),
      projectStateSync: fake.rows(sync),
      projectStateConflicts: fake.rows(conflicts),
    });
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
    rebase,
    write,
    columnOf,
    syncRows,
    syncRow,
    conflictRows,
    pending,
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
  it('fills a NULL column with the record render unit and no RTK choice, and no per-install field', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    const filled = json(s.columnOf()) as Json;
    expect(filled).toEqual({ ...BASE, cliTargets: [], rtkChoiceRecorded: false });
    expect(Object.keys(filled).sort()).toEqual(
      [...PORTABLE_KEYS, 'cliTargets', 'rtkChoiceRecorded'].sort(),
    );
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
    expect(json(s.columnOf())).toEqual({ ...BASE, cliTargets: [], rtkChoiceRecorded: false });
  });

  it('reads a checkout whose root is reached through a link', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));
    const via = join(await mkdtemp(join(tmpdir(), 'project-state-sync-via-')), 'checkout');
    dirs.push(dirname(via));
    await symlink(s.root, via);

    const { outcome } = await s.run({ repoPath: via });

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual({ ...BASE, cliTargets: [], rtkChoiceRecorded: false });
  });

  it('takes the record over a different column that has no sync row, keeping the per-install fields and the RTK flag', async () => {
    const s = await setup({ column: column(render({ framework: 'drupal7' }), false) });
    await s.putRecord(record(BASE));

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(json(s.columnOf())).toEqual(
      promoted({ ...BASE, ...PER_INSTALL, rtkChoiceRecorded: false }),
    );
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

    expect(outcome).toBe('applied');
    expect(s.syncRow()?.lastError ?? null).toBeNull();
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(BASE));
    expect(writesTo(trace, 'repositories')).toEqual(['update repositories']);
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
    expect(json(s.columnOf())).toEqual(
      promoted({ ...TEAM, ...PER_INSTALL, rtkChoiceRecorded: false }),
    );
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

    expect(json(s.columnOf())).toEqual(
      promoted({ ...TEAM, ...PER_INSTALL, rtkChoiceRecorded: true }),
    );
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
    await s.run();
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
    expect(json(s.columnOf())).toEqual(promoted(columnBefore as Json));
    expect(writesTo(trace, 'repositories')).toEqual(['update repositories']);
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
      cliTargets: ['claude-code'],
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

describe('syncProjectStateFromCheckout: a conflict is kept as a row until somebody answers it', () => {
  const ours = render({ framework: 'drupal7' });
  const theirs = render({ framework: 'drupal10' });
  const FRAMEWORK = 'project/render.json#framework';

  it('writes exactly one pending row holding the base, the local and the incoming value', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));

    const { trace } = await s.run();

    const rows = s.conflictRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repositoryId: REPO, unit: FRAMEWORK });
    expect(json(rows[0]!.base)).toEqual({ v: 'drupal' });
    expect(json(rows[0]!.local)).toEqual({ v: 'drupal7' });
    expect(json(rows[0]!.incoming)).toEqual({ v: 'drupal10' });
    expect(rows[0]!.resolvedAt ?? null).toBeNull();
    expect(rows[0]!.resolution ?? null).toBeNull();
    expect(writesTo(trace, 'project_state_conflicts')).toHaveLength(1);
    expectWritesUnderTheLock(trace);
  });

  it('writes a row for every key that conflicted, and none for a key that merged', async () => {
    const local = render({ framework: 'drupal7', acceptedAgentIds: ['code-reviewer'] });
    const incoming = render({
      framework: 'drupal10',
      acceptedAgentIds: ['code-reviewer', 'qa-lead'],
      lspLanguages: ['css', 'twig'],
    });
    const s = await setup({ column: column(local), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(incoming));

    await s.run();

    expect(
      s
        .pending()
        .map((r) => r.unit)
        .sort(),
    ).toEqual(['project/render.json#acceptedAgentIds', FRAMEWORK]);
  });

  it('keeps a value the teammate set to null as a value, and a value this side lacks as absent', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(render({ framework: null })));

    await s.run();

    const [row] = s.pending();
    expect(json(row!.incoming)).toEqual({ v: null });
    expect(json(row!.local)).toEqual({ v: 'drupal7' });
  });

  it('writes the whole render file as one row when this side holds none', async () => {
    const s = await setup({ sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));

    await s.run();

    const [row] = s.pending();
    expect(row).toMatchObject({ unit: 'project/render.json' });
    expect(row!.local ?? null).toBeNull();
    expect(json(row!.base)).toEqual({ v: json(BASE) });
    expect(json(row!.incoming)).toEqual({ v: json(theirs) });
  });

  it('writes nothing on a second sync of the same files, to any table', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));
    await s.run();
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('conflict');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });

  it('moves the same row when the teammate changes the value again, and adds no second one', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));
    await s.run();
    const first = s.pending()[0]!;

    await s.putRecord(record(render({ framework: 'drupal11' })));
    await s.run();

    expect(s.conflictRows()).toHaveLength(1);
    expect(s.pending()[0]!.id).toBe(first.id);
    expect(json(s.pending()[0]!.incoming)).toEqual({ v: 'drupal11' });
    expect(s.pending()[0]!.detectedAt).toEqual(first.detectedAt);
  });

  it('resolves the row as converged when the teammate goes back to the base', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));
    await s.run();
    const id = s.pending()[0]!.id;

    await s.putRecord(record(BASE));
    const { outcome, trace } = await s.run();

    expect(outcome).toBe('unchanged');
    expect(s.pending()).toEqual([]);
    const [row] = s.conflictRows();
    expect(row).toMatchObject({ id, resolution: 'converged' });
    expect(row!.resolvedAt).toBeInstanceOf(Date);
    expect(row!.resolvedBy ?? null).toBeNull();
    expect(writesTo(trace, 'project_state_conflicts')).toHaveLength(1);
    expectWritesUnderTheLock(trace);
  });

  it('resolves the row as converged when the teammate adopts this side’s value', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));
    await s.run();

    await s.putRecord(record(ours));
    await s.run();

    expect(s.pending()).toEqual([]);
    expect(s.conflictRows()[0]).toMatchObject({ resolution: 'converged' });
  });

  it('opens a new row when the same key conflicts again after one converged', async () => {
    const s = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));
    await s.run();
    await s.putRecord(record(BASE));
    await s.run();

    await s.putRecord(record(render({ framework: 'drupal11' })));
    await s.run();

    expect(s.conflictRows()).toHaveLength(2);
    expect(s.pending()).toHaveLength(1);
  });

  it('leaves a row of another repository, and a pending row of another unit kind, as they are', async () => {
    const s = await setup({ column: column(ours, false), sync: { base: baseOf(BASE) } });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    const other = s.fake.insert(schema.projectStateConflicts, {
      repositoryId: OTHER,
      unit: FRAMEWORK,
      base: { v: 'a' },
      local: { v: 'b' },
      incoming: { v: 'c' },
    });
    const setting = s.fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: 'settings/rtk-enabled.json',
      base: { v: true },
      local: { v: true },
      incoming: { v: false },
    });
    await s.putRecord(record(BASE));

    await s.run();

    expect(s.pending(OTHER)).toHaveLength(1);
    expect(s.pending(OTHER)[0]!.id).toBe(other.id);
    expect(s.pending().map((r) => r.id)).toEqual([setting.id]);
  });

  it('writes no row when the record is refused or the sync is deferred', async () => {
    const refused = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await refused.put(`${STATE_DIR}/project/render.json`, '<<<<<<< HEAD\n{}\n>>>>>>> x\n');
    expect((await refused.run()).outcome).toBe('refused');
    expect(refused.conflictRows()).toEqual([]);

    const deferred = await setup({ column: column(ours), sync: { base: baseOf(BASE) } });
    await deferred.putRecord(record(theirs));
    deferred.addTask('onboarding_upgrade', 'running');
    expect((await deferred.run()).outcome).toBe('deferred');
    expect(deferred.conflictRows()).toEqual([]);
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
      render({
        customAgentSpecs: [
          { id: 'billing-expert', description: 'Knows the billing module', deep: nest(levels) },
        ],
      }),
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
        cliTargets: ['claude-code'],
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
        expect(json(s.columnOf())).toEqual({ ...BASE, cliTargets: [], rtkChoiceRecorded: false });
      },
    );
  });

  it.each(['onboarding', 'onboarding_upgrade'])(
    'does not defer for a dead %s task, whatever status it keeps',
    async (type) => {
      const s = await setup();
      await s.putRecord(record(BASE));
      s.fake.insert(schema.tasks, {
        id: randomUUID(),
        userId: USER,
        repositoryId: REPO,
        type,
        status: 'running',
        title: 't',
        deadAt: new Date(),
      });

      expect((await s.run()).outcome).toBe('applied');
    },
  );

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
    expect(json(s.columnOf())).toEqual({ ...BASE, cliTargets: [], rtkChoiceRecorded: false });
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
  it('refuses a checkout that moved while waiting, even without a git-operation guard', async () => {
    const s = await setup(synced(BASE));
    await s.putRecord(record(TEAM));
    s.hook.onLock = () => s.putRecord(record(LATER));

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('superseded');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(json(s.columnOf())).toEqual(column(BASE));
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseOf(BASE));
    expect(
      JSON.parse(await readFile(join(s.root, STATE_DIR, 'project/render.json'), 'utf8')),
    ).toEqual(LATER);
  });

  it('reports superseded and writes nothing when a writer recorded a newer base', async () => {
    const s = await setup(synced(BASE));
    await s.putRecord(record(TEAM));
    s.hook.onLock = () => {
      s.patchColumn(column(LATER));
      s.patchBase(baseOf(LATER));
    };

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('superseded');
    expect(trace.filter(isWrite).every((e) => e === 'insert project_state_sync')).toBe(true);
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
      s.putRecordSync({ ...record(LATER), cli: ['claude-code'] });
      s.patchColumn(promoted(column(LATER)));
      s.patchBase({ ...record(LATER), cli: ['claude-code'] });
    };

    const { outcome, trace } = await s.run();

    expect(['unchanged', 'superseded']).toContain(outcome);
    expect(trace.filter(isWrite).every((e) => e === 'insert project_state_sync')).toBe(true);
    expect(json(s.columnOf())).toEqual(promoted(column(LATER)));
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(
      json(normalizeProjectState({ ...record(LATER), cli: ['claude-code'] })),
    );
  });

  it('holds rather than importing a writer’s uncommitted filesystem output', async () => {
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
    s.hook.onWrite = async (table) => {
      if (table !== schema.repositories) return;
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
      expect(settled).toBe(true);

      release();
      const [, result] = await Promise.all([writer, syncing]);

      expect(result.outcome).toBe('held');
      expect(json(s.columnOf())).toEqual(promoted({ ...contextA(), rtkChoiceRecorded: true }));
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
      'an empty state directory',
      async (s) => {
        await mkdir(join(s.root, STATE_DIR), { recursive: true });
      },
    ],
    [
      'only empty state subdirectories',
      async (s) => {
        await mkdir(join(s.root, STATE_DIR, 'project'), { recursive: true });
        await mkdir(join(s.root, STATE_DIR, 'settings'), { recursive: true });
      },
    ],
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

describe('refreshProjectState: an empty state tree', () => {
  it('rebuilds the record instead of leaving a read error on the dirty outbox row', async () => {
    const s = await setup(synced(BASE));
    s.fake.patch(schema.repositories, REPO, { storagePath: s.root });
    s.fake.insert(schema.projectStateOutbox, {
      repositoryId: REPO,
      revision: 1,
      writtenRevision: 0,
    });
    await mkdir(join(s.root, STATE_DIR, 'settings'), { recursive: true });

    expect(await refreshProjectState(s.fake.db as unknown as Database, REPO)).toBe(true);

    expect(
      JSON.parse(await readFile(join(s.root, STATE_DIR, 'project/render.json'), 'utf8')),
    ).toEqual(BASE);
    expect(JSON.parse(await readFile(join(s.root, STATE_DIR, 'format.json'), 'utf8'))).toEqual(
      JSON.parse(formatText()),
    );
    expect(s.fake.rows(schema.projectStateOutbox)).toMatchObject([
      { revision: 2, lastError: null },
    ]);
    expect(s.pending()).toEqual([]);
  });
});

describe('syncProjectStateFromCheckout: CLI members and bundle descriptors', () => {
  it('imports the CLI set and keeps unmerged bundle descriptors in the base', async () => {
    const s = await setup();
    const bundles = [{ source: 'git:https://example.com/bundle.git', name: 'bundle' }];
    await s.putRecord({ ...record(BASE), cli: ['claude-code', 'codex'], bundles });

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    const base = json(s.syncRow()?.baseSnapshot) as Json;
    expect(base.cli).toEqual(['claude-code', 'codex']);
    expect(s.columnOf()).toMatchObject({ cliTargets: ['claude-code', 'codex'] });
    expect(base.bundles).toEqual(bundles);
  });
});

const settingsOf = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.assign(Object.create(null) as Record<string, unknown>, values);
const envOf = (name: string, confirmed: Json = {}) => ({
  envDetectData: { project: { name } },
  confirmedValues: confirmed,
});
const repoRow = (s: Setup): Json => s.fake.rows(schema.repositories).find((r) => r.id === REPO)!;
const withSettings = (
  settings: Record<string, unknown>,
  environment: ProjectStateRecord['environment'] = null,
): ProjectStateRecord => ({ ...record(BASE), settings: settingsOf(settings), environment });
const syncBase = (
  settings: Record<string, unknown>,
  environment: ProjectStateRecord['environment'] = null,
): unknown => json(normalizeProjectState(withSettings(settings, environment)));
const dirtyMarks = (s: Setup) => s.fake.rows(schema.projectStateOutbox);

describe('syncProjectStateFromCheckout: the portable settings and the environment', () => {
  it('first sync: the checkout wins over a column nobody chose, and the next sync writes nothing', async () => {
    const s = await setup();
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true, reviewDimensions: null });
    await s.putRecord(
      withSettings(
        { 'rtk-enabled': false, 'review-dimensions': ['security'] },
        envOf('acme', { a: 1 }),
      ),
    );

    const first = await s.run();

    expect(first.outcome).toBe('applied');
    const row = repoRow(s);
    expect(row.rtkEnabled).toBe(false);
    expect(row.reviewDimensions).toEqual(['security']);
    expect(json(row.onboardingEnvironment)).toEqual({
      schemaVersion: 1,
      ...envOf('acme', { a: 1 }),
    });
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(
      syncBase(
        { 'rtk-enabled': false, 'review-dimensions': ['security'] },
        envOf('acme', { a: 1 }),
      ),
    );
    expect(dirtyMarks(s)).toEqual([]);
    const before = s.dump();

    const second = await s.run();

    expect(second.outcome).toBe('unchanged');
    expect(second.trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });

  it('first sync: a set joins what both installs hold, the other settings take the checkout', async () => {
    const s = await setup();
    s.fake.patch(schema.repositories, REPO, { scopeExcludeGlobs: ['mine'], rtkVersion: '0.1.0' });
    await s.putRecord(withSettings({ 'scope-exclude-globs': ['theirs'], 'rtk-version': '0.42.4' }));

    await s.run();

    expect(repoRow(s).scopeExcludeGlobs).toEqual(['mine', 'theirs']);
    expect(repoRow(s).rtkVersion).toBe('0.42.4');
  });

  it('a base an earlier release wrote, holding no setting, merges the settings as no base too', async () => {
    const s = await setup({ column: column(BASE), sync: { base: baseOf(BASE) } });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    await s.putRecord(withSettings({ 'rtk-enabled': false }));

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(repoRow(s).rtkEnabled).toBe(false);
    expect(s.pending()).toEqual([]);
  });

  it('a change the other install made reaches the column, and a change of ours stays', async () => {
    const base = syncBase({ 'scope-exclude-globs': ['a'], 'rtk-version': '0.1.0' });
    const s = await setup({ column: column(BASE), sync: { base } });
    s.fake.patch(schema.repositories, REPO, {
      scopeExcludeGlobs: ['a', 'mine'],
      rtkVersion: '0.1.0',
      rtkEnabled: null,
    });
    await s.putRecord(
      withSettings({ 'scope-exclude-globs': ['a', 'theirs'], 'rtk-version': '0.2.0' }),
    );

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(repoRow(s).scopeExcludeGlobs).toEqual(['a', 'mine', 'theirs']);
    expect(repoRow(s).rtkVersion).toBe('0.2.0');
    expect(s.pending()).toEqual([]);
    expect(dirtyMarks(s)).toHaveLength(1);
  });

  it('a setting both installs set differently is one pending question; ours stands, the base is kept', async () => {
    const base = syncBase({ 'lsp-servers': ['vtsls'] });
    const s = await setup({ column: column(BASE), sync: { base } });
    s.fake.patch(schema.repositories, REPO, { lspServers: ['pyright'], rtkEnabled: null });
    await s.putRecord(withSettings({ 'lsp-servers': ['gopls'] }));

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('conflict');
    expect(repoRow(s).lspServers).toEqual(['pyright']);
    const rows = s.pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      unit: 'settings/lsp-servers.json',
      base: { v: ['vtsls'] },
      local: { v: ['pyright'] },
      incoming: { v: ['gopls'] },
    });
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(base);
    expect(s.syncRow()?.lastError ?? null).toBeNull();
    expect(dirtyMarks(s)).toMatchObject([{ repositoryId: REPO, revision: 1, writtenRevision: 0 }]);
    expect(writesTo(trace, 'repositories')).toEqual(['update repositories']);

    const again = await s.run();
    expect(again.outcome).toBe('conflict');
    expect(again.trace.filter(isWrite)).toEqual([]);
  });

  it('a pending setting question converges when the sides come to agree', async () => {
    const base = syncBase({ 'lsp-servers': ['vtsls'] });
    const s = await setup({ column: column(BASE), sync: { base } });
    s.fake.patch(schema.repositories, REPO, { lspServers: ['pyright'], rtkEnabled: null });
    await s.putRecord(withSettings({ 'lsp-servers': ['gopls'] }));
    await s.run();
    s.fake.patch(schema.repositories, REPO, { lspServers: ['gopls'] });

    const { outcome } = await s.run();

    expect(outcome).toBe('unchanged');
    expect(s.pending()).toEqual([]);
    expect(s.conflictRows().map((r) => r.resolution)).toEqual(['converged']);
  });

  it('an environment key both installs changed is one question per key; the other key is taken', async () => {
    const base = syncBase({}, envOf('acme', { a: 1 }));
    const s = await setup({ column: column(BASE), sync: { base } });
    s.fake.patch(schema.repositories, REPO, {
      rtkEnabled: null,
      onboardingEnvironment: { schemaVersion: 1, ...envOf('mine', { a: 1 }) },
    });
    await s.putRecord(withSettings({}, { ...envOf('theirs', { a: 2 }) }));

    const { outcome } = await s.run();

    expect(outcome).toBe('conflict');
    expect(s.pending().map((r) => r.unit)).toEqual(['project/environment.json#envDetectData']);
    expect(json(repoRow(s).onboardingEnvironment)).toEqual({
      schemaVersion: 1,
      ...envOf('mine', { a: 2 }),
    });
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(base);
  });

  it('strips the prompt-only fields of an older release from an imported environment', async () => {
    const s = await setup();
    await s.putRecord(
      withSettings(
        {},
        { envDetectData: { project: { name: 'acme' }, __digest: 'x' }, confirmedValues: {} },
      ),
    );

    await s.run();

    expect(json(repoRow(s).onboardingEnvironment)).toEqual({ schemaVersion: 1, ...envOf('acme') });
  });

  it('normalises a value as the routes do: unknown servers, unknown dimensions, managed globs', async () => {
    const s = await setup();
    await s.putRecord(
      withSettings({
        'lsp-servers': ['vtsls', 'made-up', 'vtsls'],
        'lsp-server-versions': { vtsls: ' 1.0.0 ', 'made-up': '2', pyright: '' },
        'review-dimensions': ['security', 'nope'],
        'scope-exclude-globs': ['/vendor/', 'b', '', 'a'],
      }),
    );

    await s.run();

    const row = repoRow(s);
    expect(row.lspServers).toEqual(['vtsls']);
    expect(row.lspServerVersions).toEqual({ vtsls: '1.0.0' });
    expect(row.reviewDimensions).toEqual(['security']);
    expect(row.scopeExcludeGlobs).toEqual(['a', 'b', 'vendor']);
  });

  it('refuses an invalid value for that setting alone: the column stands and the base keeps the old value', async () => {
    const base = syncBase({ 'review-dimensions': ['security'] });
    const s = await setup({ column: column(BASE), sync: { base } });
    s.fake.patch(schema.repositories, REPO, {
      reviewDimensions: ['security'],
      rtkEnabled: null,
    });
    await s.putRecord(withSettings({ 'review-dimensions': ['nope'], 'rtk-version': '9.9.9' }));

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(repoRow(s).reviewDimensions).toEqual(['security']);
    expect(repoRow(s).rtkVersion).toBe('9.9.9');
    expect(s.pending()).toEqual([]);
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(
      syncBase({ 'review-dimensions': ['security'], 'rtk-version': '9.9.9' }),
    );
    expect(dirtyMarks(s)).toHaveLength(1);
  });

  it('an absent scope list leaves the column alone and asks the writer to bring the file back', async () => {
    const base = syncBase({ 'scope-exclude-globs': ['a'] });
    const s = await setup({ column: column(BASE), sync: { base } });
    s.fake.patch(schema.repositories, REPO, { scopeExcludeGlobs: ['a'], rtkEnabled: null });
    await s.putRecord(withSettings({}));

    await s.run();

    expect(repoRow(s).scopeExcludeGlobs).toEqual(['a']);
    expect(dirtyMarks(s)).toHaveLength(1);
  });

  it('a setting the other install unset is unset here, where nobody changed it', async () => {
    const base = syncBase({ 'rtk-version': '0.1.0' });
    const s = await setup({ column: column(BASE), sync: { base } });
    s.fake.patch(schema.repositories, REPO, { rtkVersion: '0.1.0', rtkEnabled: null });
    await s.putRecord(withSettings({}));

    await s.run();

    expect(repoRow(s).rtkVersion ?? null).toBeNull();
  });

  describe('an RTK choice this install never recorded', () => {
    const RTK_FILE = join(STATE_DIR, 'settings/rtk-enabled.json');
    const unrecorded = (base: unknown = baseOf(BASE)): Seed => ({
      column: column(BASE, false),
      sync: { base },
    });

    it('adopts the other install’s value, with no conflict, and records it as the choice', async () => {
      const s = await setup(unrecorded());
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await s.putRecord(withSettings({ 'rtk-enabled': false }));

      const { outcome } = await s.run();

      expect(outcome).toBe('applied');
      expect(repoRow(s).rtkEnabled).toBe(false);
      expect((json(s.columnOf()) as Json).rtkChoiceRecorded).toBe(true);
      expect(s.pending()).toEqual([]);
      expect((json(s.syncRow()?.baseSnapshot) as Json).settings).toEqual({ 'rtk-enabled': false });
      expect(dirtyMarks(s)).toMatchObject([
        { repositoryId: REPO, revision: 1, writtenRevision: 0 },
      ]);
    });

    it('then the next writer, the install now recorded, leaves the other install’s file as it is', async () => {
      const s = await setup(unrecorded());
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await s.putRecord(withSettings({ 'rtk-enabled': false }));
      await s.run();
      const before = await readFile(join(s.root, RTK_FILE), 'utf8');

      await s.write(contextA(), true);

      expect(await readFile(join(s.root, RTK_FILE), 'utf8')).toBe(before);
      expect(JSON.parse(before)).toBe(false);
      expect((json(s.syncRow()?.baseSnapshot) as Json).settings).toEqual({ 'rtk-enabled': false });
    });

    it('a later rollback that writes the column unrecorded again leaves the file as it is', async () => {
      const s = await setup(unrecorded());
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await s.putRecord(withSettings({ 'rtk-enabled': false }));
      await s.run();
      const before = await readFile(join(s.root, RTK_FILE), 'utf8');

      await s.write(contextA(), false);

      expect(await readFile(join(s.root, RTK_FILE), 'utf8')).toBe(before);
    });

    it('leaves the default alone when the record has no file, and asks for none', async () => {
      const s = await setup(unrecorded());
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await s.putRecord(withSettings({}));

      const { trace } = await s.run();

      expect(repoRow(s).rtkEnabled).toBe(true);
      expect(writesTo(trace, 'repositories')).toEqual(['update repositories']);
      expect(dirtyMarks(s)).toMatchObject([
        { repositoryId: REPO, revision: 1, writtenRevision: 0 },
      ]);
    });

    it('a recorded choice is written as before: the file and the base hold it', async () => {
      const s = await setup({ column: column(BASE, true), sync: { base: baseOf(BASE) } });
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await s.write(contextA(), true);

      expect(JSON.parse(await readFile(join(s.root, RTK_FILE), 'utf8'))).toBe(true);
      expect((json(s.syncRow()?.baseSnapshot) as Json).settings).toEqual({ 'rtk-enabled': true });
    });

    describe('that a person has since switched on this install', () => {
      const SWITCHED = new Date(1000);
      const OTHER_SETTING = { 'rtk-version': '0.1.0' };
      const rtkOf = async (s: Setup): Promise<unknown> =>
        JSON.parse(await readFile(join(s.root, RTK_FILE), 'utf8')) as unknown;
      const switchedOn = (s: Setup) =>
        s.fake.patch(schema.repositories, REPO, {
          rtkEnabled: true,
          rtkVersion: '0.1.0',
          rtkChoiceMadeAt: SWITCHED,
        });
      const BASES: [string, () => unknown][] = [
        ['a base that holds other settings', () => syncBase(OTHER_SETTING)],
        ['a base that holds no setting and no environment', () => baseOf(BASE)],
      ];

      it.each(BASES)(
        'keeps the switch over the other install’s value, with no conflict, over %s',
        async (_name, base) => {
          const s = await setup({ column: column(BASE, false), sync: { base: base() } });
          switchedOn(s);
          await s.putRecord(withSettings({ ...OTHER_SETTING, 'rtk-enabled': false }));

          const { outcome } = await s.run();

          expect(outcome).toBe('applied');
          expect(repoRow(s).rtkEnabled).toBe(true);
          expect(s.pending()).toEqual([]);
          expect(dirtyMarks(s)).toHaveLength(1);
        },
      );

      it('takes the record’s value on a first import with no sync row, as for every setting', async () => {
        const s = await setup({ column: column(BASE, false) });
        switchedOn(s);
        await s.putRecord(withSettings({ ...OTHER_SETTING, 'rtk-enabled': false }));

        const { outcome } = await s.run();

        expect(outcome).toBe('applied');
        expect(repoRow(s).rtkEnabled).toBe(false);
        expect(s.pending()).toEqual([]);
      });

      it('keeps it through a second sync that runs before the writer does', async () => {
        const s = await setup({
          column: column(BASE, false),
          sync: { base: syncBase(OTHER_SETTING) },
        });
        switchedOn(s);
        await s.putRecord(withSettings({ ...OTHER_SETTING, 'rtk-enabled': false }));
        await s.run();

        const { outcome } = await s.run();

        expect(outcome).toBe('unchanged');
        expect(repoRow(s).rtkEnabled).toBe(true);
        expect(s.pending()).toEqual([]);
      });

      it('asks the writer for the file when the record holds none', async () => {
        const s = await setup({
          column: column(BASE, false),
          sync: { base: syncBase(OTHER_SETTING) },
        });
        switchedOn(s);
        await s.putRecord(withSettings(OTHER_SETTING));

        await s.run();

        expect(repoRow(s).rtkEnabled).toBe(true);
        expect(dirtyMarks(s)).toHaveLength(1);
      });

      it('then the writer brings the file to the switch, and a later change on the other install merges as any other', async () => {
        const s = await setup({
          column: column(BASE, false),
          sync: { base: syncBase(OTHER_SETTING) },
        });
        switchedOn(s);
        await s.putRecord(withSettings({ ...OTHER_SETTING, 'rtk-enabled': false }));
        await s.run();

        await s.write(contextA(), false);

        expect(await rtkOf(s)).toBe(true);
        expect((json(s.syncRow()?.baseSnapshot) as Json).settings).toMatchObject({
          'rtk-enabled': true,
        });
        await s.put(RTK_FILE, 'false\n');

        const { outcome } = await s.run();

        expect(outcome).toBe('applied');
        expect(repoRow(s).rtkEnabled).toBe(false);
        expect(s.pending()).toEqual([]);
      });

      it.each([
        ['a person switched RTK here', SWITCHED, { 'rtk-enabled': false }],
        ['nobody did', null, { 'rtk-enabled': false }],
      ])(
        'a rebase onto the record keeps the value in the base when %s',
        async (_name, rtkChoiceMadeAt, want) => {
          const s = await setup({ column: column(BASE, false), sync: { base: baseOf(BASE) } });
          s.fake.patch(schema.repositories, REPO, { rtkEnabled: true, rtkChoiceMadeAt });
          await s.putRecord(withSettings({ 'rtk-enabled': false }));

          await s.rebase();

          expect((json(s.syncRow()?.baseSnapshot) as Json).settings).toEqual(want);
        },
      );

      it('still asks when the choice is recorded in the column but nobody switched it, and the base never held it', async () => {
        const s = await setup({
          column: column(BASE, true),
          sync: { base: syncBase(OTHER_SETTING) },
        });
        s.fake.patch(schema.repositories, REPO, { rtkEnabled: true, rtkVersion: '0.1.0' });
        await s.putRecord(withSettings({ ...OTHER_SETTING, 'rtk-enabled': false }));

        const { outcome } = await s.run();

        expect(outcome).toBe('conflict');
        expect(s.pending().map((r) => r.unit)).toEqual(['settings/rtk-enabled.json']);
        expect(repoRow(s).rtkEnabled).toBe(true);
      });
    });
  });

  it('an imported RTK-off closes the pending RTK question as converged', async () => {
    const s = await setup();
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: 'settings/rtk-enabled.json',
      base: { v: true },
      local: { v: true },
      incoming: { v: false },
    });
    await s.putRecord(withSettings({ 'rtk-enabled': false }));

    await s.run();

    expect(repoRow(s).rtkEnabled).toBe(false);
    expect(s.pending()).toEqual([]);
    expect(s.conflictRows().map((r) => r.resolution)).toEqual(['converged']);
  });

  it('converges an RTK question once the install has recorded a choice', async () => {
    const base = syncBase({ 'rtk-enabled': true });
    const s = await setup({ column: column(BASE), sync: { base } });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: 'settings/rtk-enabled.json',
      base: { v: true },
      local: { v: true },
      incoming: { v: false },
    });
    await s.putRecord(withSettings({ 'rtk-enabled': true }));

    await s.run();

    expect(s.pending()).toEqual([]);
    expect(s.conflictRows().map((r) => r.resolution)).toEqual(['converged']);
  });

  it('keeps a settings file of a name this release does not know out of the base', async () => {
    const s = await setup();
    await s.putRecord(withSettings({ 'rtk-version': '0.1.0', 'from-the-future': 1 }));

    await s.run();

    expect((json(s.syncRow()?.baseSnapshot) as Json).settings).toEqual({ 'rtk-version': '0.1.0' });
  });
});

describe('syncProjectStateFromCheckout: invalid RTK ownership', () => {
  it.each([false, true])(
    'repairs invalid RTK from the recorded choice %s through the writer',
    async (chosen) => {
      const s = await setup({
        column: column(BASE, true),
        sync: { base: syncBase({ 'rtk-enabled': chosen }) },
      });
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: chosen });
      await s.putRecord(withSettings({ 'rtk-enabled': 'yes' }));
      await s.run();
      expect(dirtyMarks(s)).toHaveLength(1);
      await s.write({ ...contextA(), rtkEnabled: chosen }, true);
      expect(
        JSON.parse(await readFile(join(s.root, STATE_DIR, 'settings/rtk-enabled.json'), 'utf8')),
      ).toBe(chosen);
      expect(repoRow(s).rtkEnabled).toBe(chosen);
      expect(s.pending()).toEqual([]);
    },
  );

  it('owns no RTK file to repair before a choice was recorded', async () => {
    const s = await setup({ column: column(BASE, false), sync: { base: baseOf(BASE) } });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    await s.putRecord(withSettings({ 'rtk-enabled': 'yes' }));
    await s.run();
    await s.write(contextA(), false);
    expect(
      JSON.parse(await readFile(join(s.root, STATE_DIR, 'settings/rtk-enabled.json'), 'utf8')),
    ).toBe('yes');
    expect((json(s.columnOf()) as Json).rtkChoiceRecorded).toBe(false);
    expect(repoRow(s).rtkEnabled).toBe(true);
    expect(s.pending()).toEqual([]);
    await s.run();
    expect(dirtyMarks(s)).toHaveLength(1);
  });
});

describe('syncProjectStateFromCheckout: RTK question lifecycle', () => {
  it('closes a pending question when it adopts the teammate’s RTK-on choice', async () => {
    const s = await setup({ column: column(BASE, false), sync: { base: baseOf(BASE) } });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: 'settings/rtk-enabled.json',
      base: { v: true },
      local: { v: true },
      incoming: { v: false },
    });
    await s.putRecord(withSettings({ 'rtk-enabled': true }));

    await s.run();

    expect((json(s.columnOf()) as Json).rtkChoiceRecorded).toBe(true);
    expect(repoRow(s).rtkEnabled).toBe(true);
    expect(s.pending()).toEqual([]);
    expect(s.conflictRows().map((r) => r.resolution)).toEqual(['converged']);
  });

  it('rolls back choice adoption and question convergence when the transaction cannot commit', async () => {
    const s = await setup({ column: column(BASE, false), sync: { base: baseOf(BASE) } });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: 'settings/rtk-enabled.json',
      base: { v: true },
      local: { v: true },
      incoming: { v: false },
    });
    await s.putRecord(withSettings({ 'rtk-enabled': true }));
    const before = s.dump();
    s.hook.onCommit = async () => {
      expect((json(s.columnOf()) as Json).rtkChoiceRecorded).toBe(true);
      expect(s.pending()).toEqual([]);
      throw new Error('commit refused');
    };

    await expect(s.run()).rejects.toThrow('commit refused');

    expect(s.dump()).toEqual(before);
    expect(s.pending()).toHaveLength(1);
  });

  it('raises the existing question after importing tooling that carries an unchosen RTK-off', async () => {
    const s = await setup({ column: column(BASE, false), sync: { base: baseOf(BASE) } });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    await s.putRecord(withSettings({ 'onboarding-tooling': { rtkEnabled: false } }));

    await s.run();

    expect((json(s.columnOf()) as Json).rtkChoiceRecorded).toBe(false);
    expect(repoRow(s).rtkEnabled).toBe(true);
    expect(s.pending()).toMatchObject([
      {
        unit: 'settings/rtk-enabled.json',
        base: { v: true },
        local: { v: true },
        incoming: { v: false },
      },
    ]);
    const [row] = s.pending();
    await s.run();
    expect(s.pending().map((r) => r.id)).toEqual([row!.id]);
  });
});

describe('syncProjectStateFromCheckout: an RTK choice comes only from a record that carries one', () => {
  const RTK_REL = 'settings/rtk-enabled.json';
  const treeHasRtkFile = async (s: Setup) =>
    Object.keys(await treeOf(s.root)).includes(`${STATE_DIR}/${RTK_REL}`);
  const writeColumn = (s: Setup) =>
    writeProjectStateColumn(s.fake.db as unknown as Database, {
      repositoryId: REPO,
      repoPath: s.root,
      column: renderContextColumnSchema.parse(s.columnOf()),
    });
  const flagOf = (s: Setup) => (json(s.columnOf()) as Json).rtkChoiceRecorded;

  describe('a column the sync creates', () => {
    it('is flag false when the record holds no file, and the writer then emits no default', async () => {
      const s = await setup();
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await s.putRecord(record(BASE));

      const { outcome } = await s.run();

      expect(outcome).toBe('applied');
      expect(json(s.columnOf())).toEqual({ ...BASE, cliTargets: [], rtkChoiceRecorded: false });
      expect(repoRow(s).rtkEnabled).toBe(true);
      expect(await treeHasRtkFile(s)).toBe(false);

      await writeColumn(s);

      expect(await treeHasRtkFile(s)).toBe(false);
    });

    it.each([
      [false, true],
      [true, false],
    ])(
      'is flag true when the record holds %s: the value is taken, the base holds it, nothing is asked for',
      async (file, was) => {
        const s = await setup();
        s.fake.patch(schema.repositories, REPO, { rtkEnabled: was });
        await s.putRecord(withSettings({ 'rtk-enabled': file }));

        const first = await s.run();

        expect(first.outcome).toBe('applied');
        expect(json(s.columnOf())).toEqual({ ...BASE, cliTargets: [], rtkChoiceRecorded: true });
        expect(repoRow(s).rtkEnabled).toBe(file);
        expect(json(s.syncRow()?.baseSnapshot)).toEqual(syncBase({ 'rtk-enabled': file }));
        expect(dirtyMarks(s)).toEqual([]);
        expect(s.pending()).toEqual([]);

        const second = await s.run();

        expect(second.outcome).toBe('unchanged');
        expect(second.trace.filter(isWrite)).toEqual([]);
      },
    );

    it.each([['"yes"\n'], ['1\n']])(
      'is flag false when the file holds %j, and the default stays',
      async (text) => {
        const s = await setup();
        s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
        await s.putRecord(record(BASE));
        await s.put(`${STATE_DIR}/${RTK_REL}`, text);

        await s.run();

        expect(flagOf(s)).toBe(false);
        expect(repoRow(s).rtkEnabled).toBe(true);
        expect((json(s.syncRow()?.baseSnapshot) as Json).settings).not.toHaveProperty(
          'rtk-enabled',
        );
      },
    );

    it.each([
      [false, false],
      [true, true],
    ])(
      'a column of flag %s, written with RTK on, leaves the file out or puts it in: %s',
      async (flag, emitted) => {
        const s = await setup({ column: { ...BASE, rtkChoiceRecorded: flag } });
        s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
        await s.putRecord(record(BASE));

        await writeColumn(s);

        expect(await treeHasRtkFile(s)).toBe(emitted);
      },
    );

    it('is flag true when a stamp is set and the record holds a valid file', async () => {
      const s = await setup();
      s.fake.patch(schema.repositories, REPO, {
        rtkEnabled: true,
        rtkChoiceMadeAt: new Date(1000),
      });
      await s.putRecord(withSettings({ 'rtk-enabled': false }));

      await s.run();

      expect(flagOf(s)).toBe(true);
    });
  });

  describe('a column that exists, flag false, with no stamp', () => {
    const unrecorded = (): Seed => ({ column: column(BASE, false), sync: { base: baseOf(BASE) } });

    it.each([
      [false, true],
      [true, false],
    ])(
      'adopts a record that holds %s over this install’s %s, keeping every other field',
      async (file, was) => {
        const s = await setup(unrecorded());
        s.fake.patch(schema.repositories, REPO, { rtkEnabled: was });
        await s.putRecord(withSettings({ 'rtk-enabled': file }));
        const before = json(s.columnOf()) as Json;

        const first = await s.run();

        expect(first.outcome).toBe('applied');
        expect(json(s.columnOf())).toEqual(promoted({ ...before, rtkChoiceRecorded: true }));
        expect(repoRow(s).rtkEnabled).toBe(file);
        expect(json(s.syncRow()?.baseSnapshot)).toEqual(syncBase({ 'rtk-enabled': file }));
        expect(s.pending()).toEqual([]);
        expect(dirtyMarks(s)).toMatchObject([
          { repositoryId: REPO, revision: 1, writtenRevision: 0 },
        ]);
        expectWritesUnderTheLock(first.trace);

        const second = await s.run();

        expect(second.outcome).toBe('unchanged');
        expect(second.trace.filter(isWrite)).toEqual([]);
      },
    );

    it.each([false, true])(
      'adopts a record that holds %s that this install already agrees with: only the flag moves',
      async (file) => {
        const s = await setup(unrecorded());
        s.fake.patch(schema.repositories, REPO, { rtkEnabled: file });
        await s.putRecord(withSettings({ 'rtk-enabled': file }));
        const before = json(s.columnOf()) as Json;

        const first = await s.run();

        expect(first.outcome).toBe('applied');
        expect(json(s.columnOf())).toEqual(promoted({ ...before, rtkChoiceRecorded: true }));
        expect(repoRow(s).rtkEnabled).toBe(file);
        expect(json(s.syncRow()?.baseSnapshot)).toEqual(syncBase({ 'rtk-enabled': file }));
        expect(s.pending()).toEqual([]);
        expectWritesUnderTheLock(first.trace);

        const second = await s.run();

        expect(second.outcome).toBe('unchanged');
        expect(second.trace.filter(isWrite)).toEqual([]);
      },
    );

    it('changes nothing when the record holds no file', async () => {
      const s = await setup(unrecorded());
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await s.putRecord(withSettings({}));
      const before = json(s.columnOf());

      const { trace } = await s.run();

      expect(json(s.columnOf())).toEqual(promoted(before as Json));
      expect(flagOf(s)).toBe(false);
      expect(repoRow(s).rtkEnabled).toBe(true);
      expect(writesTo(trace, 'repositories')).toEqual(['update repositories']);
      expect(dirtyMarks(s)).toMatchObject([
        { repositoryId: REPO, revision: 1, writtenRevision: 0 },
      ]);
    });

    it('does not adopt a file that holds an invalid value', async () => {
      const s = await setup(unrecorded());
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
      await s.putRecord(record(BASE));
      await s.put(`${STATE_DIR}/${RTK_REL}`, '"yes"\n');

      const { trace } = await s.run();

      expect(flagOf(s)).toBe(false);
      expect(repoRow(s).rtkEnabled).toBe(true);
      expect(writesTo(trace, 'repositories')).toEqual(['update repositories']);
    });

    it('leaves a switch a person made here as it is: no flag move, this install’s value wins', async () => {
      const s = await setup({
        column: column(BASE, false),
        sync: { base: syncBase({ 'rtk-version': '0.1.0' }) },
      });
      s.fake.patch(schema.repositories, REPO, {
        rtkEnabled: true,
        rtkVersion: '0.1.0',
        rtkChoiceMadeAt: new Date(1000),
      });
      await s.putRecord(withSettings({ 'rtk-version': '0.1.0', 'rtk-enabled': false }));

      await s.run();

      expect(flagOf(s)).toBe(false);
      expect(repoRow(s).rtkEnabled).toBe(true);
    });
  });

  it('keeps asking when the column is recorded, nobody switched it and the base never held the value', async () => {
    const s = await setup({
      column: column(BASE, true),
      sync: { base: syncBase({ 'rtk-version': '0.1.0' }) },
    });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true, rtkVersion: '0.1.0' });
    await s.putRecord(withSettings({ 'rtk-version': '0.1.0', 'rtk-enabled': false }));

    const { outcome } = await s.run();

    expect(outcome).toBe('conflict');
    expect(s.pending().map((r) => r.unit)).toEqual(['settings/rtk-enabled.json']);
  });

  it.each([
    ['this install is unrecorded', null],
    ['a person switched RTK here', new Date(1000)],
  ])(
    'a rebase onto a record with a valid file puts it in the base when %s',
    async (_name, stamp) => {
      const s = await setup({ column: column(BASE, false), sync: { base: baseOf(BASE) } });
      s.fake.patch(schema.repositories, REPO, { rtkEnabled: true, rtkChoiceMadeAt: stamp });
      await s.putRecord(withSettings({ 'rtk-enabled': false }));

      await s.rebase();

      expect((json(s.syncRow()?.baseSnapshot) as Json).settings).toEqual({ 'rtk-enabled': false });
    },
  );
});

describe('syncProjectStateFromCheckout: the onboarding tooling unit', () => {
  const FOREIGN_MCP = JSON.stringify({ mcpServers: { evil: { command: 'curl', args: ['x'] } } });
  const UNIT = { ragMode: 'internal', embeddingModel: 'nomic-embed-text' };
  const toolingColumn = (tooling: Json) => ({ schemaVersion: 1, tooling });
  const unitBase = (unit: Json) => ({ 'onboarding-tooling': unit });

  it('fills an empty column from the record, keeps the unit in the base, and asks no question', async () => {
    const s = await setup();
    await s.putRecord(withSettings(unitBase(UNIT)));

    const first = await s.run();

    expect(first.outcome).toBe('applied');
    expect(json(repoRow(s).onboardingTooling)).toEqual(toolingColumn(UNIT));
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(syncBase(unitBase(UNIT)));
    expect(s.conflictRows()).toEqual([]);
    expect(dirtyMarks(s)).toEqual([]);
    const before = s.dump();

    const second = await s.run();

    expect(second.outcome).toBe('unchanged');
    expect(second.trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });

  it('holds every imported MCP server until a person here accepts it', async () => {
    const s = await setup();
    await s.putRecord(withSettings(unitBase({ ...UNIT, mcpSettingsJson: FOREIGN_MCP })));

    await s.run();

    const stored = json(repoRow(s).onboardingTooling) as { tooling: Json };
    expect(stored.tooling.mcpSettingsJson).toBeUndefined();
    expect(stored.tooling.importedMcpSettingsJson).toBe(FOREIGN_MCP);
    expect(stored.tooling.importedMcpServerNames).toEqual(['evil']);
    expect(pendingImportedMcpServers(repoRow(s).onboardingTooling)).toEqual(['evil']);
    expect(dirtyMarks(s)).toEqual([]);
  });

  it('imports Haive’s own servers as the list the runtime reads', async () => {
    const s = await setup();
    await s.putRecord(withSettings(unitBase({ ...UNIT, mcpSettingsJson: '{"mcpServers":{}}' })));

    await s.run();

    const stored = json(repoRow(s).onboardingTooling) as { tooling: Json };
    expect(stored.tooling.mcpSettingsJson).toBe('{"mcpServers":{}}');
    expect(stored.tooling.importedMcpSettingsJson).toBeUndefined();
  });

  it('drops a machine-local key a record carries, and an acceptance it claims', async () => {
    const s = await setup();
    await s.putRecord(
      withSettings(
        unitBase({
          ...UNIT,
          ollamaUrl: 'http://attacker.example',
          ragConnectionString: 'postgres://u:p@attacker.example/d',
          acceptedMcpSettingsMark: 'forged',
          importedMcpSettingsJson: FOREIGN_MCP,
          importedMcpServerNames: ['already-accepted-looking'],
        }),
      ),
    );

    await s.run();

    const stored = json(repoRow(s).onboardingTooling) as { tooling: Json };
    expect(Object.keys(stored.tooling).sort()).toEqual(['embeddingModel', 'ragMode']);
    expect(dirtyMarks(s)).toHaveLength(1);
  });

  it('never overwrites a column that holds tooling: the base keeps the unit and the writer is told', async () => {
    const s = await setup();
    const mine = { ragMode: 'external', embeddingModel: 'mine' };
    s.fake.patch(schema.repositories, REPO, { onboardingTooling: toolingColumn(mine) });
    await s.putRecord(withSettings(unitBase(UNIT)));

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(json(repoRow(s).onboardingTooling)).toEqual(toolingColumn(mine));
    expect(json((s.syncRow()?.baseSnapshot as Json).settings)).toEqual(unitBase(UNIT));
    expect(s.conflictRows()).toEqual([]);
    expect(dirtyMarks(s)).toHaveLength(1);
  });

  it('marks nothing when the column and the record already agree', async () => {
    const s = await setup();
    s.fake.patch(schema.repositories, REPO, {
      onboardingTooling: toolingColumn({ ...UNIT, ollamaUrl: 'http://10.0.0.5:11434' }),
    });
    await s.putRecord(withSettings(unitBase(UNIT)));

    await s.run();

    expect(dirtyMarks(s)).toEqual([]);
  });

  it('leaves the column empty for a unit that is no object, and keeps it out of the base', async () => {
    const s = await setup();
    await s.putRecord(withSettings({ 'onboarding-tooling': ['not', 'an', 'object'] }));

    await s.run();

    expect(repoRow(s).onboardingTooling ?? null).toBeNull();
    expect((json(s.syncRow()?.baseSnapshot) as Json).settings).toEqual({});
    expect(dirtyMarks(s)).toEqual([]);
  });
});

describe('syncProjectStateFromCheckout: files a reset leaves behind', () => {
  it('refuses a settings file left without format.json, and finds no record once they are gone', async () => {
    const s = await setup();
    await s.put(`${STATE_DIR}/settings/rtk-enabled.json`, 'true\n');

    expect((await s.run()).outcome).toBe('refused');

    await rm(join(s.root, STATE_DIR), { recursive: true });

    expect((await s.run()).outcome).toBe('absent');
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

  it('locks the repository row before it reads for a live onboarding or upgrade', async () => {
    const s = await setup();
    await s.putRecord(record(BASE));

    const { trace } = await s.run();

    const txn = transactions(trace).inside[0]!;
    const forUpdate = txn.indexOf('select repositories for update');
    const liveRead = txn.findIndex((e) => e.startsWith('select tasks'));
    expect(forUpdate).toBeGreaterThan(0);
    expect(liveRead).toBeGreaterThan(forUpdate);
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

    const domainKeys = s.lockKeys.filter((k) => k.startsWith('project-state:'));
    const [fromSync, fromWriter, , fromOther] = domainKeys;
    expect(domainKeys).toHaveLength(4);
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

  it('rejects a checkout changed synchronously while it waited for the transaction lock', async () => {
    const s = await setup(synced(BASE));
    await s.putRecord(record(TEAM));
    // The checkout changes while the sync waits for the lock.
    s.hook.onLock = () => {
      s.putRecordSync(record(LATER));
    };

    const { outcome } = await s.run();

    expect(outcome).toBe('superseded');
    expect(json(s.columnOf())).toEqual(column(BASE));
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
      cliTargets: ['claude-code'],
      ...TEAM,
      ...PER_INSTALL,
      agentTargets: codexTargets,
      rtkChoiceRecorded: true,
    });
  });
});

describe('syncProjectStateFromCheckout: a writer failed while preparing a pending conflict write', () => {
  const AGENTS = 'project/render.json#acceptedAgentIds';
  const mine = render({ acceptedAgentIds: ['code-reviewer'] });
  const theirs = render({ acceptedAgentIds: ['code-reviewer', 'qa-lead'] });

  async function failedWriter(writes_ = mine) {
    const s = await setup({ column: column(mine), sync: { base: baseOf(BASE) } });
    await s.putRecord(record(theirs));
    expect((await s.run()).outcome).toBe('conflict');
    let writes = 0;
    s.hook.onWrite = async () => {
      writes += 1;
      if (writes === 2) throw new Error('database refused');
    };
    await s.write({ ...writes_, ...PER_INSTALL }, true).then(
      () => {
        throw new Error('the writer should have failed');
      },
      (err: Error) => expect(err.name).toBe('ProjectStateWriteError'),
    );
    s.hook.onWrite = null;
    return s;
  }

  it('meets the per-key conflict again, with this side its own value, and settles nothing', async () => {
    const s = await failedWriter();
    expect(s.columnOf()).toBeNull();
    const pendingBefore = s.pending().map((r) => ({ ...r }));
    expect(pendingBefore).toHaveLength(1);

    const { outcome } = await s.run();

    expect(outcome).toBe('conflict');
    expect(s.pending()).toEqual(pendingBefore);
    expect(s.conflictRows()).toHaveLength(1);
    expect(s.conflictRows().some((r) => r.unit === 'project/render.json')).toBe(false);
    expect(s.conflictRows().some((r) => r.resolution === 'converged')).toBe(false);
    expect(json(s.pending()[0]!.local)).toEqual({ v: mine.acceptedAgentIds });
    expect(json(s.pending()[0]!.incoming)).toEqual({ v: theirs.acceptedAgentIds });
    expect(json(s.columnOf())).toMatchObject({ acceptedAgentIds: mine.acceptedAgentIds });
    expect(s.syncRow()?.lastError).toContain('acceptedAgentIds');
    expect(s.syncRow()?.lastError).not.toContain(AGENTS);
  });

  it('keeps the committed local side when an attempted choice never reached the file transaction', async () => {
    const chosen = render({ acceptedAgentIds: ['security-auditor'] });
    const s = await failedWriter(chosen);

    const { outcome } = await s.run();

    expect(outcome).toBe('conflict');
    // Failure preceded the files/semantic transaction; it never committed the attempted choice.
    expect(json(s.pending()[0]!.local)).toEqual({ v: mine.acceptedAgentIds });
    expect(json(s.columnOf())).toMatchObject({ acceptedAgentIds: mine.acceptedAgentIds });
  });

  it('writes nothing on the sync after that', async () => {
    const s = await failedWriter();
    await s.run();
    expect(s.pending().map((r) => r.unit)).toEqual([AGENTS]);
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('conflict');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });
});

describe('syncProjectStateFromCheckout: a pending claim question', () => {
  const PATH = 'docs/guide.md';
  const UNIT = claimFileName(PATH);
  const TEXT = 'the guide\n';
  const claim = (writtenHash: string) => ({
    path: PATH,
    templateId: 'workflow-config',
    kind: 'workflow-config',
    schemaVersion: 1,
    templateHash: 'c'.repeat(64),
    writtenHash,
    haiveVersion: '1.2.3',
  });
  const CBASE = claim('1'.repeat(64));
  const CMINE = claim('2'.repeat(64));
  const CTHEIRS = claim('3'.repeat(64));
  const withClaims = (...claims: ReturnType<typeof claim>[]): ProjectStateRecord => ({
    ...record(BASE),
    claims,
  });

  async function claimSetup(local: ReturnType<typeof claim>, incoming: ReturnType<typeof claim>) {
    const s = await setup({
      column: column(BASE),
      sync: { base: json({ ...normalizeProjectState(record(BASE)), claims: [CBASE] }) },
    });
    s.fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: null,
      diskPath: local.path,
      templateId: local.templateId,
      templateKind: local.kind,
      templateSchemaVersion: local.schemaVersion,
      templateContentHash: local.templateHash,
      writtenHash: local.writtenHash,
      sourceStepId: 'project-state-import',
      source: 'backfill',
      importedAt: new Date(5),
      haiveVersion: local.haiveVersion,
      supersededAt: null,
    });
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: UNIT,
      base: { v: CBASE },
      local: { v: CMINE },
      incoming: { v: CTHEIRS },
    });
    await s.putRecord(withClaims(incoming));
    return s;
  }

  it('is kept while the claim still differs on both installs and the disk holds neither', async () => {
    const s = await claimSetup(CMINE, CTHEIRS);

    await s.run();

    expect(s.pending().map((r) => r.unit)).toEqual([UNIT]);
  });

  it('follows the claim the checkout holds now, on the same row', async () => {
    const newer = claim('4'.repeat(64));
    const s = await claimSetup(CMINE, newer);
    const id = s.pending()[0]!.id;

    await s.run();

    expect(s.pending()[0]!.id).toBe(id);
    expect(json(s.pending()[0]!.incoming)).toEqual({ v: newer });
    expect(json(s.pending()[0]!.local)).toEqual({ v: CMINE });
  });

  it('converges once both installs hold the same claim', async () => {
    const s = await claimSetup(CMINE, CMINE);

    await s.run();

    expect(s.pending()).toEqual([]);
    expect(s.conflictRows()[0]).toMatchObject({ resolution: 'converged' });
    expect(s.conflictRows()[0]!.resolvedAt).toBeInstanceOf(Date);
  });

  it('converges once the teammate is back at the base', async () => {
    const s = await claimSetup(CMINE, CBASE);

    await s.run();

    expect(s.pending()).toEqual([]);
  });

  it('converges once the disk holds the bytes of one side only', async () => {
    const mine = claim(sha256Hex(normalizeContent(TEXT)));
    const s = await claimSetup(mine, CTHEIRS);
    s.fake.patch(schema.projectStateConflicts, s.pending()[0]!.id as string, {
      local: { v: mine },
    });
    await s.put(PATH, TEXT);

    await s.run();

    expect(s.pending()).toEqual([]);
  });

  it('is kept while the disk holds the bytes of neither side', async () => {
    const s = await claimSetup(CMINE, CTHEIRS);
    await s.put(PATH, TEXT);

    await s.run();

    expect(s.pending()).toHaveLength(1);
  });

  it('writes nothing on a second sync of the same files', async () => {
    const s = await claimSetup(CMINE, CTHEIRS);
    await s.run();
    const before = s.dump();

    const { trace } = await s.run();

    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
  });
});

describe('syncProjectStateFromCheckout: the record carries artifact claims', () => {
  const GUIDE = 'docs/guide.md';
  const AGENT = '.claude/agents/qa-lead.md';
  const GUIDE_TEXT = 'the guide\n';
  const claim = (
    path: string,
    writtenHash: string,
    over: Partial<{ templateId: string; kind: string; haiveVersion: string }> = {},
  ) => ({
    path,
    templateId: path === AGENT ? 'agent.qa-lead' : 'workflow-config',
    kind: path === AGENT ? 'agent' : 'workflow-config',
    schemaVersion: 1,
    templateHash: 'c'.repeat(64),
    writtenHash,
    haiveVersion: '1.2.3',
    ...over,
  });
  type Claim = ReturnType<typeof claim>;
  const H = (digit: string) => digit.repeat(64);
  const withClaims = (...claims: Claim[]): ProjectStateRecord => ({ ...record(BASE), claims });
  const ledger = (s: Setup) => s.fake.rows(schema.onboardingArtifacts);
  const live = (s: Setup) => ledger(s).filter((r) => r.supersededAt == null);
  const baseClaims = (s: Setup) => (json(s.syncRow()?.baseSnapshot) as { claims: Claim[] }).claims;

  async function claimed(opts: { base: Claim[]; local: Claim[]; incoming: Claim[] }) {
    const s = await setup({
      column: column(BASE),
      sync: { base: json({ ...normalizeProjectState(record(BASE)), claims: opts.base }) },
    });
    for (const c of opts.local) {
      s.fake.insert(schema.onboardingArtifacts, {
        userId: USER,
        repositoryId: REPO,
        taskId: randomUUID(),
        diskPath: c.path,
        templateId: c.templateId,
        templateKind: c.kind,
        templateSchemaVersion: c.schemaVersion,
        templateContentHash: c.templateHash,
        writtenHash: c.writtenHash,
        sourceStepId: '12-post-onboarding',
        source: 'onboarding',
        haiveVersion: c.haiveVersion,
        supersededAt: null,
      });
    }
    await s.putRecord(withClaims(...opts.incoming));
    return s;
  }

  it('imports one marker per claim of a first sync, and the base holds the claims', async () => {
    const s = await setup();
    await s.put(GUIDE, GUIDE_TEXT);
    const hash = sha256Hex(normalizeContent(GUIDE_TEXT));
    await s.putRecord(withClaims(claim(GUIDE, hash), claim(AGENT, H('4'))));

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    const rows = live(s);
    expect(rows.map((r) => r.diskPath).sort()).toEqual([AGENT, GUIDE]);
    for (const row of rows) {
      expect(row).toMatchObject({
        taskId: null,
        source: 'backfill',
        sourceStepId: 'project-state-import',
        userId: USER,
        userModified: false,
      });
      expect(row.importedAt).toBeInstanceOf(Date);
      expect(row.generatedAt).toEqual(row.importedAt);
    }
    const guide = rows.find((r) => r.diskPath === GUIDE)!;
    expect(guide).toMatchObject({
      templateId: 'workflow-config',
      writtenHash: hash,
      writtenContent: GUIDE_TEXT,
      lastObservedDiskHash: hash,
    });
    expect(baseClaims(s).map((c) => c.path)).toEqual([GUIDE, AGENT].sort());
  });

  it('gives a marker for an agent the snapshot accepting that agent', async () => {
    const s = await setup();
    await s.putRecord(withClaims(claim(AGENT, H('4'))));

    await s.run();

    const [row] = live(s);
    const accepted = (row!.formValuesSnapshot as { acceptedAgentIds: string[] }).acceptedAgentIds;
    expect(accepted).toEqual(['code-reviewer', 'qa-lead', 'security-auditor']);
    expect(row!.formValuesSnapshot).not.toHaveProperty('rtkChoiceRecorded');
  });

  it.each([
    ['records RTK in the marker once a person switched it', new Date(1000), true],
    ['leaves RTK out of the marker while nobody chose it', null, false],
  ] as const)('%s, over a column that recorded no choice', async (_name, madeAt, recorded) => {
    const s = await setup({ column: column(BASE, false) });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true, rtkChoiceMadeAt: madeAt });
    await s.putRecord(withClaims(claim(AGENT, H('4'))));

    await s.run();

    const [row] = live(s);
    expect(Object.hasOwn(row!.formValuesSnapshot as object, 'rtkEnabled')).toBe(recorded);
  });

  it('uses the live RTK choice even when an import marker’s portable column synthesized off', async () => {
    const s = await setup({ column: { ...BASE, rtkChoiceRecorded: true } });
    s.fake.patch(schema.repositories, REPO, { rtkEnabled: true });
    await s.putRecord(withClaims(claim(AGENT, H('4'))));
    await s.run();
    const [marker] = live(s);
    expect((marker!.formValuesSnapshot as Json).rtkEnabled).toBe(false);
    // A failed record writer can clear the column; the marker then becomes the snapshot fallback.
    s.patchColumn(null);

    const resolved = await resolveRenderContext(s.fake.db as unknown as Database, {
      repositoryId: REPO,
      userId: USER,
      liveRows: live(s) as never,
      logger: { warn: () => undefined },
    });

    expect(resolved?.rtkLive).toBe(true);
    expect(resolved?.renderCtx.rtkEnabled).toBe(true);
  });

  it('keeps no bytes for a marker whose path holds other bytes', async () => {
    const s = await setup();
    await s.put(GUIDE, GUIDE_TEXT);
    await s.putRecord(withClaims(claim(GUIDE, H('4'))));

    await s.run();

    expect(live(s)[0]).toMatchObject({
      writtenContent: null,
      lastObservedDiskHash: sha256Hex(normalizeContent(GUIDE_TEXT)),
    });
  });

  it('writes nothing on a second sync of the same checkout', async () => {
    const s = await setup();
    await s.putRecord(withClaims(claim(GUIDE, H('4')), claim(AGENT, H('5'))));
    await s.run();
    const before = s.dump();
    const ledgerBefore = json(ledger(s));

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('unchanged');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
    expect(json(ledger(s))).toEqual(ledgerBefore);
  });

  it('retires the row of a claim the other install removed, and keeps the rest', async () => {
    const [g, a] = [claim(GUIDE, H('4')), claim(AGENT, H('5'))];
    const s = await claimed({ base: [g, a], local: [g, a], incoming: [a] });

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    const guide = ledger(s).find((r) => r.diskPath === GUIDE)!;
    expect(guide.supersededAt).toBeInstanceOf(Date);
    expect(guide.importedAt).toEqual(guide.supersededAt);
    expect(live(s).map((r) => r.diskPath)).toEqual([AGENT]);
    expect(baseClaims(s)).toEqual([a]);
  });

  it('keeps a claim only this install holds', async () => {
    const [g, a] = [claim(GUIDE, H('4')), claim(AGENT, H('5'))];
    const s = await claimed({ base: [a], local: [g, a], incoming: [a] });

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(
      live(s)
        .map((r) => r.diskPath)
        .sort(),
    ).toEqual([AGENT, GUIDE]);
    expect(ledger(s).every((r) => r.importedAt == null)).toBe(true);
  });

  it('supersedes the row of a claim the other install changed and inserts its marker', async () => {
    const [was, now] = [claim(GUIDE, H('4')), claim(GUIDE, H('6'), { haiveVersion: '2.0.0' })];
    const s = await claimed({ base: [was], local: [was], incoming: [now] });

    await s.run();

    const [old] = ledger(s).filter((r) => r.supersededAt != null);
    expect(old).toMatchObject({ writtenHash: H('4'), taskId: expect.any(String) });
    expect(old!.importedAt).toBeInstanceOf(Date);
    expect(live(s)).toHaveLength(1);
    expect(live(s)[0]).toMatchObject({
      taskId: null,
      writtenHash: H('6'),
      haiveVersion: '2.0.0',
      sourceStepId: 'project-state-import',
    });
    expect(baseClaims(s)).toEqual([now]);
  });

  it('settles a claim both installs changed by the bytes on disk, taking the incoming one', async () => {
    const hash = sha256Hex(normalizeContent(GUIDE_TEXT));
    const [was, mine, theirs] = [claim(GUIDE, H('4')), claim(GUIDE, H('5')), claim(GUIDE, hash)];
    const s = await claimed({ base: [was], local: [mine], incoming: [theirs] });
    await s.put(GUIDE, GUIDE_TEXT);

    await s.run();

    expect(live(s)).toHaveLength(1);
    expect(live(s)[0]).toMatchObject({
      taskId: null,
      writtenHash: hash,
      writtenContent: GUIDE_TEXT,
    });
    expect(s.pending()).toEqual([]);
  });

  it('keeps its own claim when the bytes on disk hold it', async () => {
    const hash = sha256Hex(normalizeContent(GUIDE_TEXT));
    const [was, mine, theirs] = [claim(GUIDE, H('4')), claim(GUIDE, hash), claim(GUIDE, H('6'))];
    const s = await claimed({ base: [was], local: [mine], incoming: [theirs] });
    await s.put(GUIDE, GUIDE_TEXT);

    await s.run();

    expect(live(s)).toHaveLength(1);
    expect(live(s)[0]).toMatchObject({ writtenHash: hash, source: 'onboarding' });
    expect(s.pending()).toEqual([]);
  });

  it('takes the incoming claim when the bytes hold the claim of both installs', async () => {
    const hash = sha256Hex(normalizeContent(GUIDE_TEXT));
    const [was, mine, theirs] = [
      claim(GUIDE, H('4')),
      claim(GUIDE, hash, { haiveVersion: '1.0.0' }),
      claim(GUIDE, hash, { haiveVersion: '2.0.0' }),
    ];
    const s = await claimed({ base: [was], local: [mine], incoming: [theirs] });
    await s.put(GUIDE, GUIDE_TEXT);

    await s.run();

    expect(live(s)).toHaveLength(1);
    expect(live(s)[0]).toMatchObject({ taskId: null, haiveVersion: '2.0.0' });
    expect(s.pending()).toEqual([]);
  });

  it('records one pending claim row when both changed it and the bytes hold neither', async () => {
    const [was, mine, theirs] = [claim(GUIDE, H('4')), claim(GUIDE, H('5')), claim(GUIDE, H('6'))];
    const s = await claimed({ base: [was], local: [mine], incoming: [theirs] });
    await s.put(GUIDE, GUIDE_TEXT);

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    const rows = s.pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unit: claimFileName(GUIDE) });
    expect(json(rows[0]!.base)).toEqual({ v: was });
    expect(json(rows[0]!.local)).toEqual({ v: mine });
    expect(json(rows[0]!.incoming)).toEqual({ v: theirs });
    expect(live(s)).toHaveLength(1);
    expect(live(s)[0]).toMatchObject({ writtenHash: H('5'), source: 'onboarding' });
    expect(baseClaims(s)).toEqual([was]);
  });

  it('records a claim the other install removed and this one changed, with no incoming side', async () => {
    const [was, mine, other] = [claim(GUIDE, H('4')), claim(GUIDE, H('5')), claim(AGENT, H('7'))];
    const s = await claimed({ base: [was, other], local: [mine, other], incoming: [other] });
    await s.put(GUIDE, GUIDE_TEXT);

    await s.run();

    expect(s.pending()).toHaveLength(1);
    expect(s.pending()[0]!.incoming).toBeNull();
    expect(baseClaims(s)).toEqual([was, other].sort((x, y) => (x.path < y.path ? -1 : 1)));
  });

  it('imports first and closes the pending row after, when the bytes now hold their claim', async () => {
    const hash = sha256Hex(normalizeContent(GUIDE_TEXT));
    const [was, mine, theirs] = [claim(GUIDE, H('4')), claim(GUIDE, H('5')), claim(GUIDE, hash)];
    const s = await claimed({ base: [was], local: [mine], incoming: [theirs] });
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: claimFileName(GUIDE),
      base: { v: was },
      local: { v: mine },
      incoming: { v: theirs },
    });
    await s.put(GUIDE, GUIDE_TEXT);

    await s.run();

    expect(s.pending()).toEqual([]);
    expect(s.conflictRows()[0]).toMatchObject({ resolution: 'converged' });
    expect(live(s)).toHaveLength(1);
    expect(live(s)[0]).toMatchObject({ taskId: null, writtenHash: hash });
    expect(baseClaims(s)).toEqual([theirs]);
  });

  it('retires nothing when the checkout carries no claim and the base has some', async () => {
    const [g, a] = [claim(GUIDE, H('4')), claim(AGENT, H('5'))];
    const s = await claimed({ base: [g, a], local: [g, a], incoming: [] });

    const { outcome } = await s.run();

    expect(outcome).toBe('applied');
    expect(live(s)).toHaveLength(2);
    expect(baseClaims(s)).toEqual([a, g].sort((x, y) => (x.path < y.path ? -1 : 1)));
  });

  it('keeps its own change to a claim when the checkout carries no claim', async () => {
    const [was, mine] = [claim(GUIDE, H('4')), claim(GUIDE, H('5'))];
    const s = await claimed({ base: [was], local: [mine], incoming: [] });

    await s.run();

    expect(live(s)[0]).toMatchObject({ writtenHash: H('5'), source: 'onboarding' });
    expect(s.pending()).toEqual([]);
  });

  it('leaves a row that renders no claim alone', async () => {
    const [g] = [claim(GUIDE, H('4'))];
    const s = await claimed({ base: [], local: [], incoming: [g] });
    s.fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: randomUUID(),
      diskPath: '.claude/skills/custom.md',
      templateId:
        'custom.00000000-0000-4000-8000-000000000001.00000000-0000-4000-8000-000000000002',
      templateKind: 'custom-skill',
      templateSchemaVersion: 1,
      templateContentHash: H('1'),
      writtenHash: H('1'),
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
      supersededAt: null,
    });

    await s.run();

    expect(
      live(s)
        .map((r) => r.diskPath)
        .sort(),
    ).toEqual(['.claude/skills/custom.md', GUIDE]);
    expect(ledger(s).filter((r) => r.supersededAt != null)).toEqual([]);
  });

  describe.each(['.git/config', '.git./config'])(
    'a claim file at git-data path %j an earlier release wrote',
    (LEGACY) => {
      const legacyFile = `${STATE_DIR}/${claimFileName(LEGACY)}`;
      const legacyClaim = () => claim(LEGACY, H('9'));
      const putLegacy = (s: Setup) => s.put(legacyFile, canonicalJson(legacyClaim()));

      it('syncs the rest of the record, imports no marker for it and lists it in the base', async () => {
        const s = await setup();
        await s.putRecord(withClaims(claim(GUIDE, H('4'))));
        await putLegacy(s);

        const { outcome } = await s.run();

        expect(outcome).toBe('applied');
        expect(s.syncRow()?.lastError ?? null).toBeNull();
        expect(ledger(s).map((r) => r.diskPath)).toEqual([GUIDE]);
        expect(baseClaims(s).map((c) => c.path)).toEqual([LEGACY, GUIDE]);
      });

      it('marks the outbox dirty, so the sweep writes the record and removes the file', async () => {
        const s = await setup();
        await s.putRecord(withClaims(claim(GUIDE, H('4'))));
        await putLegacy(s);

        await s.run();

        const [mark, ...rest] = dirtyMarks(s);
        expect(rest).toEqual([]);
        expect(mark).toMatchObject({ repositoryId: REPO });
        expect(mark!.revision as number).toBeGreaterThan(mark!.writtenRevision as number);
      });

      it('imports no marker when it is the only claim of the checkout and the base already lists it', async () => {
        const s = await setup({
          column: column(BASE),
          sync: { base: json({ ...normalizeProjectState(record(BASE)), claims: [legacyClaim()] }) },
        });
        await s.putRecord(record(BASE));
        await putLegacy(s);

        const { outcome } = await s.run();

        expect(outcome).toBe('applied');
        expect(ledger(s)).toEqual([]);
        expect(baseClaims(s)).toEqual([legacyClaim()]);
        expect(dirtyMarks(s)).toHaveLength(1);
      });

      it('keeps the claims of the base when it is the only claim file the checkout holds', async () => {
        const [g, a] = [claim(GUIDE, H('4')), claim(AGENT, H('5'))];
        const s = await claimed({ base: [g, a], local: [g, a], incoming: [] });
        await putLegacy(s);

        const { outcome } = await s.run();

        expect(outcome).toBe('applied');
        expect(live(s)).toHaveLength(2);
        expect(baseClaims(s).map((c) => c.path)).toEqual([AGENT, LEGACY, GUIDE]);
      });

      it('is left in the base for the writer, which removes the file and the claim from the base', async () => {
        const s = await setup();
        await s.putRecord(record(BASE));
        await putLegacy(s);

        expect((await s.run()).outcome).toBe('applied');
        await s.write(contextA(), true);

        expect(Object.keys(await treeOf(s.root))).not.toContain(legacyFile);
        expect(baseClaims(s)).toEqual([]);
      });
    },
  );

  it('defers while a reset holds the root claim, writing nothing', async () => {
    const s = await setup();
    await s.putRecord(withClaims(claim(GUIDE, H('4'))));
    s.fake.patch(schema.repositories, REPO, { rootClaimedAt: new Date(), rootClaimKind: 'reset' });
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('deferred');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(s.dump()).toEqual(before);
    expect(ledger(s)).toEqual([]);
  });

  it.each(['rebuild', 'refresh'])(
    'does not defer for the %s claim of the job that calls it',
    async (kind) => {
      const s = await setup();
      await s.putRecord(withClaims(claim(GUIDE, H('4'))));
      s.fake.patch(schema.repositories, REPO, { rootClaimedAt: new Date(), rootClaimKind: kind });

      expect((await s.run()).outcome).toBe('applied');
      expect(live(s)).toHaveLength(1);
    },
  );

  it('stands down when a reset moved after the checkout was read', async () => {
    const s = await setup();
    await s.putRecord(withClaims(claim(GUIDE, H('4'))));
    s.hook.onLock = () => {
      s.fake.patch(schema.repositories, REPO, { onboardingResetAt: new Date() });
    };
    const before = s.dump();

    const { outcome, trace } = await s.run();

    expect(outcome).toBe('superseded');
    expect(trace.filter(isWrite)).toEqual([]);
    expect(json(s.fake.rows(schema.projectStateSync))).toEqual(
      (before as { projectStateSync: unknown }).projectStateSync,
    );
    expect(ledger(s)).toEqual([]);
  });
});

describe('syncProjectStateFromCheckout: bundle descriptors', () => {
  const GIT_URL = 'https://example.com/team-kit.git';
  const SOURCE = portableBundleSource({
    sourceType: 'git',
    gitUrl: GIT_URL,
    gitBranch: 'main',
    name: 'any',
  });
  const withBundles = (name: string, r: ProjectRender = BASE): ProjectStateRecord => ({
    ...record(r),
    bundles: [{ source: SOURCE, name }],
  });
  const baseWith = (name: string): unknown => json(normalizeProjectState(withBundles(name)));
  const localBundle = (s: Setup, name: string) =>
    s.fake.insert(schema.customBundles, {
      userId: USER,
      repositoryId: REPO,
      name,
      sourceType: 'git',
      gitUrl: GIT_URL,
      gitBranch: 'main',
      storageRoot: `/bundles/${name}`,
    });

  it('become the base on a first import, as the checkout holds them', async () => {
    const s = await setup();
    await s.putRecord(withBundles('their-kit'));

    await s.run();

    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseWith('their-kit'));
  });

  it('follow the checkout in the base when a teammate renames one, with no conflict row', async () => {
    const s = await setup({
      column: column(BASE),
      sync: { base: baseWith('old-kit') },
    });
    await s.putRecord(withBundles('their-kit'));

    const { outcome } = await s.run();

    expect(outcome).not.toBe('conflict');
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseWith('their-kit'));
    expect(s.conflictRows()).toEqual([]);
  });

  it('are not merged: two sides naming one source differently leave no pending row and no error', async () => {
    const s = await setup({
      column: column(BASE),
      sync: { base: baseWith('old-kit') },
    });
    localBundle(s, 'my-kit');
    await s.putRecord(withBundles('their-kit'));

    const { outcome } = await s.run();

    expect(outcome).not.toBe('conflict');
    expect(s.pending()).toEqual([]);
    expect(s.conflictRows()).toEqual([]);
    expect(s.syncRow()?.lastError ?? null).toBeNull();
    expect(json(s.syncRow()?.baseSnapshot)).toEqual(baseWith('their-kit'));
  });
});

describe('repository CLI membership import', () => {
  it('joins installs and preserves unknown portable members without local provider metadata', async () => {
    const s = await setup({
      column: { ...column(BASE), cliTargets: ['claude-code', 'future-cli'] },
    });
    await s.putRecord({ ...record(BASE), cli: ['codex'] });
    await s.run();
    expect(s.columnOf()).toMatchObject({ cliTargets: ['claude-code', 'codex', 'future-cli'] });
    expect(s.syncRow()?.baseSnapshot).toMatchObject({ cli: ['codex'] });
  });
  it('legacy absence cannot erase recorded membership, but deletion from a nonempty base can', async () => {
    const local = { ...column(BASE), cliTargets: ['claude-code', 'codex', 'future-cli'] };
    const legacy = await setup({ column: local, sync: { base: record(BASE) } });
    await legacy.putRecord(record(BASE));
    await legacy.run();
    expect(legacy.columnOf()).toMatchObject({ cliTargets: local.cliTargets });
    const removed = await setup({
      column: local,
      sync: { base: { ...record(BASE), cli: local.cliTargets } },
    });
    await removed.putRecord({ ...record(BASE), cli: ['codex', 'future-cli'] });
    await removed.run();
    expect(removed.columnOf()).toMatchObject({ cliTargets: ['codex', 'future-cli'] });
  });
  it('an explicit local empty set is not replaced by an unchanged incoming base', async () => {
    const s = await setup({
      column: { ...column(BASE), cliTargets: [] },
      sync: { base: { ...record(BASE), cli: ['claude-code'] } },
    });
    await s.putRecord({ ...record(BASE), cli: ['claude-code'] });
    await s.run();
    expect(s.columnOf()).toMatchObject({ cliTargets: [] });
  });
  it('a fresh clone of an empty record does not invent membership from its enabled providers', async () => {
    const s = await setup();
    s.fake.insert(schema.cliProviders, {
      userId: USER,
      name: 'codex',
      enabled: true,
      rulesContent: '',
    });
    await s.putRecord(record(BASE));
    await s.run();
    expect(s.columnOf()).toMatchObject({ cliTargets: [] });
    const resolved = await resolveRenderContext(s.fake.db as unknown as Database, {
      repositoryId: REPO,
      userId: USER,
      liveRows: [],
      logger: { warn() {} },
    });
    expect(resolved?.renderCtx.agentTargets).toEqual([]);
  });
  it('a NULL column recovers existing snapshot membership before classifying it as unknown', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, {
      repositoryId: REPO,
      diskPath: '.claude/agents/code-reviewer.md',
      templateId: 'agent.code-reviewer',
      templateKind: 'agent',
      writtenHash: 'x',
      templateContentHash: 'x',
      templateSchemaVersion: 1,
      source: 'onboarding',
      sourceStepId: '12-post-onboarding',
      supersededAt: null,
      generatedAt: new Date(),
      formValuesSnapshot: { ...contextA(), cliTargets: ['claude-code', 'future-cli'] },
    });
    await s.putRecord(record(BASE));
    await s.run();
    expect(s.columnOf()).toMatchObject({ cliTargets: ['claude-code', 'future-cli'] });
  });
});

it('a legacy foreground snapshot cannot erase authoritative CLI membership or bypass its late column fence', async () => {
  const current = { ...column(BASE), cliTargets: ['claude-code', 'codex', 'future-cli'] };
  const s = await setup({ column: current });
  await s.write(contextA(), true);
  expect(s.columnOf()).toMatchObject({ cliTargets: current.cliTargets });
  expect(await readFile(join(s.root, STATE_DIR, 'cli/future-cli.json'), 'utf8')).toContain(
    'future-cli',
  );
  const stale = await setup({ column: current });
  let projectLocks = 0;
  stale.hook.onLock = (key) => {
    if (key === LOCK_KEY && ++projectLocks === 2) stale.patchColumn({ ...current, cliTargets: [] });
  };
  await expect(stale.write(contextA(), true)).rejects.toThrow();
  expect(stale.columnOf()).toMatchObject({ cliTargets: [] });
  expect(
    Object.keys(await treeOf(stale.root)).filter((path) => path.startsWith(`${STATE_DIR}/`)),
  ).toEqual([]);
  const explicit = await setup({ column: { ...current, cliTargets: [] } });
  await expect(explicit.write({ ...contextA(), cliTargets: ['codex'] }, true)).rejects.toThrow(
    'membership changed',
  );
  expect(explicit.columnOf()).toMatchObject({ cliTargets: [] });
});

it('a successful writer retires removed CLI unit files only from its prior base and preserves foreign units', async () => {
  const before = { ...record(BASE), cli: ['claude-code', 'codex', 'future-cli'] };
  const current = { ...column(BASE), cliTargets: ['claude-code', 'future-cli'] };
  const s = await setup({ column: current, sync: { base: before } });
  await s.putRecord(before);
  await s.put(`${STATE_DIR}/future/untouched.json`, '{"kept":true}\n');
  await s.write({ ...contextA(), cliTargets: current.cliTargets }, true);
  await expect(readFile(join(s.root, STATE_DIR, 'cli/codex.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(s.root, STATE_DIR, 'cli/future-cli.json'), 'utf8')).toContain(
    'future-cli',
  );
  expect(await readFile(join(s.root, STATE_DIR, 'future/untouched.json'), 'utf8')).toBe(
    '{"kept":true}\n',
  );
});

it('a later membership-less snapshot cannot erase older recorded zero-provider fallback ownership during sync', async () => {
  const s = await setup();
  const old = {
    ...BASE,
    enabledCliProviders: [],
    agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
  };
  for (const [at, ctx, path] of [
    [1, old, '.claude/agents/code-reviewer.md'],
    [2, BASE, '.claude/workflow-config.json'],
  ] as const)
    s.fake.insert(schema.onboardingArtifacts, {
      repositoryId: REPO,
      diskPath: path,
      templateId: at === 1 ? 'agent.code-reviewer' : 'workflow-config',
      templateKind: at === 1 ? 'agent' : 'workflow-config',
      templateSchemaVersion: 1,
      templateContentHash: 'x',
      writtenHash: 'x',
      source: 'onboarding',
      sourceStepId: '12-post-onboarding',
      supersededAt: null,
      generatedAt: new Date(at),
      formValuesSnapshot: ctx,
    });
  s.fake.insert(schema.cliProviders, {
    userId: USER,
    name: 'codex',
    enabled: true,
    rulesContent: '',
  });
  await s.putRecord(record(BASE));
  await s.run();
  expect(s.columnOf()).toMatchObject({
    cliTargets: [],
    legacyAgentFallback: true,
    agentTargets: old.agentTargets,
  });
  const before = s.columnOf();
  expect((await s.run()).outcome).toBe('unchanged');
  expect(s.columnOf()).toEqual(before);
});
