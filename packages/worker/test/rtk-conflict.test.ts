import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { RTK_ENABLED_UNIT, conflictSide } from '@haive/shared/project-state';
import {
  needsRtkQuestion,
  raiseRtkQuestion,
  raiseRtkQuestions,
  type RtkQuestionInput,
} from '../src/project-state/rtk-conflict.js';
import { persistDetection } from '../src/repo/clone.js';

vi.mock('../src/project-state/sync.js', () => ({
  syncProjectStateFromCheckout: vi.fn(async () => ({ outcome: 'unchanged' })),
}));
vi.mock('../src/plan/mirror.js', () => ({
  importPlanMirror: vi.fn(async () => ({ imported: false, code: 'no_mirror', reason: 'none' })),
  recordPlanMirrorError: vi.fn(),
}));

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const REPO_2 = '00000000-0000-4000-8000-0000000000b2';
const REPO_3 = '00000000-0000-4000-8000-0000000000b3';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const OFF = { ragMode: 'none', rtkEnabled: false };
const ON = { ragMode: 'none', rtkEnabled: true };

const asked: RtkQuestionInput = {
  importedTooling: OFF,
  rtkEnabled: true,
  local04Toolings: [],
  hasAnyRowForUnit: false,
  rtkChoiceMadeAt: null,
};

describe('needsRtkQuestion', () => {
  it('asks when the imported tooling says off, the column says on, no local 04 equals it and no row exists', () => {
    expect(needsRtkQuestion(asked)).toBe(true);
  });

  it('does not ask when the imported tooling does not say off', () => {
    expect(needsRtkQuestion({ ...asked, importedTooling: ON })).toBe(false);
    expect(needsRtkQuestion({ ...asked, importedTooling: { ragMode: 'none' } })).toBe(false);
    expect(needsRtkQuestion({ ...asked, importedTooling: null })).toBe(false);
    expect(needsRtkQuestion({ ...asked, importedTooling: undefined })).toBe(false);
  });

  it('does not ask when the column already says off', () => {
    expect(needsRtkQuestion({ ...asked, rtkEnabled: false })).toBe(false);
  });

  it('does not ask when a local 04 run output exactly this tooling, whatever its key order', () => {
    const reordered = { rtkEnabled: false, ragMode: 'none' };
    expect(needsRtkQuestion({ ...asked, local04Toolings: [reordered] })).toBe(false);
    expect(needsRtkQuestion({ ...asked, local04Toolings: [ON, undefined, reordered] })).toBe(false);
  });

  it('asks when the local runs differ from the imported tooling', () => {
    expect(needsRtkQuestion({ ...asked, local04Toolings: [ON, undefined, null] })).toBe(true);
  });

  it('does not ask once a person switched RTK, and still asks when no stamp is set', () => {
    expect(needsRtkQuestion({ ...asked, rtkChoiceMadeAt: new Date(1000) })).toBe(false);
    expect(needsRtkQuestion({ ...asked, rtkChoiceMadeAt: null })).toBe(true);
  });

  it('does not ask when a row for the unit exists, answered or not', () => {
    expect(needsRtkQuestion({ ...asked, hasAnyRowForUnit: true })).toBe(false);
  });
});

function setup(
  repos: {
    id: string;
    tooling?: unknown;
    rtkEnabled?: boolean;
    rtkChoiceMadeAt?: Date;
  }[] = [{ id: REPO, tooling: OFF }],
) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    projectStateConflicts: schema.projectStateConflicts,
    projectStateOutbox: schema.projectStateOutbox,
  });
  for (const r of repos) {
    fake.insert(schema.repositories, {
      id: r.id,
      userId: USER,
      name: r.id,
      source: 'git_https',
      status: 'ready',
      rtkEnabled: r.rtkEnabled ?? true,
      rtkChoiceMadeAt: r.rtkChoiceMadeAt ?? null,
      onboardingTooling:
        r.tooling === undefined || r.tooling === null
          ? null
          : { schemaVersion: 1, tooling: r.tooling },
    });
  }
  const db = fake.db as unknown as Database;
  const rows = () => fake.rows(schema.projectStateConflicts);
  const addLocal04 = (repositoryId: string, tooling: unknown) => {
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId,
      type: 'onboarding',
      status: 'completed',
      title: 'onboarding',
    });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: '04-tooling-infrastructure',
      output: { tooling },
    });
  };
  return { fake, db, rows, addLocal04 };
}

describe('raiseRtkQuestion', () => {
  it('writes one pending row holding on, on and off', async () => {
    const s = setup();

    expect(await raiseRtkQuestion(s.db, REPO)).toBe(true);

    expect(s.rows()).toHaveLength(1);
    expect(s.rows()[0]).toMatchObject({
      repositoryId: REPO,
      unit: RTK_ENABLED_UNIT,
      base: conflictSide(true),
      local: conflictSide(true),
      incoming: conflictSide(false),
      resolution: null,
      resolvedAt: null,
    });
  });

  it('writes nothing the second time', async () => {
    const s = setup();
    await raiseRtkQuestion(s.db, REPO);

    expect(await raiseRtkQuestion(s.db, REPO)).toBe(false);

    expect(s.rows()).toHaveLength(1);
  });

  it.each(['keep_mine', 'take_theirs', 'converged'])(
    'writes nothing for a repository that has a row resolved as %s',
    async (resolution) => {
      const s = setup();
      s.fake.insert(schema.projectStateConflicts, {
        repositoryId: REPO,
        unit: RTK_ENABLED_UNIT,
        base: conflictSide(true),
        local: conflictSide(true),
        incoming: conflictSide(false),
        resolution,
        resolvedAt: new Date(1000),
      });

      expect(await raiseRtkQuestion(s.db, REPO)).toBe(false);

      expect(s.rows()).toHaveLength(1);
    },
  );

  it('writes nothing for a repository a local 04 run produced the tooling of', async () => {
    const s = setup();
    s.addLocal04(REPO, { rtkEnabled: false, ragMode: 'none' });

    expect(await raiseRtkQuestion(s.db, REPO)).toBe(false);

    expect(s.rows()).toHaveLength(0);
  });

  it('asks about a repository whose local 04 runs produced something else', async () => {
    const s = setup();
    s.addLocal04(REPO, { rtkEnabled: true, ragMode: 'none' });

    expect(await raiseRtkQuestion(s.db, REPO)).toBe(true);
  });

  it('writes nothing once the column says off, or the tooling says on or is missing', async () => {
    const s = setup([
      { id: REPO, tooling: OFF, rtkEnabled: false },
      { id: REPO_2, tooling: ON },
      { id: REPO_3 },
    ]);

    for (const id of [REPO, REPO_2, REPO_3]) expect(await raiseRtkQuestion(s.db, id)).toBe(false);

    expect(s.rows()).toHaveLength(0);
  });
});

describe('a repository where a person switched RTK', () => {
  const STAMP = new Date(1000);
  const pendingFor = (s: ReturnType<typeof setup>, repositoryId: string) =>
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId,
      unit: RTK_ENABLED_UNIT,
      base: conflictSide(true),
      local: conflictSide(true),
      incoming: conflictSide(false),
    });

  it('raiseRtkQuestion asks nothing of it, while an unstamped sibling is asked', async () => {
    const s = setup([
      { id: REPO, tooling: OFF, rtkChoiceMadeAt: STAMP },
      { id: REPO_2, tooling: OFF },
    ]);

    expect(await raiseRtkQuestion(s.db, REPO)).toBe(false);
    expect(await raiseRtkQuestion(s.db, REPO_2)).toBe(true);

    expect(s.rows().map((r) => r.repositoryId)).toEqual([REPO_2]);
  });

  it('raiseRtkQuestion closes its pending question as converged', async () => {
    const s = setup([{ id: REPO, tooling: OFF, rtkChoiceMadeAt: STAMP }]);
    pendingFor(s, REPO);

    expect(await raiseRtkQuestion(s.db, REPO)).toBe(false);

    expect(s.rows()[0]).toMatchObject({ resolution: 'converged', resolvedBy: null });
  });

  it('the boot entry closes its pending question and asks the unstamped sibling', async () => {
    const s = setup([
      { id: REPO, tooling: OFF, rtkChoiceMadeAt: STAMP },
      { id: REPO_2, tooling: OFF },
    ]);
    pendingFor(s, REPO);

    await raiseRtkQuestions(s.db);

    expect(s.rows().map((r) => [r.repositoryId, r.resolution])).toEqual([
      [REPO, 'converged'],
      [REPO_2, null],
    ]);
  });
});

describe('raiseRtkQuestions (boot)', () => {
  it('asks for each repository that needs it and converges on a second run', async () => {
    const s = setup([
      { id: REPO, tooling: OFF },
      { id: REPO_2, tooling: ON },
      { id: REPO_3, tooling: OFF },
    ]);

    await raiseRtkQuestions(s.db);
    await raiseRtkQuestions(s.db);

    expect(s.rows().map((r) => r.repositoryId)).toEqual([REPO, REPO_3]);
  });
});

describe('persistDetection and the RTK question', () => {
  it('asks once for an imported RTK-off the column never took, and not again on a rescan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rtk-question-'));
    dirs.push(root);
    const s = setup();

    await persistDetection(s.db, REPO, root);
    await persistDetection(s.db, REPO, root);

    expect(s.rows()).toHaveLength(1);
    expect(s.rows()[0]).toMatchObject({ repositoryId: REPO, unit: RTK_ENABLED_UNIT });
  });

  it('asks nothing of a repository with no imported tooling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rtk-question-'));
    dirs.push(root);
    const s = setup([{ id: REPO }]);

    await persistDetection(s.db, REPO, root);

    expect(s.rows()).toHaveLength(0);
  });
});

describe('a pending RTK question once RTK is off', () => {
  const pending = (s: ReturnType<typeof setup>, repositoryId = REPO) =>
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId,
      unit: RTK_ENABLED_UNIT,
      base: conflictSide(true),
      local: conflictSide(true),
      incoming: conflictSide(false),
    });
  const rowOf = (s: ReturnType<typeof setup>, repositoryId = REPO) =>
    s.rows().find((r) => r.repositoryId === repositoryId)!;

  it('raiseRtkQuestion closes it as converged and asks nothing', async () => {
    const s = setup([{ id: REPO, tooling: OFF, rtkEnabled: false }]);
    pending(s);

    expect(await raiseRtkQuestion(s.db, REPO)).toBe(false);

    expect(rowOf(s)).toMatchObject({ resolution: 'converged', resolvedBy: null });
    expect(rowOf(s).resolvedAt).toBeInstanceOf(Date);
  });

  it('raiseRtkQuestion leaves an answered question as it was answered', async () => {
    const s = setup([{ id: REPO, tooling: OFF, rtkEnabled: false }]);
    s.fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: RTK_ENABLED_UNIT,
      resolution: 'keep_mine',
      resolvedAt: new Date(1000),
    });

    await raiseRtkQuestion(s.db, REPO);

    expect(rowOf(s)).toMatchObject({ resolution: 'keep_mine' });
  });

  it('the boot entry closes it whatever the stored tooling says, and still asks where RTK is on', async () => {
    const s = setup([
      { id: REPO, rtkEnabled: false },
      { id: REPO_2, tooling: OFF },
      { id: REPO_3, tooling: OFF, rtkEnabled: false },
    ]);
    pending(s);

    await raiseRtkQuestions(s.db);
    await raiseRtkQuestions(s.db);

    expect(s.rows().map((r) => [r.repositoryId, r.resolution])).toEqual([
      [REPO, 'converged'],
      [REPO_2, null],
    ]);
  });

  it('persistDetection closes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rtk-question-'));
    dirs.push(root);
    const s = setup([{ id: REPO, tooling: OFF, rtkEnabled: false }]);
    pending(s);

    await persistDetection(s.db, REPO, root);

    expect(rowOf(s)).toMatchObject({ resolution: 'converged' });
  });

  it('a mirror import that switches RTK off closes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rtk-question-'));
    dirs.push(root);
    await mkdir(join(root, '.haive-data'));
    await writeFile(
      join(root, '.haive-data/tooling.json'),
      JSON.stringify({ schemaVersion: 1, tooling: OFF }),
    );
    const s = setup([{ id: REPO }]);
    pending(s);

    await persistDetection(s.db, REPO, root);

    expect(s.fake.rows(schema.repositories)[0]!.rtkEnabled).toBe(false);
    expect(rowOf(s)).toMatchObject({ resolution: 'converged' });
  });
});
