import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, getTableColumns, getTableName, is, SQL, StringChunk } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import {
  bundleFileName,
  claimFileName,
  portableBundleSource,
  emptyProjectState,
  normalizeProjectState,
  renderProjectState,
  projectStateHash,
  gitBlobId,
  recordedCliTargets,
} from '@haive/shared/project-state';
import {
  ProjectStateMovedError,
  writeProjectStateColumn,
  writeProjectStateRecord,
} from '../src/project-state/write.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const STATE_DIR = '.haive-data/state';
const FORMAT = `${STATE_DIR}/format.json`;
const RENDER = `${STATE_DIR}/project/render.json`;
const CLI = `${STATE_DIR}/cli/claude-code.json`;
// The fake takes a lock only as this prefix, ONE interpolated string key and `, 0))`, and stores an
// upsert's SQL expressions unevaluated: build the whole key as one string, and set literal values.

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
  customAgentSpecs: [
    { id: 'billing-expert', title: 'Billing expert', description: 'Knows the billing module' },
  ],
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

/** The record holds portable render fields plus recorded CLI membership, never derived paths. */
const recordOf = (c: Context) => ({
  ...emptyProjectState(),
  cli:
    recordedCliTargets(c as { cliTargets?: string[]; enabledCliProviders?: { name: string }[] }) ??
    [],
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
  const fake = createFakeDb({
    repositories,
    projectStateSync: sync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    onboardingArtifacts: schema.onboardingArtifacts,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    tasks: schema.tasks,
  });
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
    failNextSelect: 0,
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
            if (hook.failNextSelect > 0) {
              hook.failNextSelect -= 1;
              throw new Error('read refused');
            }
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

  const writeFull = (
    c: Context,
    rtkChoiceRecorded: boolean,
    over: {
      repositoryId?: string;
      repoPath?: string;
      expectedColumns?: unknown[];
      holdingTaskId?: string;
    } = {},
  ) =>
    writeProjectStateRecord(db, {
      repositoryId: over.repositoryId ?? REPO,
      repoPath: over.repoPath ?? root,
      context: c as never,
      rtkChoiceRecorded,
      ...(over.expectedColumns ? { expectedColumns: over.expectedColumns } : {}),
      ...(over.holdingTaskId ? { holdingTaskId: over.holdingTaskId } : {}),
    });
  const write = (...args: Parameters<typeof writeFull>): Promise<readonly string[]> =>
    writeFull(...args).then((result) => result.written);
  const syncSeed = (values: Record<string, unknown>) =>
    fake.insert(sync, {
      [col.repositoryId]: REPO,
      [col.baseSnapshot]: { stale: true },
      [col.lastError]: null,
      [col.updatedAt]: new Date(0),
      ...values,
    });
  const pend = (
    unit: string,
    sides: { base?: unknown; local?: unknown; incoming?: unknown },
    over: Record<string, unknown> = {},
  ) =>
    fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit,
      base: 'base' in sides ? { v: sides.base } : null,
      local: 'local' in sides ? { v: sides.local } : null,
      incoming: 'incoming' in sides ? { v: sides.incoming } : null,
      ...over,
    });
  return {
    root,
    fake,
    write,
    writeFull,
    pend,
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

/** A previously read checkout, deliberately stamped independently of its conflict-preserving base. */
async function knownCheckout(s: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const files = renderProjectState(recordOf(context()));
  for (const [rel, text] of files) {
    const path = join(s.root, STATE_DIR, rel);
    if (existsSync(path)) continue;
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  const entries = await listFiles(join(s.root, STATE_DIR));
  const hash = projectStateHash(
    new Map(
      entries.map((rel) => [rel, gitBlobId(readFileSync(join(s.root, STATE_DIR, rel), 'utf8'))]),
    ),
  );
  const rows = s.syncRows();
  if (rows.length)
    await s.fake.db
      .update(schema.projectStateSync)
      .set({ syncedHash: hash })
      .where(eq(schema.projectStateSync.repositoryId, REPO));
  else s.syncSeed({ syncedHash: hash });
}

const isWrite = (event: string) => /^(update|insert|delete) /.test(event);

describe('writeProjectStateRecord: a column that moved past the writer', () => {
  it('refuses before any file is written and leaves the newer column as it is', async () => {
    const s = await setup();
    await s.write(context(), true);
    const newer = s.columnOf(REPO);
    const filesBefore = s.onDisk();
    const other = {
      ...context(),
      projectInfo: { ...(context().projectInfo as object), name: 'z' },
    };

    await expect(
      s.write(other, true, { expectedColumns: [{ planned: 'elsewhere' }] }),
    ).rejects.toBeInstanceOf(ProjectStateMovedError);
    expect(s.columnOf(REPO)).toEqual(newer);
    expect(s.onDisk()).toEqual(filesBefore);
  });

  it('checks and writes under one lock, so no sync can land between the check and the files', async () => {
    const s = await setup();
    await s.write(context(), true, { expectedColumns: [{ planned: 'here' }] });
    expect(s.lockKeys).toHaveLength(4);

    const t = await setup();
    t.hook.onLock = () =>
      t.fake.patch(schema.repositories, REPO, { renderContext: { by: 'sync' } });
    await expect(
      t.write(context(), true, { expectedColumns: [{ planned: 'here' }] }),
    ).rejects.toBeInstanceOf(ProjectStateMovedError);
    expect(t.onDisk()).toEqual({ format: null, render: null });
  });

  it('refuses once its task no longer holds the checkout, so a refresh may have moved it', async () => {
    const TASK = '00000000-0000-4000-8000-0000000000c1';
    for (const [status, deadAt, refused] of [
      ['running', null, false],
      ['cancelled', null, true],
      ['running', new Date(), true],
    ] as const) {
      const s = await setup();
      s.fake.insert(schema.tasks, {
        id: TASK,
        userId: USER,
        repositoryId: REPO,
        status,
        deadAt,
        type: 'onboarding_upgrade',
      });
      const write = s.write(context(), true, { expectedColumns: [null], holdingTaskId: TASK });
      if (refused) {
        await expect(write).rejects.toBeInstanceOf(ProjectStateMovedError);
        expect(s.onDisk()).toEqual({ format: null, render: null });
      } else {
        await write;
        expect(s.onDisk()).toEqual(expectedFiles(context()));
      }
    }
  });

  it('clears the failed foreground column while keeping its durable undo journal', async () => {
    const s = await setup();
    await s.write(context(), true);
    const planned = s.columnOf(REPO);
    s.fake.hooks.beforeInsert = (table) => {
      if (table === schema.projectStateSync) throw new Error('database refused');
    };
    await expect(s.write(context(), false, { expectedColumns: [planned] })).rejects.toThrow(
      'database refused',
    );
    expect(s.columnOf(REPO)).toBeNull();
    expect(s.fake.rows(schema.projectStateOutbox)[0]!.writeIntent).toBeTruthy();
  });

  it('writes when the column is one the writer expected, or none', async () => {
    const s = await setup();
    await s.write(context(), true, { expectedColumns: [{ planned: 'elsewhere' }] });
    const first = s.columnOf(REPO);
    await s.write(context(), false, { expectedColumns: [first] });
    expect(s.columnOf(REPO)).not.toEqual(first);
  });
});

describe('writeProjectStateRecord: the files', () => {
  it('writes exactly the codec record files and private prepared images', async () => {
    const s = await setup();
    const written = await s.write(context(), true);

    const want = expectedFiles(context());
    expect(s.onDisk()).toEqual(want);
    expect(await publicFilesWithPrivateImages(s.root)).toEqual([CLI, FORMAT, RENDER]);
    expect([...written].sort()).toEqual([CLI, FORMAT, RENDER]);
  });

  it('commits its recovery intent before the first file changes', async () => {
    const s = await setup();
    await s.write(context(), true);
    expect(s.atFirstWrite()).toEqual({ format: null, render: null });
    expect(s.fake.rows(schema.projectStateOutbox)[0]!.writeIntent).toBeNull();
  });

  it('writes the files again for a second context, replacing the first', async () => {
    const s = await setup();
    await s.write(context(), true);
    await s.write(context(), true);
    expect(s.onDisk()).toEqual(expectedFiles(context()));

    await s.write(portableOnly(), false);
    expect(s.onDisk()).toEqual(expectedFiles(portableOnly()));
    expect(await publicFilesWithPrivateImages(s.root)).toEqual([CLI, FORMAT, RENDER]);
  });
});

describe('writeProjectStateRecord: the database', () => {
  it('sets the repository column to the context and the RTK choice flag, and no other row', async () => {
    const s = await setup();
    await s.write(context(), true);

    expect(json(s.columnOf(REPO))).toEqual(
      json({ ...context(), cliTargets: ['claude-code'], rtkChoiceRecorded: true }),
    );
    expect(s.columnOf(OTHER)).toBeNull();
  });

  it('stores an RTK choice nobody made as false, not as absent', async () => {
    const s = await setup();
    await s.write(context(), false);

    const column = s.columnOf(REPO) as Record<string, unknown>;
    expect(column.rtkChoiceRecorded).toBe(false);
    expect(json(column)).toEqual(
      json({ ...context(), cliTargets: ['claude-code'], rtkChoiceRecorded: false }),
    );
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

  it('replaces portable fields and the RTK choice while preserving recorded CLI membership', async () => {
    const s = await setup();
    await s.write(context(), true);
    await s.write(context(), true);
    expect(s.syncRows()).toHaveLength(1);

    await s.write(portableOnly(), false);
    expect(json(s.columnOf(REPO))).toEqual(
      json({
        ...portableOnly(),
        cliTargets: ['claude-code'],
        agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
        enabledCliProviders: context().enabledCliProviders,
        rtkChoiceRecorded: false,
      }),
    );
    const rows = s.syncRows();
    expect(rows).toHaveLength(1);
    expect(json(rows[0]![s.col.baseSnapshot])).toEqual(
      json(normalizeProjectState(recordOf({ ...portableOnly(), cliTargets: ['claude-code'] }))),
    );
  });
});

describe('writeProjectStateRecord: the transaction', () => {
  it('commits an undo journal then writes rows and files under the same ordered locks', async () => {
    const s = await setup();
    await s.write(context(), true);
    const { events } = s;
    expect(events.filter((e) => e === 'begin')).toHaveLength(2);
    expect(events.filter((e) => e === 'end')).toHaveLength(2);
    const firstEnd = events.indexOf('end');
    expect(events.slice(0, firstEnd).filter(isWrite)).toEqual([
      'insert project_state_outbox',
      'update project_state_outbox',
    ]);
    const writes = events.slice(firstEnd + 1).filter(isWrite);
    expect(writes).toContain('insert project_state_sync');
    expect(writes).toContain('update repositories');
    expect(s.lockKeys).toEqual([
      `onboarding-upgrade:${REPO}`,
      `project-state:${REPO}`,
      `onboarding-upgrade:${REPO}`,
      `project-state:${REPO}`,
    ]);
  });

  it('takes the same lock for one repository every time, and another for another repository', async () => {
    const s = await setup();
    const elsewhere = await mkdtemp(join(tmpdir(), 'project-state-write-other-'));
    dirs.push(elsewhere);
    await s.write(context(), true);
    await s.write(portableOnly(), true);
    await s.write(context(), true, { repositoryId: OTHER, repoPath: elsewhere });
    expect(s.lockKeys.filter((k) => k === `project-state:${REPO}`)).toHaveLength(4);
    expect(s.lockKeys.filter((k) => k === `project-state:${OTHER}`)).toHaveLength(2);
  });

  it('makes a second writer of the repository wait until the first one has finished', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let commits = 0;
    s.hook.onCommit = async () => {
      if (++commits === 1) {
        s.events.push('intent awaiting commit');
        await gate;
      }
    };
    const first = s.write(context(), true);
    await waitFor(() => s.events.includes('intent awaiting commit'));
    const second = s.write(portableOnly(), false);
    await sleep(30);
    expect(s.onDisk()).toEqual({ format: null, render: null });
    release();
    const settled = await Promise.allSettled([first, second]);
    expect(settled.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(s.syncRows()).toHaveLength(1);
    // The other preparer either writes in turn or observes a superseding journal and defers.
    for (const r of settled)
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ProjectStateMovedError);
  });
});

describe('writeProjectStateRecord: failures', () => {
  it.each([
    ['takes the lock', 'beforeLock'],
    ['sets the column', 'beforeUpdate'],
    ['writes the sync row', 'beforeInsert'],
  ] as const)(
    'writes no file or semantic row when preparation cannot commit because the database %s',
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

      expect(s.onDisk()).toEqual({ format: null, render: null });
      expect(s.columnOf(REPO)).toBeNull();
      expect(s.syncRows()).toEqual([]);
    },
  );

  // The column it leaves is cleared, since it would otherwise read as newer than the writer's rows.
  it('holds an unreadable checkout before writing a sync row or clearing the column', async () => {
    const s = await setup();
    await writeFile(join(s.root, '.haive-data'), 'a file where the directory should be');

    await expect(s.write(context(), true)).rejects.toThrow();

    expect(s.events.filter(isWrite)).toEqual([]);
    expect(s.columnOf(REPO)).toBeNull();
    expect(s.syncRows()).toEqual([]);
  });
});

describe('writeProjectStateRecord: what a rejection names', () => {
  // Read off the error by name and not by class, so the cases below run against a writer whose
  // rejections carry no such field, and fail there for that reason.
  const written = (err: unknown): string[] | undefined =>
    (err as { written?: string[] } | null)?.written;
  const rejection = (run: Promise<unknown>) =>
    run.then(
      () => null,
      (e: unknown) => e,
    );

  it.each([
    ['takes the lock', 'beforeLock'],
    ['sets the column', 'beforeUpdate'],
    ['writes the sync row', 'beforeInsert'],
  ] as const)(
    'names no record files when preparation fails because the database %s',
    async (_what, point) => {
      const s = await setup();
      s.fake.hooks[point] = () => {
        throw new Error('database refused');
      };

      const err = await rejection(s.write(context(), true));

      expect(err).toBeInstanceOf(Error);
      expect([...(written(err) ?? [])].sort()).toEqual([]);
      expect((err as Error).message).toContain('database refused');
      if (point === 'beforeLock') expect(await listFiles(s.root)).toEqual([]);
      else {
        expect(await publicFilesWithPrivateImages(s.root)).toEqual([]);
        expect((await listFiles(s.root)).length).toBe(4);
      }
    },
  );

  it('names no file when the strict read refuses a non-directory inside the record', async () => {
    const s = await setup();
    await mkdir(join(s.root, STATE_DIR), { recursive: true });
    await writeFile(join(s.root, STATE_DIR, 'project'), 'a file where the directory should be');

    const err = await rejection(s.write(context(), true));

    expect(err).toBeInstanceOf(Error);
    expect(written(err) ?? []).toEqual([]);
    expect(s.events.filter(isWrite)).toEqual([]);
  });

  it('names no file when none could be written', async () => {
    const s = await setup();
    await writeFile(join(s.root, '.haive-data'), 'a file where the directory should be');

    const err = await rejection(s.write(context(), true));

    expect(err).toBeInstanceOf(Error);
    expect(written(err) ?? []).toEqual([]);
  });

  it('reports only paths actually reached by an attempt', async () => {
    const s = await setup();
    const ok = await s.write(context(), true);

    const failing = await setup();
    failing.fake.hooks.beforeLock = () => {
      throw new Error('database refused');
    };
    const err = await rejection(failing.write(context(), true));

    expect(ok).toEqual(expect.arrayContaining([FORMAT, RENDER]));
    expect(written(err) ?? []).toEqual([]);
  });
});

describe('writeProjectStateRecord: a key a sync left pending', () => {
  const UNIT = 'project/render.json#acceptedAgentIds';
  const base = ['code-reviewer'];
  const incoming = ['code-reviewer', 'qa-lead'];
  const withIds = (ids: string[]) => ({ ...context(), acceptedAgentIds: ids });

  it('writes the key as the teammate has it, keeps the old base for it, and leaves the column the writer’s', async () => {
    const s = await setup();
    s.pend(UNIT, { base, local: ['security-auditor', 'code-reviewer'], incoming });

    await s.write(context(), true);

    expect(s.onDisk().render).toBe(expectedFiles(withIds(incoming)).render);
    const baseSnapshot = s.syncRows()[0]![s.col.baseSnapshot];
    expect(json(baseSnapshot)).toEqual(json(normalizeProjectState(recordOf(withIds(base)))));
    expect(json(s.columnOf(REPO))).toEqual(
      json({ ...context(), cliTargets: ['claude-code'], rtkChoiceRecorded: true }),
    );
    expect(s.fake.rows(schema.projectStateConflicts)).toHaveLength(1);
  });

  it('fails before files when its first locked recovery read fails', async () => {
    const s = await setup();
    s.pend(UNIT, { base, local: ['security-auditor', 'code-reviewer'], incoming });
    s.hook.failNextSelect = 1;
    await expect(s.write(context(), true)).rejects.toThrow('read refused');
    expect(s.onDisk()).toEqual({ format: null, render: null });
  });

  it('writes no file from an unknown set of pending rows when the locked read fails too', async () => {
    const s = await setup();
    s.pend(UNIT, { base, local: ['security-auditor', 'code-reviewer'], incoming });
    s.hook.failNextSelect = 2;

    await expect(s.write(context(), true)).rejects.toThrow();

    expect(s.onDisk().render).toBeNull();
  });

  it('records the value it wrote as the row’s local side', async () => {
    const s = await setup();
    s.pend(UNIT, { base, local: ['security-auditor', 'code-reviewer'], incoming });
    const chosen = ['security-auditor'];

    await s.write(withIds(chosen), true);

    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(json(row!.local)).toEqual({ v: chosen });
    expect(row!.resolvedAt ?? null).toBeNull();
  });

  it('settles a key once the value it wrote is what the other side has', async () => {
    const s = await setup();
    s.pend(UNIT, { base, local: ['security-auditor', 'code-reviewer'], incoming });

    await s.write(withIds(incoming), true);

    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(row!.resolution).toBe('converged');
    expect(row!.resolvedAt).not.toBeNull();
  });

  it('records nothing as the local side when the write failed before any file', async () => {
    const s = await setup();
    const local = ['security-auditor', 'code-reviewer'];
    s.pend(UNIT, { base, local, incoming });
    s.hook.failNextSelect = 2;

    await expect(s.write(withIds(incoming), true)).rejects.toThrow();

    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(json(row!.local)).toEqual({ v: local });
    expect(row!.resolvedAt ?? null).toBeNull();
  });

  it('leaves the pending local side intact when intent preparation fails', async () => {
    const s = await setup();
    s.pend(UNIT, { base, local: ['security-auditor', 'code-reviewer'], incoming });
    s.fake.hooks.beforeInsert = () => {
      throw new Error('database refused');
    };
    s.fake.hooks.beforeUpdate = (table) => {
      if (table === schema.projectStateConflicts) throw new Error('rows refused');
    };

    const err = await s.write(withIds(['security-auditor']), true).then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as { columnStale?: boolean }).columnStale).toBe(false);
    expect(s.onDisk()).toEqual({ format: null, render: null });
  });

  it('records nothing as the local side when the render file itself was never written', async () => {
    const s = await setup();
    const local = ['security-auditor', 'code-reviewer'];
    s.pend(UNIT, { base, local, incoming });
    await mkdir(join(s.root, STATE_DIR), { recursive: true });
    await writeFile(join(s.root, STATE_DIR, 'project'), 'a file where the directory should be');

    await expect(s.write(withIds(incoming), true)).rejects.toThrow();

    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(json(row!.local)).toEqual({ v: local });
    expect(row!.resolvedAt ?? null).toBeNull();
  });

  it('carries a teammate’s null as a value, not as an absent key', async () => {
    const s = await setup();
    s.pend('project/render.json#framework', { base: 'drupal10', local: 'drupal', incoming: null });

    await s.write(context(), true);

    expect((JSON.parse(s.onDisk().render!) as { framework: unknown }).framework).toBeNull();
  });

  it('ignores a resolved row and a row of another repository', async () => {
    const s = await setup();
    s.pend(UNIT, { base, incoming }, { resolution: 'keep_mine', resolvedAt: new Date(1) });
    s.pend(UNIT, { base, incoming }, { repositoryId: OTHER });

    await s.write(context(), true);

    expect(s.onDisk().render).toBe(expectedFiles(context()).render);
    const baseSnapshot = s.syncRows()[0]![s.col.baseSnapshot];
    expect(json(baseSnapshot)).toEqual(json(normalizeProjectState(recordOf(context()))));
  });

  it('holds the whole render file as the teammate has it when the whole unit is pending', async () => {
    const s = await setup();
    s.pend('project/render.json', {
      base: recordOf(withIds(base)).render,
      incoming: recordOf(withIds(incoming)).render,
    });

    await s.write(context(), true);

    expect(s.onDisk().render).toBe(expectedFiles(withIds(incoming)).render);
    const baseRender = (s.syncRows()[0]![s.col.baseSnapshot] as { render: unknown }).render;
    expect(json(baseRender)).toEqual(json(normalizeProjectState(recordOf(withIds(base))).render));
  });

  it('reads the rows under the lock, so a sync that landed after the files were planned is seen', async () => {
    const s = await setup();
    s.hook.onLock = () => {
      if (!s.fake.rows(schema.projectStateConflicts).length) s.pend(UNIT, { base, incoming });
    };

    await s.write(context(), true);

    expect(s.onDisk().render).toBe(expectedFiles(withIds(incoming)).render);
    const baseSnapshot = s.syncRows()[0]![s.col.baseSnapshot];
    expect(json(baseSnapshot)).toEqual(json(normalizeProjectState(recordOf(withIds(base)))));
  });
});

describe('writeProjectStateRecord: one claim per live ledger row', () => {
  const BUNDLE = '00000000-0000-4000-8000-0000000000d1';
  const ITEM = '00000000-0000-4000-8000-0000000000d2';
  const TASK = '00000000-0000-4000-8000-0000000000c1';
  const claimPath = (diskPath: string) => `${STATE_DIR}/${claimFileName(diskPath)}`;

  const row = (diskPath: string, over: Record<string, unknown> = {}) => ({
    userId: USER,
    repositoryId: REPO,
    taskId: TASK,
    diskPath,
    templateId: 'agent.code-reviewer',
    templateKind: 'agent',
    templateSchemaVersion: 2,
    templateContentHash: 'a'.repeat(64),
    writtenHash: 'b'.repeat(64),
    sourceStepId: '12-post-onboarding',
    source: 'onboarding',
    haiveVersion: '1.2.3',
    supersededAt: null,
    ...over,
  });
  const marker = (diskPath: string, over: Record<string, unknown> = {}) =>
    row(diskPath, {
      taskId: null,
      source: 'backfill',
      sourceStepId: 'project-state-import',
      importedAt: new Date(5),
      haiveVersion: null,
      ...over,
    });

  const claimOnDisk = (root: string, diskPath: string) =>
    JSON.parse(readFileSync(join(root, claimPath(diskPath)), 'utf8')) as unknown;
  const claimFiles = async (root: string) =>
    (await listFiles(root)).filter((f) => f.startsWith(`${STATE_DIR}/artifacts/`));

  it('writes a claim file per live row, markers and custom bundle items included, and none for the rest', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, row('.claude/agents/code-reviewer.md'));
    s.fake.insert(
      schema.onboardingArtifacts,
      marker('.claude/agents/imported.md', {
        templateId: 'custom:zip%3Aacme-kit:agents%2Fimported.md',
        templateKind: 'custom-agent',
      }),
    );
    s.fake.insert(
      schema.onboardingArtifacts,
      row('.claude/agents/billing.md', {
        templateId: `custom.${BUNDLE}.${ITEM}`,
        templateKind: 'custom-agent',
      }),
    );
    s.fake.insert(
      schema.onboardingArtifacts,
      row('.claude/agents/dangling.md', {
        templateId: `custom.${BUNDLE}.00000000-0000-4000-8000-0000000000ff`,
      }),
    );
    s.fake.insert(schema.onboardingArtifacts, row('../outside.md'));
    s.fake.insert(
      schema.onboardingArtifacts,
      row('.claude/agents/old.md', { supersededAt: new Date(1) }),
    );
    s.fake.insert(schema.onboardingArtifacts, { ...row('other.md'), repositoryId: OTHER });
    s.fake.insert(schema.customBundles, {
      id: BUNDLE,
      userId: USER,
      repositoryId: REPO,
      name: 'acme-kit',
      sourceType: 'zip',
      storageRoot: '/bundles/acme-kit',
    });
    s.fake.insert(schema.customBundleItems, {
      id: ITEM,
      bundleId: BUNDLE,
      kind: 'agent',
      sourceFormat: 'claude-md',
      sourcePath: 'agents/billing.md',
      normalizedSpec: {},
      contentHash: 'c'.repeat(64),
    });

    const { written, removed } = await s.writeFull(context(), true);

    const paths = [
      '.claude/agents/billing.md',
      '.claude/agents/code-reviewer.md',
      '.claude/agents/imported.md',
    ];
    expect(removed).toEqual([]);
    expect(await claimFiles(s.root)).toEqual(paths.map(claimPath).sort());
    expect(paths.map(claimPath).every((p) => written.includes(p))).toBe(true);
    expect(claimOnDisk(s.root, '.claude/agents/code-reviewer.md')).toEqual({
      path: '.claude/agents/code-reviewer.md',
      templateId: 'agent.code-reviewer',
      kind: 'agent',
      schemaVersion: 2,
      templateHash: 'a'.repeat(64),
      writtenHash: 'b'.repeat(64),
      haiveVersion: '1.2.3',
    });
    expect(claimOnDisk(s.root, '.claude/agents/billing.md')).toMatchObject({
      templateId: 'custom:zip%3Aacme-kit:agents%2Fbilling.md',
    });
    expect(claimOnDisk(s.root, '.claude/agents/imported.md')).toMatchObject({
      templateId: 'custom:zip%3Aacme-kit:agents%2Fimported.md',
      kind: 'custom-agent',
      haiveVersion: '',
    });
  });

  it('carries the same claims in the sync base', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, row('.claude/agents/code-reviewer.md'));
    s.fake.insert(schema.onboardingArtifacts, marker('.claude/agents/imported.md'));

    await s.write(context(), true);

    const base = s.syncRows()[0]![s.col.baseSnapshot] as { claims: { path: string }[] };
    expect(base.claims.map((c) => c.path)).toEqual([
      '.claude/agents/code-reviewer.md',
      '.claude/agents/imported.md',
    ]);
    expect(json(base)).toEqual(
      json(
        normalizeProjectState({
          ...recordOf(context()),
          claims: base.claims as never,
        }),
      ),
    );
  });

  it('removes the claim file of a row retired since the last write, and only that one', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, row('.claude/agents/code-reviewer.md'));
    const retiring = s.fake.insert(schema.onboardingArtifacts, row('.claude/agents/old.md'));
    await s.write(context(), true);
    const teammate = '.claude/agents/teammate.md';
    const teammateFile = join(s.root, claimPath(teammate));
    await mkdir(join(s.root, STATE_DIR, 'artifacts'), { recursive: true });
    await writeFile(teammateFile, '{"unsynced":true}\n');
    s.fake.patch(schema.onboardingArtifacts, retiring.id as string, { supersededAt: new Date(2) });

    await expect(s.writeFull(context(), true)).rejects.toBeInstanceOf(ProjectStateMovedError);

    expect(await claimFiles(s.root)).toEqual(
      [
        claimPath('.claude/agents/code-reviewer.md'),
        claimPath('.claude/agents/old.md'),
        claimPath(teammate),
      ].sort(),
    );
    expect(readFileSync(teammateFile, 'utf8')).toBe('{"unsynced":true}\n');
    const base = s.syncRows()[0]![s.col.baseSnapshot] as { claims: { path: string }[] };
    expect(base.claims.map((c) => c.path)).toEqual([
      '.claude/agents/code-reviewer.md',
      '.claude/agents/old.md',
    ]);
  });

  it('reports a claim file already gone from disk as removed, so the commit drops it from git too', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, row('.claude/agents/code-reviewer.md'));
    const retiring = s.fake.insert(schema.onboardingArtifacts, row('.claude/agents/old.md'));
    await s.write(context(), true);
    await rm(join(s.root, claimPath('.claude/agents/old.md')));
    s.fake.patch(schema.onboardingArtifacts, retiring.id as string, { supersededAt: new Date(2) });

    const { written, removed } = await s.writeFull(context(), true);

    expect(removed).toEqual([claimPath('.claude/agents/old.md')]);
    expect(written).not.toContain(claimPath('.claude/agents/old.md'));
  });

  it.each(['.git/config', '.git./config'])(
    'removes the claim file of git-data path %j an earlier release wrote, though no claim may name it now',
    async (diskPath) => {
      const s = await setup();
      s.fake.insert(schema.onboardingArtifacts, row('.claude/agents/code-reviewer.md'));
      s.syncSeed({ [s.col.baseSnapshot]: { claims: [{ path: diskPath }] } });
      const legacy = claimPath(diskPath);
      await mkdir(join(s.root, STATE_DIR, 'artifacts'), { recursive: true });
      await writeFile(
        join(s.root, legacy),
        JSON.stringify({
          path: diskPath,
          templateId: 'agent.legacy',
          kind: 'agent',
          schemaVersion: 1,
          templateHash: 'a'.repeat(64),
          writtenHash: 'b'.repeat(64),
          haiveVersion: '1.0.0',
        }) + '\n',
      );
      await knownCheckout(s);

      const { removed } = await s.writeFull(context(), true);

      expect(removed).toEqual([legacy]);
      expect(await claimFiles(s.root)).toEqual([claimPath('.claude/agents/code-reviewer.md')]);
    },
  );

  it('leaves a claim file the previous base never named, though no row produces it', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, row('.claude/agents/code-reviewer.md'));
    const stray = claimPath('.claude/agents/stray.md');
    await mkdir(join(s.root, STATE_DIR, 'artifacts'), { recursive: true });
    await writeFile(join(s.root, stray), '{"unsynced":true}\n');

    await expect(s.writeFull(context(), true)).rejects.toBeInstanceOf(ProjectStateMovedError);
    expect(await claimFiles(s.root)).toContain(stray);
  });
});

describe('writeProjectStateRecord: a claim a sync left pending', () => {
  const TASK = '00000000-0000-4000-8000-0000000000c1';
  const PATH = '.claude/agents/code-reviewer.md';
  const UNIT = claimFileName(PATH);
  const claim = (hash: string) => ({
    path: PATH,
    templateId: 'agent.code-reviewer',
    kind: 'agent',
    schemaVersion: 2,
    templateHash: 'a'.repeat(64),
    writtenHash: hash.repeat(64),
    haiveVersion: '1.2.3',
  });
  const BASE = claim('1');
  const MINE = claim('2');
  const THEIRS = claim('3');
  const liveRow = (writtenHash: string) => ({
    userId: USER,
    repositoryId: REPO,
    taskId: TASK,
    diskPath: PATH,
    templateId: 'agent.code-reviewer',
    templateKind: 'agent',
    templateSchemaVersion: 2,
    templateContentHash: 'a'.repeat(64),
    writtenHash,
    sourceStepId: '12-post-onboarding',
    source: 'onboarding',
    haiveVersion: '1.2.3',
    supersededAt: null,
  });
  const claimFile = (root: string) => join(root, STATE_DIR, UNIT);
  const baseClaims = (s: Awaited<ReturnType<typeof setup>>) =>
    (s.syncRows()[0]![s.col.baseSnapshot] as { claims: unknown[] }).claims;

  it('writes the claim file as the teammate has it, keeps the old base for it, and keeps the local row', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, liveRow(MINE.writtenHash));
    s.pend(UNIT, { base: BASE, local: MINE, incoming: THEIRS });

    await s.write(context(), true);

    expect(JSON.parse(readFileSync(claimFile(s.root), 'utf8'))).toEqual(THEIRS);
    expect(json(baseClaims(s))).toEqual([BASE]);
    const [live] = s.fake.rows(schema.onboardingArtifacts) as Record<string, unknown>[];
    expect(live).toMatchObject({ writtenHash: MINE.writtenHash, supersededAt: null });
    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(row!.resolvedAt ?? null).toBeNull();
  });

  it('writes no claim file where the teammate removed it, and keeps the base side', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, liveRow(MINE.writtenHash));
    s.pend(UNIT, { base: BASE, local: MINE });

    await s.write(context(), true);

    expect(existsSync(claimFile(s.root))).toBe(false);
    expect(json(baseClaims(s))).toEqual([BASE]);
  });

  it('records the claim it holds as the row’s local side', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, liveRow(BASE.writtenHash));
    s.pend(UNIT, { base: BASE, local: MINE, incoming: THEIRS });

    await s.write(context(), true);

    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(json(row!.local)).toEqual({ v: BASE });
    expect(row!.resolvedAt ?? null).toBeNull();
  });

  it('settles the row once the claim it holds is the one the teammate has', async () => {
    const s = await setup();
    s.fake.insert(schema.onboardingArtifacts, liveRow(THEIRS.writtenHash));
    s.pend(UNIT, { base: BASE, local: MINE, incoming: THEIRS });

    await s.write(context(), true);

    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(row!.resolution).toBe('converged');
  });
});

describe('writeProjectStateRecord: one descriptor per bundle source', () => {
  const GIT_URL = 'https://example.com/team-kit.git';
  const SOURCE = portableBundleSource({
    sourceType: 'git',
    gitUrl: GIT_URL,
    gitBranch: 'main',
    name: 'any',
  });
  const descriptorPath = `${STATE_DIR}/${bundleFileName(SOURCE)}`;
  const bundleFiles = async (root: string) =>
    (await listFiles(root)).filter((f) => f.startsWith(`${STATE_DIR}/bundles/`));
  const descriptorOn = (root: string, rel = descriptorPath) =>
    JSON.parse(readFileSync(join(root, rel), 'utf8')) as unknown;
  const baseBundles = (s: Awaited<ReturnType<typeof setup>>) =>
    (s.syncRows()[0]![s.col.baseSnapshot] as { bundles: unknown[] }).bundles;
  const localBundle = (s: Awaited<ReturnType<typeof setup>>, name: string) =>
    s.fake.insert(schema.customBundles, {
      userId: USER,
      repositoryId: REPO,
      name,
      sourceType: 'git',
      gitUrl: GIT_URL,
      gitBranch: 'main',
      storageRoot: `/bundles/${name}`,
    });
  const customClaim = (source: string) => ({
    userId: USER,
    repositoryId: REPO,
    taskId: null,
    diskPath: '.claude/agents/imported.md',
    templateId: `custom:${encodeURIComponent(source)}:agents%2Fimported.md`,
    templateKind: 'custom-agent',
    templateSchemaVersion: 1,
    templateContentHash: 'a'.repeat(64),
    writtenHash: 'b'.repeat(64),
    sourceStepId: 'project-state-import',
    source: 'backfill',
    importedAt: new Date(5),
    supersededAt: null,
  });
  const seedDescriptor = async (
    s: Awaited<ReturnType<typeof setup>>,
    inBase: boolean,
    name = 'theirs',
  ) => {
    await mkdir(join(s.root, STATE_DIR, 'bundles'), { recursive: true });
    await writeFile(
      join(s.root, descriptorPath),
      renderProjectState({ ...emptyProjectState(), bundles: [{ source: SOURCE, name }] }).get(
        bundleFileName(SOURCE),
      )!,
    );
    if (inBase) {
      s.syncSeed({
        [s.col.baseSnapshot]: json(
          normalizeProjectState({ ...emptyProjectState(), bundles: [{ source: SOURCE, name }] }),
        ),
      });
      await knownCheckout(s);
    }
  };

  it('writes a descriptor file for a local bundle, and carries it in the sync base', async () => {
    const s = await setup();
    localBundle(s, 'team-kit');

    const { written, removed } = await s.writeFull(context(), true);

    expect(removed).toEqual([]);
    expect(written).toContain(descriptorPath);
    expect(await bundleFiles(s.root)).toEqual([descriptorPath]);
    expect(descriptorOn(s.root)).toEqual({ source: SOURCE, name: 'team-kit' });
    expect(baseBundles(s)).toEqual([{ source: SOURCE, name: 'team-kit' }]);
  });

  it('writes one file, under the smallest name, for two bundles at one source', async () => {
    const s = await setup();
    localBundle(s, 'zeta-kit');
    localBundle(s, 'alpha-kit');

    await s.writeFull(context(), true);

    expect(await bundleFiles(s.root)).toEqual([descriptorPath]);
    expect(descriptorOn(s.root)).toEqual({ source: SOURCE, name: 'alpha-kit' });
    expect(baseBundles(s)).toEqual([{ source: SOURCE, name: 'alpha-kit' }]);
    expect(s.columnOf(REPO)).not.toBeNull();
  });

  it('keeps a teammate’s descriptor while a claim names its source', async () => {
    const s = await setup();
    await seedDescriptor(s, true);
    s.fake.insert(schema.onboardingArtifacts, customClaim(SOURCE));

    const { written, removed } = await s.writeFull(context(), true);

    expect(removed).toEqual([]);
    expect(written).toContain(descriptorPath);
    expect(descriptorOn(s.root)).toEqual({ source: SOURCE, name: 'theirs' });
    expect(baseBundles(s)).toEqual([{ source: SOURCE, name: 'theirs' }]);
  });

  it('removes a descriptor no bundle holds and no claim names, and reports it as removed', async () => {
    const s = await setup();
    await seedDescriptor(s, true);

    const { written, removed } = await s.writeFull(context(), true);

    expect(removed).toEqual([descriptorPath]);
    expect(written).not.toContain(descriptorPath);
    expect(await bundleFiles(s.root)).toEqual([]);
    expect(baseBundles(s)).toEqual([]);
  });

  it('reports a descriptor already gone from disk as removed', async () => {
    const s = await setup();
    await seedDescriptor(s, true);
    await rm(join(s.root, descriptorPath));
    await knownCheckout(s);

    const { removed } = await s.writeFull(context(), true);

    expect(removed).toEqual([descriptorPath]);
    expect(baseBundles(s)).toEqual([]);
  });

  it('leaves a descriptor file the previous base never named', async () => {
    const s = await setup();
    await seedDescriptor(s, false);

    await expect(s.writeFull(context(), true)).rejects.toBeInstanceOf(ProjectStateMovedError);
    expect(descriptorOn(s.root)).toEqual({ source: SOURCE, name: 'theirs' });
  });
});

describe('writeProjectStateRecord: a file already holding the bytes', () => {
  const identity = (path: string) => {
    const info = statSync(path, { bigint: true });
    return `${info.ino}:${info.mtimeNs}`;
  };

  it('is left in place and still listed as written', async () => {
    const s = await setup();
    await s.write(context(), true);
    const before = [FORMAT, RENDER].map((rel) => identity(join(s.root, rel)));

    const second = await s.writeFull(context(), true);

    expect([FORMAT, RENDER].map((rel) => identity(join(s.root, rel)))).toEqual(before);
    expect(second.written).toEqual(expect.arrayContaining([FORMAT, RENDER]));
  });

  it('holds a malformed hand edit instead of replacing bytes it never imported', async () => {
    const s = await setup();
    await s.write(context(), true);
    await writeFile(join(s.root, RENDER), 'edited by hand\n');
    await expect(s.write(context(), true)).rejects.toBeInstanceOf(ProjectStateMovedError);
    expect(s.onDisk().render).toBe('edited by hand\n');
  });
});

describe('writeProjectStateColumn: a write that fails', () => {
  const column = () => ({ ...portableOnly(), rtkChoiceRecorded: true });

  async function failing(keepColumnOnFailure: boolean) {
    const s = await setup();
    await s.fake.db
      .update(schema.repositories)
      .set({ renderContext: column() })
      .where(eq(schema.repositories.id, REPO));
    await writeFile(join(s.root, '.haive-data'), 'a file where the state directory goes');
    const error = await writeProjectStateColumn(s.fake.db as unknown as Database, {
      repositoryId: REPO,
      repoPath: s.root,
      column: column() as never,
      expectedColumns: [column()],
      keepColumnOnFailure,
    }).catch((err: unknown) => err);
    return { s, error };
  }

  it('clears the column it could not move, as a writer does', async () => {
    const { s, error } = await failing(false);

    expect(error).toBeInstanceOf(ProjectStateMovedError);
    expect(s.columnOf(REPO)).toEqual(column());
  });

  it('leaves the column alone when it asks to, since the sweep moved it nowhere', async () => {
    const { s, error } = await failing(true);

    expect(error).toBeInstanceOf(ProjectStateMovedError);
    expect(s.columnOf(REPO)).toEqual(column());
  });
});

describe('writeProjectStateRecord: the portable settings and the environment', () => {
  const SETTINGS = `${STATE_DIR}/settings`;
  const ENVIRONMENT = `${STATE_DIR}/project/environment.json`;
  const settingFiles = async (root: string) =>
    (await listFiles(root)).filter((f) => f.startsWith(`${SETTINGS}/`));
  const read = (root: string, rel: string) =>
    JSON.parse(readFileSync(join(root, rel), 'utf8')) as unknown;
  const baseOf = (s: Awaited<ReturnType<typeof setup>>) =>
    s.syncRows()[0]![s.col.baseSnapshot] as {
      settings: Record<string, unknown>;
      environment: unknown;
    };
  const setColumns = (s: Awaited<ReturnType<typeof setup>>, values: Record<string, unknown>) =>
    s.fake.db.update(schema.repositories).set(values).where(eq(schema.repositories.id, REPO));
  const ENV_MIRROR = {
    schemaVersion: 1,
    envDetectData: { project: { name: 'acme' } },
    confirmedValues: { webserver: 'nginx-fpm' },
  };

  it('writes one file per setting the repository holds, and carries them in the base', async () => {
    const s = await setup();
    await setColumns(s, {
      scopeExcludeGlobs: ['vendor', 'node_modules'],
      rtkEnabled: false,
      rtkVersion: '0.42.4',
      lspServers: ['vtsls'],
      lspServerVersions: { vtsls: '1.0.0' },
      chromeDevtoolsMcpVersion: '0.9.0',
      reviewDimensions: ['security'],
    });

    const { written } = await s.writeFull(context(), true);

    expect(await settingFiles(s.root)).toEqual(
      [
        'chrome-devtools-mcp-version',
        'lsp-server-versions',
        'lsp-servers',
        'review-dimensions',
        'rtk-enabled',
        'rtk-version',
        'scope-exclude-globs',
      ].map((name) => `${SETTINGS}/${name}.json`),
    );
    expect(read(s.root, `${SETTINGS}/scope-exclude-globs.json`)).toEqual([
      'node_modules',
      'vendor',
    ]);
    expect(read(s.root, `${SETTINGS}/rtk-enabled.json`)).toBe(false);
    expect(written).toContain(`${SETTINGS}/rtk-version.json`);
    expect(Object.keys(baseOf(s).settings).sort()).toHaveLength(7);
    expect(baseOf(s).settings['rtk-version']).toBe('0.42.4');
  });

  it('writes no file for a column that holds nothing', async () => {
    const s = await setup();

    await s.writeFull(context(), true);

    expect(await settingFiles(s.root)).toEqual([]);
    expect(baseOf(s).settings).toEqual({});
    expect(baseOf(s).environment).toBeNull();
  });

  it('never writes the app login or the verify commands', async () => {
    const s = await setup();
    await setColumns(s, {
      scopeExcludeGlobs: ['vendor'],
      appAuth: { loginUrl: 'https://evil.example/login' },
      verifyCommands: { test: 'rm -rf /' },
    });

    await s.writeFull(context(), true);

    const all = await listFiles(s.root);
    expect(all.filter((f) => /app-auth|verify/.test(f))).toEqual([]);
    const text = all.map((f) => readFileSync(join(s.root, f), 'utf8')).join('\n');
    expect(text).not.toMatch(/evil\.example|rm -rf/);
    expect(JSON.stringify(baseOf(s))).not.toMatch(/evil\.example|rm -rf/);
  });

  it('removes the file of a setting unset since the last write, and reports it', async () => {
    const s = await setup();
    await setColumns(s, { scopeExcludeGlobs: ['vendor'], rtkVersion: '0.42.4' });
    await s.writeFull(context(), true);
    await setColumns(s, { scopeExcludeGlobs: null });

    const { written, removed } = await s.writeFull(context(), true);

    expect(removed).toEqual([`${SETTINGS}/scope-exclude-globs.json`]);
    expect(written).not.toContain(`${SETTINGS}/scope-exclude-globs.json`);
    expect(await settingFiles(s.root)).toEqual([`${SETTINGS}/rtk-version.json`]);
    expect(Object.keys(baseOf(s).settings)).toEqual(['rtk-version']);
  });

  describe('the onboarding tooling unit', () => {
    const TOOLING = `${SETTINGS}/onboarding-tooling.json`;
    const COLUMN = {
      schemaVersion: 1,
      tooling: {
        ragMode: 'internal',
        embeddingModel: 'nomic-embed-text',
        ollamaUrl: 'http://10.0.0.5:11434',
        ragConnectionString: 'postgres://u:p@h/d',
        acceptedMcpSettingsMark: 'mark',
        mcpSettingsJson: '{"mcpServers":{}}',
      },
    };

    it('writes the tooling without its machine-local keys, and carries it in the base', async () => {
      const s = await setup();
      await setColumns(s, { onboardingTooling: COLUMN });

      const { written } = await s.writeFull(context(), true);

      expect(written).toContain(TOOLING);
      expect(read(s.root, TOOLING)).toEqual({
        ragMode: 'internal',
        embeddingModel: 'nomic-embed-text',
        mcpSettingsJson: '{"mcpServers":{}}',
      });
      expect(baseOf(s).settings['onboarding-tooling']).toEqual(read(s.root, TOOLING));
      const all = await listFiles(s.root);
      const text = all.map((f) => readFileSync(join(s.root, f), 'utf8')).join('\n');
      expect(text).not.toMatch(/10\.0\.0\.5|postgres:\/\/|mark/);
    });

    it('writes a server list held for consent under mcpSettingsJson, so the team keeps its list', async () => {
      const s = await setup();
      const { mcpSettingsJson: _own, acceptedMcpSettingsMark: _mark, ...rest } = COLUMN.tooling;
      await setColumns(s, {
        onboardingTooling: {
          schemaVersion: 1,
          tooling: {
            ...rest,
            importedMcpSettingsJson: '{"mcpServers":{"x":{"command":"c"}}}',
            importedMcpServerNames: ['x'],
          },
        },
      });

      await s.writeFull(context(), true);

      expect(read(s.root, TOOLING)).toEqual({
        ragMode: 'internal',
        embeddingModel: 'nomic-embed-text',
        mcpSettingsJson: '{"mcpServers":{"x":{"command":"c"}}}',
      });
    });

    it('writes no file for a column that holds nothing or another schema version', async () => {
      const s = await setup();
      await s.writeFull(context(), true);
      expect(existsSync(join(s.root, TOOLING))).toBe(false);

      await setColumns(s, { onboardingTooling: { ...COLUMN, schemaVersion: 2 } });
      await s.writeFull(context(), true);
      expect(existsSync(join(s.root, TOOLING))).toBe(false);
    });

    it('removes the file once the column is gone, and reports it', async () => {
      const s = await setup();
      await setColumns(s, { onboardingTooling: COLUMN });
      await s.writeFull(context(), true);
      await setColumns(s, { onboardingTooling: null });

      const { removed } = await s.writeFull(context(), true);

      expect(removed).toEqual([TOOLING]);
      expect(baseOf(s).settings).toEqual({});
    });

    it('leaves a unit file the previous base never named', async () => {
      const s = await setup();
      await mkdir(join(s.root, SETTINGS), { recursive: true });
      await writeFile(join(s.root, TOOLING), '{"ragMode":"theirs"}\n');

      await expect(s.writeFull(context(), true)).rejects.toBeInstanceOf(ProjectStateMovedError);
      expect(read(s.root, TOOLING)).toEqual({ ragMode: 'theirs' });
    });
  });

  it('leaves a settings file the previous base never named', async () => {
    const s = await setup();
    await mkdir(join(s.root, SETTINGS), { recursive: true });
    await writeFile(join(s.root, `${SETTINGS}/from-a-newer-release.json`), '1\n');

    await expect(s.writeFull(context(), true)).rejects.toBeInstanceOf(ProjectStateMovedError);
    expect(await settingFiles(s.root)).toEqual([`${SETTINGS}/from-a-newer-release.json`]);
  });

  it('writes the environment without its schema version, and removes it once the column is gone', async () => {
    const s = await setup();
    await setColumns(s, { onboardingEnvironment: ENV_MIRROR });

    const first = await s.writeFull(context(), true);

    expect(first.written).toContain(ENVIRONMENT);
    expect(read(s.root, ENVIRONMENT)).toEqual({
      envDetectData: ENV_MIRROR.envDetectData,
      confirmedValues: ENV_MIRROR.confirmedValues,
    });
    expect(baseOf(s).environment).toEqual({
      envDetectData: ENV_MIRROR.envDetectData,
      confirmedValues: ENV_MIRROR.confirmedValues,
    });

    await setColumns(s, { onboardingEnvironment: null });
    const second = await s.writeFull(context(), true);

    expect(second.removed).toEqual([ENVIRONMENT]);
    expect(existsSync(join(s.root, ENVIRONMENT))).toBe(false);
    expect(baseOf(s).environment).toBeNull();
  });

  it('writes no environment for a mirror of another schema version', async () => {
    const s = await setup();
    await setColumns(s, { onboardingEnvironment: { ...ENV_MIRROR, schemaVersion: 2 } });

    await s.writeFull(context(), true);

    expect(existsSync(join(s.root, ENVIRONMENT))).toBe(false);
  });

  it('writes the other install’s value for a contested setting, and the base’s into the base', async () => {
    const s = await setup();
    await setColumns(s, { lspServers: ['pyright'], rtkVersion: '0.42.4' });
    s.pend('settings/lsp-servers.json', {
      base: ['vtsls'],
      local: ['pyright'],
      incoming: ['gopls'],
    });

    await s.writeFull(context(), true);

    expect(read(s.root, `${SETTINGS}/lsp-servers.json`)).toEqual(['gopls']);
    expect(read(s.root, `${SETTINGS}/rtk-version.json`)).toBe('0.42.4');
    expect(baseOf(s).settings['lsp-servers']).toEqual(['vtsls']);
    expect(baseOf(s).settings['rtk-version']).toBe('0.42.4');
    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(row).toMatchObject({ resolvedAt: null, local: { v: ['pyright'] } });
  });

  it('leaves a contested setting out of the base where the base held none, and out of the file where the other install has none', async () => {
    const s = await setup();
    await setColumns(s, { lspServers: ['pyright'] });
    s.pend('settings/lsp-servers.json', { local: ['pyright'] });

    await s.writeFull(context(), true);

    expect(existsSync(join(s.root, `${SETTINGS}/lsp-servers.json`))).toBe(false);
    expect(baseOf(s).settings).toEqual({});
  });

  it('follows the column in the row’s local side, and closes the row once the column holds the other value', async () => {
    const s = await setup();
    await setColumns(s, { lspServers: ['pyright'] });
    s.pend('settings/lsp-servers.json', {
      base: ['vtsls'],
      local: ['jdtls'],
      incoming: ['gopls'],
    });

    await s.writeFull(context(), true);
    let [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(row).toMatchObject({ resolvedAt: null, local: { v: ['pyright'] } });

    await setColumns(s, { lspServers: ['gopls'] });
    await s.writeFull(context(), true);
    [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(row).toMatchObject({ resolution: 'converged' });
    expect(read(s.root, `${SETTINGS}/lsp-servers.json`)).toEqual(['gopls']);
  });

  it('writes the other install’s value for a contested environment key, beside ours for the rest', async () => {
    const s = await setup();
    await setColumns(s, { onboardingEnvironment: ENV_MIRROR });
    s.pend('project/environment.json#confirmedValues', {
      base: { webserver: 'apache' },
      local: { webserver: 'nginx-fpm' },
      incoming: { webserver: 'caddy' },
    });

    await s.writeFull(context(), true);

    expect(read(s.root, ENVIRONMENT)).toEqual({
      envDetectData: ENV_MIRROR.envDetectData,
      confirmedValues: { webserver: 'caddy' },
    });
    expect(baseOf(s).environment).toEqual({
      envDetectData: ENV_MIRROR.envDetectData,
      confirmedValues: { webserver: 'apache' },
    });
  });

  describe('an RTK choice nobody recorded', () => {
    const RTK = `${SETTINGS}/rtk-enabled.json`;

    it('writes no rtk-enabled file for the column’s default, and names none in the base', async () => {
      const s = await setup();
      await setColumns(s, { rtkEnabled: true, rtkVersion: '0.42.4' });

      await s.writeFull(context(), false);

      expect(existsSync(join(s.root, RTK))).toBe(false);
      expect(read(s.root, `${SETTINGS}/rtk-version.json`)).toBe('0.42.4');
      expect(Object.keys(baseOf(s).settings)).toEqual(['rtk-version']);
    });

    it('leaves a teammate’s rtk-enabled file alone, though the previous base names it', async () => {
      const s = await setup();
      await setColumns(s, { rtkEnabled: false });
      await mkdir(join(s.root, SETTINGS), { recursive: true });
      await writeFile(join(s.root, RTK), 'false\n');
      s.syncSeed({ [s.col.baseSnapshot]: { settings: { 'rtk-enabled': false } } });
      await knownCheckout(s);

      const { removed } = await s.writeFull(context(), false);

      expect(removed).toEqual([]);
      expect(read(s.root, RTK)).toBe(false);
      expect(baseOf(s).settings).toEqual({});
    });

    it('writes the file once the choice is recorded, whatever the value', async () => {
      const s = await setup();
      await setColumns(s, { rtkEnabled: true });

      await s.writeFull(context(), true);

      expect(read(s.root, RTK)).toBe(true);
      expect(baseOf(s).settings['rtk-enabled']).toBe(true);
    });

    describe('that a person has since switched on this install', () => {
      const SWITCHED = new Date(1000);

      it('writes the file and names it in the base, though the column recorded no choice', async () => {
        const s = await setup();
        await setColumns(s, { rtkEnabled: false, rtkChoiceMadeAt: SWITCHED });

        await s.writeFull(context(), false);

        expect(read(s.root, RTK)).toBe(false);
        expect(baseOf(s).settings['rtk-enabled']).toBe(false);
      });

      it('rewrites it when the person switches again', async () => {
        const s = await setup();
        await setColumns(s, { rtkEnabled: false, rtkChoiceMadeAt: SWITCHED });
        await s.writeFull(context(), false);

        await setColumns(s, { rtkEnabled: true });
        await s.writeFull(context(), false);

        expect(read(s.root, RTK)).toBe(true);
        expect(baseOf(s).settings['rtk-enabled']).toBe(true);
      });

      it('owns a file the previous base names, as it does once the choice is recorded', async () => {
        const s = await setup();
        await setColumns(s, { rtkChoiceMadeAt: SWITCHED });
        await mkdir(join(s.root, SETTINGS), { recursive: true });
        await writeFile(join(s.root, RTK), 'false\n');
        s.syncSeed({ [s.col.baseSnapshot]: { settings: { 'rtk-enabled': false } } });
        await knownCheckout(s);

        const { removed } = await s.writeFull(context(), false);

        expect(removed).toEqual([RTK]);
      });
    });
  });

  it('writes the column’s RTK value while the RTK question is pending, and leaves the question pending', async () => {
    const s = await setup();
    await setColumns(s, { rtkEnabled: true });
    s.pend('settings/rtk-enabled.json', { base: true, local: true, incoming: false });

    await s.writeFull(context(), true);

    expect(read(s.root, `${SETTINGS}/rtk-enabled.json`)).toBe(true);
    const [row] = s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    expect(row).toMatchObject({ unit: 'settings/rtk-enabled.json', resolvedAt: null });
  });

  describe('the agent-rules text setting', () => {
    const NAME = 'agent-rules';
    const UNIT = 'settings/agent-rules.md';
    const MD = `${STATE_DIR}/${UNIT}`;
    const PLANTED = `${SETTINGS}/agent-rules.json`;
    const T = '# House rules\n\n- Keep it small.\n';
    const T2 = '# House rules\n\n- Keep it small.\n- Mine.\n';
    const U = '# House rules\n\n- Keep it small.\n- Theirs.\n';
    const text = (root: string) => readFileSync(join(root, MD), 'utf8');
    const rows = (s: Awaited<ReturnType<typeof setup>>) =>
      s.fake.rows(schema.projectStateConflicts) as Record<string, unknown>[];
    /** A checkout whose base names the file, as a sync or an earlier write left it. */
    const named = async (s: Awaited<ReturnType<typeof setup>>, bytes: string, base = bytes) => {
      await mkdir(join(s.root, SETTINGS), { recursive: true });
      await writeFile(join(s.root, MD), bytes);
      s.syncSeed({ [s.col.baseSnapshot]: { settings: { [NAME]: base } } });
      await knownCheckout(s);
    };

    it('writes the text verbatim as the .md and names it in the base', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: T });

      const { written } = await s.writeFull(context(), true);

      expect(text(s.root)).toBe(T);
      expect(await settingFiles(s.root)).toEqual([MD]);
      expect(written).toContain(MD);
      expect(baseOf(s).settings[NAME]).toBe(T);
    });

    it('writes a 0-byte file for an explicit empty override and names the empty text in the base', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: '' });

      const { written } = await s.writeFull(context(), true);

      expect(statSync(join(s.root, MD)).size).toBe(0);
      expect(written).toContain(MD);
      expect(baseOf(s).settings[NAME]).toBe('');
      expect(Object.keys(baseOf(s).settings)).toEqual([NAME]);
    });

    it('rewrites a file that is not canonical to the canonical bytes', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: T });
      await named(s, T.replace(/\n/g, '\r\n'), T);

      await s.writeFull(context(), true);

      expect(text(s.root)).toBe(T);
    });

    it('removes the file once the column is back to NULL, and reports it', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: T });
      await s.writeFull(context(), true);
      await setColumns(s, { agentRulesOverride: null });

      const { removed } = await s.writeFull(context(), true);

      expect(removed).toEqual([MD]);
      expect(existsSync(join(s.root, MD))).toBe(false);
      expect(baseOf(s).settings).toEqual({});
    });

    it('removes a file the previous base names where the column holds none', async () => {
      const s = await setup();
      await named(s, T);

      const { removed } = await s.writeFull(context(), true);

      expect(removed).toEqual([MD]);
      expect(existsSync(join(s.root, MD))).toBe(false);
    });

    it('keeps the file of a column that holds the text, though the previous base names it', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: T });
      await named(s, T);

      const { removed } = await s.writeFull(context(), true);

      expect(removed).toEqual([]);
      expect(text(s.root)).toBe(T);
      expect(baseOf(s).settings[NAME]).toBe(T);
    });

    it('leaves a file the previous base never named', async () => {
      const s = await setup();
      await mkdir(join(s.root, SETTINGS), { recursive: true });
      await writeFile(join(s.root, MD), T);

      await expect(s.writeFull(context(), true)).rejects.toBeInstanceOf(ProjectStateMovedError);
      expect(text(s.root)).toBe(T);
    });

    it('never touches a planted settings/agent-rules.json, whatever the column holds', async () => {
      const s = await setup();
      await mkdir(join(s.root, SETTINGS), { recursive: true });
      await writeFile(join(s.root, PLANTED), '"planted"\n');
      await knownCheckout(s);
      await setColumns(s, { agentRulesOverride: T });

      await s.writeFull(context(), true);
      expect(text(s.root)).toBe(T);
      expect(readFileSync(join(s.root, PLANTED), 'utf8')).toBe('"planted"\n');

      await setColumns(s, { agentRulesOverride: null });
      const { removed } = await s.writeFull(context(), true);
      expect(removed).toEqual([MD]);
      expect(readFileSync(join(s.root, PLANTED), 'utf8')).toBe('"planted"\n');
    });

    it('writes the other install’s text for a contested setting into the .md, and the base’s into the base', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: T2 });
      s.pend(UNIT, { base: T, local: T2, incoming: U });

      await s.writeFull(context(), true);

      expect(text(s.root)).toBe(U);
      expect(baseOf(s).settings[NAME]).toBe(T);
      expect(rows(s)).toHaveLength(1);
      expect(rows(s)[0]).toMatchObject({ unit: UNIT, resolvedAt: null, local: { v: T2 } });
    });

    it('writes the other install’s empty text as a 0-byte file', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: T2 });
      s.pend(UNIT, { base: T, local: T2, incoming: '' });

      await s.writeFull(context(), true);

      expect(statSync(join(s.root, MD)).size).toBe(0);
      expect(baseOf(s).settings[NAME]).toBe(T);
    });

    it('follows the column in the row’s local side, and closes the row once the column holds the other text', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: T2 });
      s.pend(UNIT, { base: T, local: 'an older text\n', incoming: U });

      await s.writeFull(context(), true);
      expect(rows(s)[0]).toMatchObject({ resolvedAt: null, local: { v: T2 } });

      await setColumns(s, { agentRulesOverride: U });
      await s.writeFull(context(), true);
      expect(rows(s)[0]).toMatchObject({ resolution: 'converged' });
      expect(text(s.root)).toBe(U);
    });

    it('closes the row as converged once the column holds the empty text the other install has', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: '' });
      s.pend(UNIT, { base: T, local: T2, incoming: '' });

      await s.writeFull(context(), true);

      expect(rows(s)[0]).toMatchObject({ resolution: 'converged' });
      expect(statSync(join(s.root, MD)).size).toBe(0);
    });

    it('records the empty text as the row’s local side, not as an absent one', async () => {
      const s = await setup();
      await setColumns(s, { agentRulesOverride: '' });
      s.pend(UNIT, { base: T, local: T2, incoming: U });

      await s.writeFull(context(), true);

      expect(rows(s)[0]).toMatchObject({ resolvedAt: null, local: { v: '' } });
    });
  });
});

/** Preparation is private, pre-intent IO. It must add no public record or unrelated file. */
async function publicFilesWithPrivateImages(root: string): Promise<string[]> {
  const files = await listFiles(root);
  const prefix = '.haive-data/.state-writes/';
  const staged = files.filter((rel) => rel.startsWith(prefix));
  expect(staged.length).toBeGreaterThan(0);
  for (const rel of staged)
    expect(rel).toMatch(
      /^\.haive-data\/\.state-writes\/(?:\.gitignore|[a-f0-9-]{36}\/\d+\.(?:before|after|forward|undo))$/,
    );
  expect(await readFile(join(root, prefix, '.gitignore'), 'utf8')).toBe('*\n');
  return files.filter((rel) => !rel.startsWith(prefix));
}
