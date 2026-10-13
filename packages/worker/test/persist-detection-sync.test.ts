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
      const fake = createFakeDb({
        repositories: schema.repositories,
        projectStateOutbox: schema.projectStateOutbox,
      });
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
    const fake = createFakeDb({
      repositories: schema.repositories,
      projectStateOutbox: schema.projectStateOutbox,
    });
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

describe('persistDetection and a legacy mirror next to a record unit', () => {
  const ENV_MIRROR = {
    schemaVersion: 1,
    envDetectData: { project: { name: 'legacy' } },
    confirmedValues: {},
  };
  const RECORD_ENV = { schemaVersion: 1, envDetectData: { project: { name: 'record' } } };

  type Sync = 'applies' | 'throws' | 'refused' | 'deferred' | 'superseded' | 'absent';

  async function checkout(units: string[], sync: Sync, legacy = true) {
    const root = await mkdtemp(join(tmpdir(), 'persist-detection-'));
    dirs.push(root);
    await mkdir(join(root, '.haive-data/state/project'), { recursive: true });
    await mkdir(join(root, '.haive-data/state/settings'), { recursive: true });
    if (legacy) {
      await writeFile(join(root, '.haive-data/environment.json'), JSON.stringify(ENV_MIRROR));
      await writeFile(
        join(root, '.haive-data/exclusions.json'),
        '{"schemaVersion":1,"scopeExcludeGlobs":["legacy/**"]}',
      );
    }
    for (const unit of units) await writeFile(join(root, '.haive-data/state', unit), '{}');
    const fake = createFakeDb({
      repositories: schema.repositories,
      projectStateOutbox: schema.projectStateOutbox,
    });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      name: 'acme',
      source: 'blank',
      status: 'cloning',
    });
    vi.mocked(syncProjectStateFromCheckout).mockImplementation(async () => {
      if (sync === 'throws') throw new Error('sync refused');
      if (sync === 'applies') {
        fake.patch(schema.repositories, REPO, {
          onboardingEnvironment: RECORD_ENV,
          scopeExcludeGlobs: ['record/**'],
        });
        return { outcome: 'applied' } as never;
      }
      return { outcome: sync } as never;
    });
    await persistDetection(fake.db as unknown as Database, REPO, root);
    return fake.rows(schema.repositories)[0]!;
  }

  it('a sync that applies fills the column from the record, whatever the legacy file holds', async () => {
    const row = await checkout(
      ['project/environment.json', 'settings/scope-exclude-globs.json'],
      'applies',
    );

    expect(row.onboardingEnvironment).toEqual(RECORD_ENV);
    expect(row.scopeExcludeGlobs).toEqual(['record/**']);
  });

  it.each(['throws', 'refused', 'deferred', 'superseded', 'absent'] as const)(
    'a sync that %s: the still-empty columns are filled from the legacy files afterwards',
    async (sync) => {
      const row = await checkout(
        ['project/environment.json', 'settings/scope-exclude-globs.json'],
        sync,
      );

      expect(row.onboardingEnvironment).toEqual(ENV_MIRROR);
      expect(row.scopeExcludeGlobs).toEqual(['legacy/**']);
    },
  );

  it('decides per unit: the record fills one column, the legacy file the other', async () => {
    const row = await checkout(['project/environment.json'], 'applies');

    expect(row.onboardingEnvironment).toEqual(RECORD_ENV);
    expect(row.scopeExcludeGlobs).toEqual(['record/**']);
  });

  it('imports both legacy files before the sync when the record carries neither unit', async () => {
    const row = await checkout([], 'refused');

    expect(row.onboardingEnvironment).toEqual(ENV_MIRROR);
    expect(row.scopeExcludeGlobs).toEqual(['legacy/**']);
  });

  it('a record unit and no legacy file leaves the columns empty when the sync did not apply', async () => {
    const row = await checkout(['project/environment.json'], 'refused', false);

    expect(row.onboardingEnvironment ?? null).toBeNull();
    expect(row.scopeExcludeGlobs ?? null).toBeNull();
  });
});

describe('persistDetection and a legacy tooling.json next to the tooling unit', () => {
  const FOREIGN_MCP = JSON.stringify({ mcpServers: { evil: { command: 'curl' } } });
  const LEGACY = {
    schemaVersion: 1,
    tooling: { ragMode: 'legacy', mcpSettingsJson: FOREIGN_MCP },
  };
  const RECORD_TOOLING = { schemaVersion: 1, tooling: { ragMode: 'record' } };

  type Sync = 'applies' | 'throws' | 'refused' | 'deferred' | 'superseded' | 'absent';

  async function checkout(withUnit: boolean, sync: Sync) {
    const root = await mkdtemp(join(tmpdir(), 'persist-detection-'));
    dirs.push(root);
    await mkdir(join(root, '.haive-data/state/settings'), { recursive: true });
    await writeFile(join(root, '.haive-data/tooling.json'), JSON.stringify(LEGACY));
    if (withUnit) {
      await writeFile(
        join(root, '.haive-data/state/settings/onboarding-tooling.json'),
        '{"ragMode":"record"}',
      );
    }
    const fake = createFakeDb({
      repositories: schema.repositories,
      projectStateOutbox: schema.projectStateOutbox,
    });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      name: 'acme',
      source: 'blank',
      status: 'cloning',
    });
    vi.mocked(syncProjectStateFromCheckout).mockImplementation(async () => {
      if (sync === 'throws') throw new Error('sync refused');
      if (sync === 'applies') {
        fake.patch(schema.repositories, REPO, { onboardingTooling: RECORD_TOOLING });
        return { outcome: 'applied' } as never;
      }
      return { outcome: sync } as never;
    });
    await persistDetection(fake.db as unknown as Database, REPO, root);
    return { row: fake.rows(schema.repositories)[0]!, marks: fake.rows(schema.projectStateOutbox) };
  }

  it('a sync that applies fills the column from the record, whatever tooling.json holds', async () => {
    const { row, marks } = await checkout(true, 'applies');

    expect(row.onboardingTooling).toEqual(RECORD_TOOLING);
    expect(marks).toEqual([]);
  });

  it.each(['throws', 'refused', 'deferred', 'superseded', 'absent'] as const)(
    'a sync that %s: the empty column is filled from tooling.json afterwards, its servers held',
    async (sync) => {
      const { row, marks } = await checkout(true, sync);

      const tooling = (row.onboardingTooling as { tooling: Record<string, unknown> }).tooling;
      expect(tooling.ragMode).toBe('legacy');
      expect(tooling.mcpSettingsJson).toBeUndefined();
      expect(tooling.importedMcpSettingsJson).toBe(FOREIGN_MCP);
      expect(marks).toHaveLength(1);
    },
  );

  it('imports tooling.json before the sync when the record carries no tooling unit', async () => {
    const { row, marks } = await checkout(false, 'refused');

    expect((row.onboardingTooling as { tooling: Record<string, unknown> }).tooling.ragMode).toBe(
      'legacy',
    );
    expect(marks).toHaveLength(1);
  });
});
