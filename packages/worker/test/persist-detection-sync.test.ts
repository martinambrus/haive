import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { importPlanMirror, recordPlanMirrorError } from '../src/plan/mirror.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import { persistDetection } from '../src/repo/clone.js';

vi.mock('../src/project-state/sync.js', () => ({ syncProjectStateFromCheckout: vi.fn() }));
vi.mock('../src/plan/mirror.js', () => ({
  importPlanMirror: vi.fn(async () => ({
    imported: false,
    code: 'no_mirror',
    reason: 'no plan mirror',
  })),
  recordPlanMirrorError: vi.fn(),
}));

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('persistDetection and the project state sync', () => {
  it.each([
    ['finishes', () => Promise.resolve({ outcome: 'unchanged' })],
    ['throws', () => Promise.reject(new Error('sync refused'))],
  ])(
    'a sync that %s: the scan resolves, the repository is ready, the plan import runs after it',
    async (_how, behave) => {
      const root = await mkdtemp(join(tmpdir(), 'persist-detection-'));
      dirs.push(root);
      await mkdir(join(root, '.haive-data'));
      // A mirror file the legacy import reads, so the sync's place after it can be seen.
      await writeFile(
        join(root, '.haive-data/exclusions.json'),
        '{"schemaVersion":1,"scopeExcludeGlobs":["vendor/**"]}',
      );
      const fake = createFakeDb({ repositories: schema.repositories });
      fake.insert(schema.repositories, {
        id: REPO,
        userId: USER,
        name: 'acme',
        source: 'blank',
        status: 'cloning',
      });
      const seen: unknown[] = [];
      vi.mocked(syncProjectStateFromCheckout).mockImplementation(async () => {
        const row = fake.rows(schema.repositories)[0];
        seen.push([row?.status, row?.scopeExcludeGlobs]);
        return behave() as never;
      });
      const db = fake.db as unknown as Database;

      await expect(persistDetection(db, REPO, root)).resolves.toBeUndefined();

      expect(syncProjectStateFromCheckout).toHaveBeenCalledTimes(1);
      expect(syncProjectStateFromCheckout).toHaveBeenCalledWith(db, {
        repositoryId: REPO,
        repoPath: root,
      });
      expect(seen).toEqual([['ready', ['vendor/**']]]);
      expect(fake.rows(schema.repositories)[0]?.status).toBe('ready');
      expect(importPlanMirror).toHaveBeenCalledTimes(1);
      const [synced] = vi.mocked(syncProjectStateFromCheckout).mock.invocationCallOrder;
      const [planned] = vi.mocked(importPlanMirror).mock.invocationCallOrder;
      expect(planned).toBeGreaterThan(synced!);
    },
  );
});

describe('persistDetection and a plan snapshot it leaves alone', () => {
  it.each([
    ['no_mirror', 'invalid plan mirror: looks like a refusal', false],
    ['has_plan', 'invalid plan mirror: looks like a refusal', false],
    ['refused', 'repository already has a plan', true],
  ] as const)('%s, worded "%s": recorded as an error = %s', async (code, reason, recorded) => {
    const root = await mkdtemp(join(tmpdir(), 'persist-detection-'));
    dirs.push(root);
    const fake = createFakeDb({ repositories: schema.repositories });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      name: 'acme',
      source: 'blank',
      status: 'cloning',
    });
    vi.mocked(syncProjectStateFromCheckout).mockResolvedValue({ outcome: 'unchanged' } as never);
    vi.mocked(importPlanMirror).mockResolvedValueOnce({ imported: false, code, reason });
    const db = fake.db as unknown as Database;

    await persistDetection(db, REPO, root);

    if (recorded) {
      expect(recordPlanMirrorError).toHaveBeenCalledExactlyOnceWith(
        db,
        REPO,
        `Plan snapshot not imported: ${reason}`,
      );
    } else {
      expect(recordPlanMirrorError).not.toHaveBeenCalled();
    }
  });
});
