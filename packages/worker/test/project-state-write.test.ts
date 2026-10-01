import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableColumns, getTableName, is, SQL, StringChunk } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import {
  emptyProjectState,
  normalizeProjectState,
  renderProjectState,
} from '@haive/shared/project-state';
import { writeProjectStateRecord } from '../src/project-state/write.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const STATE_DIR = '.haive-data/state';
const FORMAT = `${STATE_DIR}/format.json`;
const RENDER = `${STATE_DIR}/project/render.json`;
// The fake takes a lock only as this prefix, ONE interpolated string key and `, 0))`, and stores an
// upsert's SQL expressions unevaluated: build the whole key as one string, and set literal values.
const LOCK = 'execute select pg_advisory_xact_lock(hashtextextended(';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The table and columns are found by their SQL names, which the migration fixes, so the test
 *  does not depend on what the schema module calls them. */
function tableNamed(sqlName: string): PgTable {
  const found = (Object.values(schema) as unknown[]).find(
    (v) => is(v, PgTable) && getTableName(v) === sqlName,
  );
  if (!found) throw new Error(`the database schema has no table ${sqlName}`);
  return found as PgTable;
}
function keyOf(table: PgTable, sqlName: string): string {
  const hit = Object.entries(getTableColumns(table)).find(([, col]) => col.name === sqlName);
  if (!hit) throw new Error(`${getTableName(table)} has no column ${sqlName}`);
  return hit[0];
}

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
const messages = (err: unknown): string[] => {
  const out: string[] = [];
  for (let e = err, i = 0; e instanceof Error && i < 6; e = e.cause, i++) out.push(e.message);
  return out;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !done(); i++) await sleep(5);
  if (!done()) throw new Error('timed out waiting');
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(root, next)));
    else out.push(next);
  }
  return out.sort();
}

type Context = Record<string, unknown>;

// The sets are unsorted on purpose: the record sorts them, and the files must show it.
const context = (): Context => ({
  projectInfo: {
    name: 'acme',
    framework: 'drupal',
    primaryLanguage: 'php',
    description: null,
    localUrl: null,
    databaseType: 'postgres',
    databaseVersion: '17',
    webserver: 'nginx-fpm',
    docroot: 'web',
    runtimeVersions: { php: '8.3' },
    testFrameworks: ['phpunit'],
    testPaths: ['tests'],
    buildTool: 'composer',
    commands: [],
    containerType: 'ddev',
  },
  framework: 'drupal',
  acceptedAgentIds: ['security-auditor', 'code-reviewer'],
  customAgentSpecs: [{ id: 'billing-expert', title: 'Billing expert' }],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  lspLanguages: ['php-extended', 'css'],
  rtkEnabled: true,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
});
const portableOnly = (): Context => ({
  projectInfo: { name: 'other' },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
});

/** What the record holds for a context: its portable fields and nothing else. */
const recordOf = (c: Context) => ({
  ...emptyProjectState(),
  render: {
    projectInfo: c.projectInfo,
    framework: c.framework,
    acceptedAgentIds: c.acceptedAgentIds,
    customAgentSpecs: c.customAgentSpecs,
    lspLanguages: c.lspLanguages,
  } as never,
});
const expectedFiles = (c: Context) => {
  const files = renderProjectState(recordOf(c));
  return { format: files.get('format.json')!, render: files.get('project/render.json')! };
};

/** A repository with a database that records what it is asked, in order, and the files it writes. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'project-state-write-'));
  dirs.push(root);
  const repositories = schema.repositories;
  const sync = tableNamed('project_state_sync');
  const fake = createFakeDb({ repositories, projectStateSync: sync });
  fake.insert(repositories, { id: REPO, userId: USER, name: 'acme', source: 'blank' });
  fake.insert(repositories, { id: OTHER, userId: USER, name: 'other', source: 'blank' });

  const col = {
    renderContext: keyOf(repositories, 'render_context'),
    repositoryId: keyOf(sync, 'repository_id'),
    baseSnapshot: keyOf(sync, 'base_snapshot'),
    lastError: keyOf(sync, 'last_error'),
    updatedAt: keyOf(sync, 'updated_at'),
  };
  const columnOf = (id: string): unknown =>
    fake.rows(repositories).find((r) => r.id === id)?.[col.renderContext] ?? null;
  const syncRows = () => fake.rows(sync);

  const onDisk = (at = root) => ({
    format: existsSync(join(at, FORMAT)) ? readFileSync(join(at, FORMAT), 'utf8') : null,
    render: existsSync(join(at, RENDER)) ? readFileSync(join(at, RENDER), 'utf8') : null,
  });
  const events: string[] = [];
  const lockKeys: string[] = [];
  let atFirstWrite: ReturnType<typeof onDisk> | null = null;
  const firstWrite = () => {
    atFirstWrite ??= onDisk();
  };
  const hook = {
    onLock: null as ((key: string) => void) | null,
    onCommit: null as (() => Promise<void>) | null,
  };
  fake.hooks.beforeLock = (key) => {
    firstWrite();
    lockKeys.push(key);
    hook.onLock?.(key);
  };
  fake.hooks.beforeUpdate = (table) => {
    firstWrite();
    events.push(`update ${getTableName(table)}`);
  };
  fake.hooks.beforeInsert = (table) => {
    firstWrite();
    events.push(`insert ${getTableName(table)}`);
  };
  fake.hooks.beforeDelete = (table) => {
    firstWrite();
    events.push(`delete ${getTableName(table)}`);
  };
  fake.hooks.beforeCommit = () => hook.onCommit?.();

  const describeSql = (query: unknown): string => {
    const first = is(query, SQL) ? query.queryChunks[0] : undefined;
    return first instanceof StringChunk ? first.value.join('') : '(not sql text)';
  };
  const traced = (handle: FakeDbHandle): FakeDbHandle =>
    new Proxy(handle, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === 'transaction') {
          return (fn: (tx: FakeDbHandle) => Promise<unknown>) => {
            firstWrite();
            events.push('begin');
            return (value as FakeDbHandle['transaction'])((tx) => fn(traced(tx))).finally(() =>
              events.push('end'),
            );
          };
        }
        if (prop === 'select') {
          return (...args: Parameters<FakeDbHandle['select']>) => {
            events.push('select');
            return (value as FakeDbHandle['select'])(...args);
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
                    return (Reflect.get(api, method) as (...a: unknown[]) => unknown)(...args);
                  },
              }),
          });
        }
        return value;
      },
    });
  const db = traced(fake.db as unknown as FakeDbHandle) as unknown as Database;

  const write = (
    c: Context,
    rtkChoiceRecorded: boolean,
    over: { repositoryId?: string; repoPath?: string } = {},
  ): Promise<readonly string[]> =>
    writeProjectStateRecord(db, {
      repositoryId: over.repositoryId ?? REPO,
      repoPath: over.repoPath ?? root,
      context: c as never,
      rtkChoiceRecorded,
    });
  const syncSeed = (values: Record<string, unknown>) =>
    fake.insert(sync, {
      [col.repositoryId]: REPO,
      [col.baseSnapshot]: { stale: true },
      [col.lastError]: null,
      [col.updatedAt]: new Date(0),
      ...values,
    });
  return {
    root,
    fake,
    write,
    col,
    columnOf,
    syncRows,
    syncSeed,
    onDisk,
    events,
    lockKeys,
    hook,
    atFirstWrite: () => atFirstWrite,
  };
}

const isWrite = (event: string) => /^(update|insert|delete) /.test(event);

describe('writeProjectStateRecord: the files', () => {
  it('writes the record files under the repository, as the codec renders them, and nothing else', async () => {
    const s = await setup();
    const written = await s.write(context(), true);

    const want = expectedFiles(context());
    expect(s.onDisk()).toEqual(want);
    expect(await listFiles(s.root)).toEqual([FORMAT, RENDER]);
    expect([...written].sort()).toEqual([FORMAT, RENDER]);
  });

  it('writes them before any database write', async () => {
    const s = await setup();
    await s.write(context(), true);

    expect(s.atFirstWrite()).toEqual(expectedFiles(context()));
  });

  it('writes the files again for a second context, replacing the first', async () => {
    const s = await setup();
    await s.write(context(), true);
    await s.write(context(), true);
    expect(s.onDisk()).toEqual(expectedFiles(context()));

    await s.write(portableOnly(), false);
    expect(s.onDisk()).toEqual(expectedFiles(portableOnly()));
    expect(await listFiles(s.root)).toEqual([FORMAT, RENDER]);
  });
});

describe('writeProjectStateRecord: the database', () => {
  it('sets the repository column to the context and the RTK choice flag, and no other row', async () => {
    const s = await setup();
    await s.write(context(), true);

    expect(json(s.columnOf(REPO))).toEqual(json({ ...context(), rtkChoiceRecorded: true }));
    expect(s.columnOf(OTHER)).toBeNull();
  });

  it('stores an RTK choice nobody made as false, not as absent', async () => {
    const s = await setup();
    await s.write(context(), false);

    const column = s.columnOf(REPO) as Record<string, unknown>;
    expect(column.rtkChoiceRecorded).toBe(false);
    expect(json(column)).toEqual(json({ ...context(), rtkChoiceRecorded: false }));
  });

  it('keeps a portable-only context as it is, inventing no per-install field', async () => {
    const s = await setup();
    await s.write(portableOnly(), true);

    expect(json(s.columnOf(REPO))).toEqual(json({ ...portableOnly(), rtkChoiceRecorded: true }));
  });

  it('starts the sync from the record it wrote, with no error', async () => {
    const s = await setup();
    await s.write(context(), true);

    const rows = s.syncRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row[s.col.repositoryId]).toBe(REPO);
    expect(json(row[s.col.baseSnapshot])).toEqual(json(normalizeProjectState(recordOf(context()))));
    expect(row[s.col.lastError] ?? null).toBeNull();
    expect(row[s.col.updatedAt]).toBeTruthy();
  });

  it('moves an existing sync row to the new base and clears its error', async () => {
    const s = await setup();
    s.syncSeed({ [s.col.lastError]: 'an earlier failure' });
    await s.write(context(), true);

    const rows = s.syncRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(json(row[s.col.baseSnapshot])).toEqual(json(normalizeProjectState(recordOf(context()))));
    expect(row[s.col.lastError] ?? null).toBeNull();
    expect(row[s.col.updatedAt]).not.toEqual(new Date(0));
  });

  it('replaces the column and the base on a second write rather than adding to them', async () => {
    const s = await setup();
    await s.write(context(), true);
    await s.write(context(), true);
    expect(s.syncRows()).toHaveLength(1);

    await s.write(portableOnly(), false);
    expect(json(s.columnOf(REPO))).toEqual(json({ ...portableOnly(), rtkChoiceRecorded: false }));
    const rows = s.syncRows();
    expect(rows).toHaveLength(1);
    expect(json(rows[0]![s.col.baseSnapshot])).toEqual(
      json(normalizeProjectState(recordOf(portableOnly()))),
    );
  });
});

describe('writeProjectStateRecord: the transaction', () => {
  it('opens one transaction, whose first statement is the advisory lock, and writes both rows in it', async () => {
    const s = await setup();
    await s.write(context(), true);

    const { events } = s;
    expect(events.filter((e) => e === 'begin')).toHaveLength(1);
    expect(events.filter((e) => e === 'end')).toHaveLength(1);
    const begin = events.indexOf('begin');
    const end = events.indexOf('end');
    const inside = events.slice(begin + 1, end);
    expect(inside[0]).toBe(LOCK);
    expect(inside.slice(1).filter(isWrite).sort()).toEqual([
      'insert project_state_sync',
      'update repositories',
    ]);
    expect([...events.slice(0, begin), ...events.slice(end + 1)].filter(isWrite)).toEqual([]);
    expect(s.lockKeys).toHaveLength(1);
  });

  it('takes the same lock for one repository every time, and another for another repository', async () => {
    const s = await setup();
    const elsewhere = await mkdtemp(join(tmpdir(), 'project-state-write-other-'));
    dirs.push(elsewhere);
    await s.write(context(), true);
    await s.write(portableOnly(), true);
    await s.write(context(), true, { repositoryId: OTHER, repoPath: elsewhere });

    const [first, again, other] = s.lockKeys;
    expect(s.lockKeys).toHaveLength(3);
    expect(first).toBe(again);
    expect(other).not.toBe(first);
    // Named for the repository without being the bare id, which the plan mirror already locks on.
    expect(first).toContain(REPO);
    expect(first).not.toBe(REPO);
  });

  it('makes a second writer of the repository wait until the first one has finished', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let commits = 0;
    let locks = 0;
    s.hook.onLock = () => {
      locks += 1;
    };
    s.hook.onCommit = async () => {
      commits += 1;
      if (commits > 1) return;
      s.events.push('first writer: before commit');
      await gate;
      s.events.push('first writer: released');
    };

    const first = s.write(context(), true);
    await waitFor(() => s.events.includes('first writer: before commit'));
    const second = s.write(portableOnly(), false);
    await waitFor(() => locks === 2);
    await sleep(40);
    const paused = s.events.indexOf('first writer: before commit');
    expect(s.events.slice(paused + 1).filter(isWrite)).toEqual([]);

    release();
    await Promise.all([first, second]);
    const released = s.events.indexOf('first writer: released');
    expect(
      s.events
        .slice(released + 1)
        .filter(isWrite)
        .sort(),
    ).toEqual(['insert project_state_sync', 'update repositories']);
    expect(json(s.columnOf(REPO))).toEqual(json({ ...portableOnly(), rtkChoiceRecorded: false }));
  });
});

describe('writeProjectStateRecord: failures', () => {
  it.each([
    ['takes the lock', 'beforeLock'],
    ['sets the column', 'beforeUpdate'],
    ['writes the sync row', 'beforeInsert'],
  ] as const)(
    'keeps the files, and leaves both rows as they were, when the database %s',
    async (_what, point) => {
      const s = await setup();
      s.fake.hooks[point] = () => {
        throw new Error('database refused');
      };

      const err = await s.write(context(), true).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      expect(messages(err).some((m) => m.includes('database refused'))).toBe(true);

      expect(s.onDisk()).toEqual(expectedFiles(context()));
      expect(s.columnOf(REPO)).toBeNull();
      expect(s.syncRows()).toEqual([]);
    },
  );

  it('writes nothing to the database when the files cannot be written', async () => {
    const s = await setup();
    await writeFile(join(s.root, '.haive-data'), 'a file where the directory should be');

    await expect(s.write(context(), true)).rejects.toThrow();

    expect(s.events.filter(isWrite)).toEqual([]);
    expect(s.events).not.toContain('begin');
    expect(s.columnOf(REPO)).toBeNull();
    expect(s.syncRows()).toEqual([]);
  });
});
