import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { HAIVE_DATA_FILES } from '@haive/shared';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import { importPlanMirror } from '../src/plan/mirror.js';
import { persistDetection } from '../src/repo/clone.js';

vi.mock('../src/project-state/sync.js', () => ({ syncProjectStateFromCheckout: vi.fn() }));

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const ROOT = '00000000-0000-4000-8000-0000000000c1';
const OWN_ROOT = '00000000-0000-4000-8000-0000000000c2';

const MIRROR = {
  schemaVersion: 2,
  nodes: [
    {
      id: ROOT,
      parentId: null,
      ordinal: 0,
      title: 'Shop',
      kind: 'component',
      body: null,
      status: 'todo',
      taskable: false,
    },
  ],
  edges: [],
  codeLinks: [],
};

const dirs: string[] = [];
beforeEach(() => {
  vi.mocked(syncProjectStateFromCheckout).mockResolvedValue({ outcome: 'unchanged' } as never);
});
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function checkout(mirror: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plan-mirror-rescan-'));
  dirs.push(dir);
  if (mirror !== undefined) {
    await mkdir(join(dir, '.haive-data'));
    await writeFile(join(dir, HAIVE_DATA_FILES.plan), JSON.stringify(mirror));
  }
  return dir;
}

function repository(opts: { hasPlan?: boolean } = {}) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planNodes: schema.planNodes,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
    status: 'cloning',
  });
  if (opts.hasPlan) {
    fake.insert(schema.planNodes, {
      id: OWN_ROOT,
      repositoryId: REPO,
      parentId: null,
      path: `/${OWN_ROOT}/`,
      ordinal: 0,
      title: 'Shop',
      kind: 'component',
      status: 'todo',
      taskable: false,
    });
  }
  const db = fake.db as unknown as Database;
  const snapshotErrors = () =>
    fake
      .rows(schema.planMirrorState)
      .map((row) => row.lastError)
      .filter((error) => error != null);
  return { db, snapshotErrors };
}

describe('a rescan and the plan snapshot', () => {
  it('records no snapshot error for a repository that already has its plan', async () => {
    const { db, snapshotErrors } = repository({ hasPlan: true });
    await persistDetection(db, REPO, await checkout(MIRROR));
    expect(snapshotErrors()).toEqual([]);
  });

  it('records no snapshot error for a checkout that carries no plan snapshot', async () => {
    const { db, snapshotErrors } = repository();
    await persistDetection(db, REPO, await checkout(undefined));
    expect(snapshotErrors()).toEqual([]);
  });

  it('still records a snapshot it refused, with the reason', async () => {
    const { db, snapshotErrors } = repository();
    await persistDetection(db, REPO, await checkout({ ...MIRROR, schemaVersion: 99 }));
    expect(snapshotErrors()).toEqual([
      'Plan snapshot not imported: schemaVersion 99 not supported',
    ]);
  });

  it('restores the plan of a fresh checkout without recording an error', async () => {
    const { db, snapshotErrors } = repository();
    await persistDetection(db, REPO, await checkout(MIRROR));
    expect(snapshotErrors()).toEqual([]);
  });
});

describe('importPlanMirror says why it left a checkout alone', () => {
  const cases: [why: string, mirror: unknown, hasPlan: boolean, code: string][] = [
    ['there is no snapshot', undefined, false, 'no_mirror'],
    ['the repository already has a plan', MIRROR, true, 'has_plan'],
    ['the snapshot is refused', { ...MIRROR, schemaVersion: 99 }, false, 'refused'],
    [
      'the snapshot has no root',
      { ...MIRROR, nodes: [{ ...MIRROR.nodes[0], parentId: ROOT }] },
      false,
      'refused',
    ],
  ];

  it.each(cases)('when %s', async (_why, mirror, hasPlan, code) => {
    const { db } = repository({ hasPlan });
    const result = await importPlanMirror(db, REPO, await checkout(mirror));
    expect(result).toMatchObject({ imported: false, code });
  });

  it('keeps the human wording beside the code', async () => {
    const { db } = repository({ hasPlan: true });
    expect(await importPlanMirror(db, REPO, await checkout(MIRROR))).toEqual({
      imported: false,
      code: 'has_plan',
      reason: 'repository already has a plan',
    });
  });

  it('reports a restore as imported', async () => {
    const { db } = repository();
    expect(await importPlanMirror(db, REPO, await checkout(MIRROR))).toEqual({ imported: true });
  });
});
