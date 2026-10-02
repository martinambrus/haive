import { statSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  emptyProjectState,
  normalizeProjectState,
  renderProjectState,
  type ProjectRender,
  type ProjectStateClaim,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';

// The reads the sync asks of fs-safe, by absolute path. fs-safe is the one door to the checkout
// (the ratchet allows no other), so this sees every file read and every directory listing.
const fsCalls = vi.hoisted(() => ({ reads: [] as string[], lists: [] as string[] }));
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  const { join: joinPath } = await import('node:path');
  const noting = <F extends (...args: never[]) => unknown>(into: string[], fn: F): F =>
    ((...args: unknown[]) => {
      into.push(joinPath(String(args[0]), String(args[1])));
      return (fn as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as F;
  return {
    ...real,
    readFileNoFollow: noting(fsCalls.reads, real.readFileNoFollow),
    readTextNoFollow: noting(fsCalls.reads, real.readTextNoFollow),
    openFileNoFollow: noting(fsCalls.reads, real.openFileNoFollow),
    readdirNoFollow: noting(fsCalls.lists, real.readdirNoFollow),
  };
});

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const STATE = '.haive-data/state';
const MAX_ENTRIES = 4_096;
const MAX_BYTES = 16 * 1024 * 1024;

const dirs: string[] = [];
beforeEach(() => {
  fsCalls.reads.length = 0;
  fsCalls.lists.length = 0;
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
// A number named whole, so a count that merely contains these digits does not satisfy it.
const ENTRY_CAP = /(?<![\d,])4,?096(?![\d,])/;
const BYTE_CAP = /(?<![\d,])(?:16 ?MiB|16 ?MB|16,?777,?216)(?![\d,])/i;

const BASE: ProjectRender = {
  projectInfo: { name: 'acme', framework: 'drupal' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  lspLanguages: ['php-extended'],
};
const baseOf = (): unknown => json(normalizeProjectState({ ...emptyProjectState(), render: BASE }));
const stored = (): unknown => ({ ...BASE, rtkChoiceRecorded: true });

async function setup(seed: { column?: unknown; base?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'project-state-bounds-'));
  dirs.push(root);
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateSync: schema.projectStateSync,
    tasks: schema.tasks,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
    renderContext: seed.column ?? null,
  });
  if (seed.base !== undefined) {
    fake.insert(schema.projectStateSync, {
      repositoryId: REPO,
      baseSnapshot: seed.base,
      lastError: null,
      updatedAt: new Date(0),
    });
  }
  const writes: string[] = [];
  const note = (verb: string) => (table: PgTable) => {
    writes.push(`${verb} ${getTableName(table)}`);
  };
  fake.hooks.beforeInsert = note('insert');
  fake.hooks.beforeUpdate = note('update');
  fake.hooks.beforeDelete = note('delete');
  const db = fake.db as unknown as Database;
  return {
    root,
    writes,
    run: (repoPath = root) => syncProjectStateFromCheckout(db, { repositoryId: REPO, repoPath }),
    column: () => fake.rows(schema.repositories)[0]?.renderContext ?? null,
    rows: () => fake.rows(schema.projectStateSync),
  };
}

// ---- trees -----------------------------------------------------------------------------------

const inBatches = async (n: number, each: (i: number) => Promise<void>): Promise<void> => {
  for (let at = 0; at < n; at += 256) {
    await Promise.all(Array.from({ length: Math.min(256, n - at) }, (_, i) => each(at + i)));
  }
};

/** The record's own files under the state dir: format.json, project/, project/render.json. */
async function putRecord(root: string, over: Partial<ProjectStateRecord> = {}): Promise<void> {
  const files = [...renderProjectState({ ...emptyProjectState(), render: BASE, ...over })];
  const parents = new Set(files.map(([rel]) => dirname(join(root, STATE, rel))));
  await Promise.all([...parents].map((dir) => mkdir(dir, { recursive: true })));
  await inBatches(files.length, async (i) => {
    const [rel, text] = files[i]!;
    await writeFile(join(root, STATE, rel), text);
  });
}

/** `n` files of `bytes` each in one directory; a sparse file reads as zeros and costs no disk. */
async function fill(root: string, dir: string, n: number, bytes: number): Promise<void> {
  await mkdir(join(root, STATE, dir), { recursive: true });
  await inBatches(n, async (i) => {
    const path = join(root, STATE, dir, `f${i}.txt`);
    if (bytes <= 2) return writeFile(path, 'x\n'.slice(0, bytes));
    const file = await open(path, 'w');
    await file.truncate(bytes);
    await file.close();
  });
}

const countEntries = async (root: string): Promise<number> =>
  (await readdir(join(root, STATE), { recursive: true })).length;

/** A valid record, a `filler` directory and unclaimed files, so exactly `total` entries stand
 *  under the state dir: the record's 3, the directory, and the rest. */
async function entriesTree(root: string, total: number): Promise<void> {
  await putRecord(root);
  await fill(root, 'filler', total - 4, 2);
  expect(await countEntries(root)).toBe(total);
}

/** A valid record and a tree of directories with no file in them: `top` of them, `each` below. */
async function directoriesTree(root: string, top: number, each: number): Promise<void> {
  await putRecord(root);
  await inBatches(top, async (i) => {
    await Promise.all(
      Array.from({ length: each }, (_, j) =>
        mkdir(join(root, STATE, 'dirs', `d${i}`, `c${j}`), { recursive: true }),
      ),
    );
  });
}

/** A valid record and `n` files of a million bytes: each under the per-file cap of 1 MiB. */
async function bytesTree(root: string, n: number): Promise<void> {
  await putRecord(root);
  await fill(root, 'big', n, 1_000_000);
}

const claim = (i: number): ProjectStateClaim => ({
  path: `.claude/agents/agent-${i}.md`,
  templateId: `agent.agent-${i}`,
  kind: 'agent',
  schemaVersion: 1,
  templateHash: 'a'.repeat(64),
  writtenHash: 'b'.repeat(64),
  haiveVersion: '0.0.0-dev',
});

type Syncing = Awaited<ReturnType<typeof setup>>;

/** A refusal that made nothing: the column as it was, no row, no statement. */
function expectNothingImported(s: Syncing): void {
  expect(s.column()).toBeNull();
  expect(s.rows()).toEqual([]);
  expect(s.writes).toEqual([]);
}

/** A refusal on a repository that has a row: column and base untouched, the reason on the row, naming
 *  the cap that was crossed and not the other. */
function expectReasonOnRow(s: Syncing, names: RegExp, notNames: RegExp): void {
  expect(json(s.column())).toEqual(stored());
  expect(s.writes).toHaveLength(1);
  expect(s.writes[0]).toMatch(/^(insert|update) project_state_sync$/);
  const [row] = s.rows();
  expect(json(row?.baseSnapshot)).toEqual(baseOf());
  expect(row?.lastError).toMatch(names);
  expect(row?.lastError).not.toMatch(notNames);
  expect(row?.lastError).not.toMatch(/\n/);
}

const LONG = { timeout: 120_000 };

describe('syncProjectStateFromCheckout: the walk is bounded', () => {
  it('reads the checkout through fs-safe, which is where the cases below look', async () => {
    const s = await setup();
    await entriesTree(s.root, 12);

    expect((await s.run()).outcome).toBe('applied');

    expect(fsCalls.lists.length).toBeGreaterThan(0);
    expect(fsCalls.reads.length).toBeGreaterThan(0);
  });

  describe('entries', () => {
    it('passes 4,096 entries in all and refuses 4,097, naming the entry cap', LONG, async () => {
      const at = await setup();
      await entriesTree(at.root, MAX_ENTRIES);

      expect((await at.run()).outcome).toBe('applied');

      expect(json(at.column())).toEqual(stored());
      expect(json(at.rows()[0]?.baseSnapshot)).toEqual(baseOf());

      await writeFile(join(at.root, STATE, 'filler', 'one-more.txt'), 'x\n');
      expect(await countEntries(at.root)).toBe(MAX_ENTRIES + 1);
      const past = await setup({ column: stored(), base: baseOf() });

      expect((await past.run(at.root)).outcome).toBe('refused');

      expectReasonOnRow(past, ENTRY_CAP, BYTE_CAP);
    });

    it(
      'refuses claim files past the cap as it refuses any other file, and reads no file past the 4,097th entry',
      LONG,
      async () => {
        const s = await setup();
        const claims = Array.from({ length: 2 * MAX_ENTRIES - 4 }, (_, i) => claim(i));
        await putRecord(s.root, { claims });
        expect(await countEntries(s.root)).toBe(2 * MAX_ENTRIES);

        expect((await s.run()).outcome).toBe('refused');

        expectNothingImported(s);
        expect(fsCalls.reads.length).toBeLessThanOrEqual(MAX_ENTRIES + 1);
      },
    );

    it(
      'counts directories: nested directories holding no file are refused past 4,096, and listed no further',
      LONG,
      async () => {
        const s = await setup();
        await directoriesTree(s.root, 80, 80);
        expect(await countEntries(s.root)).toBeGreaterThan(MAX_ENTRIES);
        const found = await readdir(join(s.root, STATE), { recursive: true, withFileTypes: true });
        expect(
          found
            .filter((e) => e.isFile())
            .map((e) => e.name)
            .sort(),
        ).toEqual(['format.json', 'render.json']);

        expect((await s.run()).outcome).toBe('refused');

        expectNothingImported(s);
        expect(fsCalls.lists.length).toBeLessThanOrEqual(MAX_ENTRIES + 1);
      },
    );
  });

  describe('bytes read in all', () => {
    it('refuses files each under 1 MiB that total over 16 MiB, naming the byte cap', async () => {
      const bare = await setup();
      await bytesTree(bare.root, 17);

      expect((await bare.run()).outcome).toBe('refused');

      expectNothingImported(bare);
      const seeded = await setup({ column: stored(), base: baseOf() });
      expect((await seeded.run(bare.root)).outcome).toBe('refused');
      expectReasonOnRow(seeded, BYTE_CAP, ENTRY_CAP);
    });

    it('imports files each under 1 MiB that total 16,000,000 bytes: under the cap', async () => {
      const s = await setup();
      await bytesTree(s.root, 16);

      expect((await s.run()).outcome).toBe('applied');

      expect(json(s.column())).toEqual(stored());
    });

    it('reads no file once the bytes read have passed 16 MiB: the file that crosses is the last', async () => {
      const s = await setup();
      await bytesTree(s.root, 40);

      expect((await s.run()).outcome).toBe('refused');

      const sizes = fsCalls.reads.map((path) => statSync(path).size);
      expect(sizes.slice(0, -1).reduce((all, size) => all + size, 0)).toBeLessThanOrEqual(
        MAX_BYTES,
      );
    });
  });
});
