import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { UpgradePlanOutput } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  HAIVE_FILE_RETIRED_EVENT,
  upgradeApplyStep,
} from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { appliedWrittenPaths } from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const OTHER_TASK = '00000000-0000-4000-8000-0000000000c2';
const STEP = '00000000-0000-4000-8000-0000000000d1';

const RECORD_PATHS = ['.haive-data/state/format.json', '.haive-data/state/project/render.json'];

const run = promisify(execFile);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function commitAll(root: string) {
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  await git('init', '-q');
  await git('config', 'user.email', 't@example.com');
  await git('config', 'user.name', 'T');
  await git('config', 'gc.auto', '0');
  await git('add', '-A');
  await git('commit', '-q', '--allow-empty', '-m', 'before the upgrade');
}

async function bytesInDir(dir: string, content: string): Promise<boolean> {
  for (const name of await readdir(dir)) {
    if ((await readFile(join(dir, name), 'utf8').catch(() => null)) === content) return true;
  }
  return false;
}

/** An upgrade with nothing to change, so that what 02 reports is what it did about the record. */
async function setup(installJson?: string) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-record-paths-'));
  dirs.push(root);
  if (installJson !== undefined) {
    await mkdir(join(root, '.haive'), { recursive: true });
    await writeFile(join(root, '.haive/install.json'), installJson, 'utf8');
  }
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'acme', source: 'blank' });
  const plan = {
    repositoryId: REPO,
    ranBackfill: false,
    entries: [],
    counts: {
      unchanged: 0,
      clean_update: 0,
      adopt: 0,
      conflict: 0,
      new_artifact: 0,
      user_deleted: 0,
      obsolete: 0,
      foreign: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    backfilledRows: 0,
  } as UpgradePlanOutput;
  const noop = () => undefined;
  let crash = false;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    taskStepId: STEP,
    userId: USER,
    throwIfCancelled: () => {},
    logger: {
      info: () => {
        if (!crash) return;
        crash = false;
        throw new Error('crashed after retiring');
      },
      warn: noop,
      error: noop,
      debug: noop,
    },
  } as unknown as StepContext;
  const apply = () =>
    upgradeApplyStep.apply(ctx, {
      detected: plan,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
  return {
    root,
    fake,
    apply,
    crashAfterRetire: () => {
      crash = true;
    },
    retired: () =>
      fake
        .rows(schema.taskEvents)
        .filter((e) => e.eventType === HAIVE_FILE_RETIRED_EVENT)
        .map(({ taskId, taskStepId, payload }) => ({ taskId, taskStepId, payload })),
    column: () => fake.rows(schema.repositories)[0]!.renderContext ?? null,
    syncRows: () => fake.rows(schema.projectStateSync),
  };
}

function refuseRecordWriteOnce(s: Awaited<ReturnType<typeof setup>>) {
  let refused = false;
  s.fake.hooks.beforeLock = (key) => {
    if (key.includes('project-state') && !refused) {
      refused = true;
      throw new Error('database refused');
    }
  };
}

describe('02 reports the record files it wrote', () => {
  it('lists both, and so the commit step stages both, when the record is written', async () => {
    const s = await setup();

    const out = await s.apply();

    expect(out.warnings).toEqual([]);
    expect(s.column()).not.toBeNull();
    expect(out.writtenPaths).toEqual(expect.arrayContaining(RECORD_PATHS));
    expect(appliedWrittenPaths(out)).toEqual(expect.arrayContaining(RECORD_PATHS));
  });

  it('lists both, and so the commit step stages both, when only the database half failed', async () => {
    const s = await setup();
    // The write's lock is refused; the one that clears the column goes through.
    let locks = 0;
    s.fake.hooks.beforeLock = () => {
      locks += 1;
      if (locks === 1) throw new Error('database refused');
    };

    const out = await s.apply();

    // The files stand on disk, where a later sync takes them as the intended context, while the
    // column and the sync row stayed as they were: the upgrade must still commit them.
    for (const rel of RECORD_PATHS) expect(existsSync(join(s.root, rel)), rel).toBe(true);
    expect(s.column()).toBeNull();
    expect(s.syncRows()).toEqual([]);
    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(out.writtenPaths).toEqual(expect.arrayContaining(RECORD_PATHS));
    expect(appliedWrittenPaths(out)).toEqual(expect.arrayContaining(RECORD_PATHS));
  });

  it('fails the step when the column cannot be cleared either', async () => {
    const s = await setup();
    s.fake.hooks.beforeLock = () => {
      throw new Error('database refused');
    };

    await expect(s.apply()).rejects.toThrow('database refused');
  });
});

describe('02 and .haive/install.json', () => {
  const HAIVE_SHAPED = JSON.stringify({ schemaVersion: 1, templateSetHash: 'abc', templates: [] });
  const INSTALL = '.haive/install.json';

  it('writes none, and lists none, when there is none', async () => {
    const s = await setup();

    const out = await s.apply();

    expect(existsSync(join(s.root, INSTALL))).toBe(false);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it('retires a Haive-shaped one and lists it for the commit to drop', async () => {
    const s = await setup(HAIVE_SHAPED);

    const out = await s.apply();

    expect(existsSync(join(s.root, INSTALL))).toBe(false);
    expect(out.deletedPaths).toContain(INSTALL);
    expect(out.warnings).toEqual([]);
  });

  it('records the removal as an event of this task and step', async () => {
    const s = await setup(HAIVE_SHAPED);

    await s.apply();

    expect(s.retired()).toEqual([{ taskId: TASK, taskStepId: STEP, payload: { path: INSTALL } }]);
  });

  it('records the removal while the file is still at its own name', async () => {
    const s = await setup(HAIVE_SHAPED);
    const atOwnName: boolean[] = [];
    s.fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskEvents) atOwnName.push(existsSync(join(s.root, INSTALL)));
    };

    await s.apply();

    expect(atOwnName).toEqual([true]);
    expect(await bytesInDir(join(s.root, '.haive'), HAIVE_SHAPED)).toBe(false);
  });

  it('keeps it, lists none and says so when the removal cannot be recorded', async () => {
    const s = await setup(HAIVE_SHAPED);
    s.fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskEvents) throw new Error('database refused');
    };

    const out = await s.apply();

    expect(await readdir(join(s.root, '.haive'))).toEqual(['install.json']);
    expect(await readFile(join(s.root, INSTALL), 'utf8')).toBe(HAIVE_SHAPED);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
    expect(s.retired()).toEqual([]);
    expect(out.warnings).toEqual([
      '.haive/install.json was left in place: its removal could not be recorded: database refused',
    ]);

    s.fake.hooks.beforeInsert = null;
    const again = await s.apply();

    expect(existsSync(join(s.root, INSTALL))).toBe(false);
    expect(again.deletedPaths).toContain(INSTALL);
    expect(s.retired()).toEqual([{ taskId: TASK, taskStepId: STEP, payload: { path: INSTALL } }]);
  });

  it('takes its record back, and a retry lists none, when it is deleted during the wait', async () => {
    const s = await setup(HAIVE_SHAPED);
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.taskEvents) await rm(join(s.root, INSTALL));
    };

    const out = await s.apply();

    expect(existsSync(join(s.root, INSTALL))).toBe(false);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
    expect(out.warnings).toEqual([]);
    expect.soft(s.retired()).toEqual([]);

    s.fake.hooks.beforeInsert = null;
    const again = await s.apply();

    expect.soft(again.deletedPaths ?? []).not.toContain(INSTALL);
    expect(again.warnings).toEqual([]);
  });

  it('does not list one a retry saw restored and then lost, though an earlier attempt removed it', async () => {
    const s = await setup(HAIVE_SHAPED);
    await s.apply();
    await writeFile(join(s.root, INSTALL), HAIVE_SHAPED);
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.taskEvents) await rm(join(s.root, INSTALL));
    };

    const out = await s.apply();

    expect(existsSync(join(s.root, INSTALL))).toBe(false);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it('does not list it on the failure path either, when a later step throws', async () => {
    const s = await setup(HAIVE_SHAPED);
    await s.apply();
    await writeFile(join(s.root, INSTALL), HAIVE_SHAPED);
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.taskEvents) await rm(join(s.root, INSTALL));
    };
    const select = s.fake.db.select;
    s.fake.db.select = (fields) => ({
      from: (table) => {
        if (Object.keys(fields ?? {}).join() === 'onboardingTooling') {
          throw new Error('database refused');
        }
        return select(fields).from(table);
      },
    });

    const out = await s.apply();

    expect(out.warnings).toContain(
      'the record was written, but retiring the files it replaces failed: database refused',
    );
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it('does not list a restored file it kept as not Haive, though it vanishes before a later throw', async () => {
    const s = await setup(HAIVE_SHAPED);
    await s.apply();
    await writeFile(join(s.root, INSTALL), '{"keep":true}');
    const select = s.fake.db.select;
    s.fake.db.select = (fields) => ({
      from: (table) => {
        if (Object.keys(fields ?? {}).join() === 'onboardingTooling') {
          rmSync(join(s.root, INSTALL));
          throw new Error('database refused');
        }
        return select(fields).from(table);
      },
    });

    const out = await s.apply();

    expect(existsSync(join(s.root, INSTALL))).toBe(false);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it('keeps one replaced during the wait, and takes its record back', async () => {
    const s = await setup(HAIVE_SHAPED);
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.taskEvents) await writeFile(join(s.root, INSTALL), '{"keep":true}');
    };

    const out = await s.apply();

    expect(await readFile(join(s.root, INSTALL), 'utf8')).toBe('{"keep":true}');
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
    expect(out.warnings).toEqual([
      '.haive/install.json was left in place: it is not a Haive install manifest',
    ]);
    expect(s.retired()).toEqual([]);
  });

  it('takes its record back when the removal itself fails', async () => {
    const s = await setup(HAIVE_SHAPED);
    s.fake.hooks.beforeInsert = async (table) => {
      if (table !== schema.taskEvents) return;
      await rm(join(s.root, '.haive'), { recursive: true });
      await writeFile(join(s.root, '.haive'), 'not a directory');
    };

    const out = await s.apply();

    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/^\.haive\/install\.json was left in place: /);
    expect(s.retired()).toEqual([]);
  });

  it('warns once, naming the path, when its record cannot be taken back', async () => {
    const s = await setup(HAIVE_SHAPED);
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.taskEvents) await rm(join(s.root, INSTALL));
    };
    s.fake.hooks.beforeDelete = (table) => {
      if (table === schema.taskEvents) throw new Error('database refused');
    };

    const out = await s.apply();

    expect(out.warnings).toEqual([
      '.haive/install.json: the record of its removal could not be taken back, so the stale record stays: database refused',
    ]);
    expect(s.retired()).toEqual([{ taskId: TASK, taskStepId: STEP, payload: { path: INSTALL } }]);
  });

  it('takes back only its own record, not an earlier attempt’s for the same path', async () => {
    const s = await setup(HAIVE_SHAPED);
    const earlier = s.fake.insert(schema.taskEvents, {
      taskId: TASK,
      taskStepId: null,
      eventType: HAIVE_FILE_RETIRED_EVENT,
      payload: { path: INSTALL },
    });
    s.fake.hooks.beforeInsert = async (table) => {
      if (table === schema.taskEvents) await rm(join(s.root, INSTALL));
    };

    await s.apply();

    expect(s.fake.rows(schema.taskEvents).map((event) => event.id)).toEqual([earlier.id]);
  });

  it('does not list one the person deleted, though HEAD still carries it', async () => {
    const s = await setup(HAIVE_SHAPED);
    await commitAll(s.root);
    await rm(join(s.root, INSTALL));

    const out = await s.apply();

    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
    expect(out.warnings).toEqual([]);
  });

  it.each([
    ['a committed repository', true],
    ['no git at all', false],
  ])('lists it again on a retry of the task that removed it, in %s', async (_what, withGit) => {
    const s = await setup(HAIVE_SHAPED);
    if (withGit) await commitAll(s.root);
    s.crashAfterRetire();

    await expect(s.apply()).rejects.toThrow('crashed after retiring');
    expect(existsSync(join(s.root, INSTALL))).toBe(false);

    const out = await s.apply();

    expect(out.deletedPaths).toContain(INSTALL);
    expect(out.warnings).toEqual([]);
  });

  it.each([
    ['another task', OTHER_TASK, INSTALL],
    ['another path', TASK, '.haive/other.json'],
  ])('does not take the event of %s for its own', async (_what, taskId, path) => {
    const s = await setup(HAIVE_SHAPED);
    await commitAll(s.root);
    await rm(join(s.root, INSTALL));
    s.fake.insert(schema.taskEvents, {
      taskId,
      taskStepId: null,
      eventType: HAIVE_FILE_RETIRED_EVENT,
      payload: { path },
    });

    const out = await s.apply();

    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it.each([
    ['a repository that never tracked one', true],
    ['no git at all', false],
  ])('lists none in %s', async (_what, withGit) => {
    const s = await setup();
    if (withGit) await commitAll(s.root);

    const out = await s.apply();

    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it('keeps a file that is not Haive’s, lists nothing, and says so', async () => {
    const s = await setup('{"keep":true}');

    const out = await s.apply();

    expect(existsSync(join(s.root, INSTALL))).toBe(true);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
    expect(s.retired()).toEqual([]);
    expect(out.warnings).toEqual([
      '.haive/install.json was left in place: it is not a Haive install manifest',
    ]);
  });

  it('leaves it when the record write failed', async () => {
    const s = await setup(HAIVE_SHAPED);
    let refused = false;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };

    const out = await s.apply();

    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(existsSync(join(s.root, INSTALL))).toBe(true);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it('lists it when a retry’s record write fails after an earlier attempt removed it', async () => {
    const s = await setup(HAIVE_SHAPED);
    await s.apply();
    expect(existsSync(join(s.root, INSTALL))).toBe(false);
    refuseRecordWriteOnce(s);

    const out = await s.apply();

    expect(out.warnings).toEqual(['project state record write failed: database refused']);
    expect(out.deletedPaths).toContain(INSTALL);
  });

  it.each([
    ['no event at all', null],
    ['an event of another task', { taskId: OTHER_TASK, eventType: HAIVE_FILE_RETIRED_EVENT }],
    ['an event of another type', { taskId: TASK, eventType: 'upgrade.other' }],
  ])('does not list one the person deleted on a refused write, with %s', async (_what, event) => {
    const s = await setup(HAIVE_SHAPED);
    await commitAll(s.root);
    await rm(join(s.root, INSTALL));
    if (event !== null) {
      s.fake.insert(schema.taskEvents, { taskStepId: null, payload: { path: INSTALL }, ...event });
    }
    refuseRecordWriteOnce(s);

    const out = await s.apply();

    expect(out.warnings).toEqual(['project state record write failed: database refused']);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it.each([
    ['a file', (path: string) => writeFile(path, '{"keep":true}')],
    ['a directory', (path: string) => mkdir(path)],
    ['a link', (path: string) => symlink('elsewhere.json', path)],
  ])('does not list %s standing again, though this task removed it', async (_what, put) => {
    const s = await setup(HAIVE_SHAPED);
    await s.apply();
    await put(join(s.root, INSTALL));
    refuseRecordWriteOnce(s);

    const out = await s.apply();

    expect(out.warnings).toEqual(['project state record write failed: database refused']);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it('says so, and still returns, when the earlier removals cannot be looked up', async () => {
    const s = await setup(HAIVE_SHAPED);
    await s.apply();
    refuseRecordWriteOnce(s);
    const select = s.fake.db.select;
    s.fake.db.select = (fields) => ({
      from: (table) => {
        if (table === schema.taskEvents) throw new Error('database refused');
        return select(fields).from(table);
      },
    });

    const out = await s.apply();

    expect(out.warnings).toEqual([
      'project state record write failed: database refused',
      'did not list the files this task removed earlier: database refused',
    ]);
    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
  });

  it('does not list one whose path cannot be checked, though its removal was recorded', async () => {
    const s = await setup(HAIVE_SHAPED);
    await s.apply();
    const outside = await mkdtemp(join(tmpdir(), 'retire-outside-'));
    dirs.push(outside);
    await writeFile(join(outside, 'install.json'), HAIVE_SHAPED);
    await rm(join(s.root, '.haive'), { recursive: true, force: true });
    await symlink(outside, join(s.root, '.haive'));
    refuseRecordWriteOnce(s);

    const out = await s.apply();

    expect(out.deletedPaths ?? []).not.toContain(INSTALL);
    expect(
      out.warnings.some((w) =>
        w.startsWith(`${INSTALL} was not listed as removed: it could not be checked`),
      ),
    ).toBe(true);
  });

  it('lists it once when the failure comes after its own retirement listed it', async () => {
    const s = await setup(HAIVE_SHAPED);
    const select = s.fake.db.select;
    s.fake.db.select = (fields) => ({
      from: (table) => {
        if (Object.keys(fields ?? {}).join() === 'onboardingTooling') {
          throw new Error('database refused');
        }
        return select(fields).from(table);
      },
    });

    const out = await s.apply();

    expect(existsSync(join(s.root, INSTALL))).toBe(false);
    expect(out.warnings).toEqual([
      'the record was written, but retiring the files it replaces failed: database refused',
    ]);
    expect(out.deletedPaths?.filter((path) => path === INSTALL)).toEqual([INSTALL]);
  });
});

describe('02 and the legacy environment and exclusions mirrors', () => {
  const ENV_LEGACY = '.haive-data/environment.json';
  const GLOBS_LEGACY = '.haive-data/exclusions.json';
  const HAIVE_ENV = JSON.stringify({
    schemaVersion: 1,
    envDetectData: { project: { name: 'acme' } },
    confirmedValues: {},
  });
  const HAIVE_GLOBS = JSON.stringify({ schemaVersion: 1, scopeExcludeGlobs: ['vendor/**'] });

  async function withLegacy(files: Record<string, string>, columns: boolean) {
    const s = await setup();
    if (columns) {
      s.fake.patch(schema.repositories, REPO, {
        onboardingEnvironment: {
          schemaVersion: 1,
          envDetectData: { project: { name: 'acme' } },
          confirmedValues: {},
        },
        scopeExcludeGlobs: ['vendor/**'],
      });
    }
    await mkdir(join(s.root, '.haive-data'), { recursive: true });
    for (const [rel, content] of Object.entries(files)) await writeFile(join(s.root, rel), content);
    return s;
  }

  it('retires Haive-shaped ones and lists them for the commit to drop', async () => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, true);

    const out = await s.apply();

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(false);
      expect(out.deletedPaths, rel).toContain(rel);
    }
    expect(out.warnings).toEqual([]);
    expect(out.writtenPaths).toEqual(
      expect.arrayContaining([
        '.haive-data/state/project/environment.json',
        '.haive-data/state/settings/scope-exclude-globs.json',
      ]),
    );
  });

  it('records each removal as an event of this task and step', async () => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, true);

    await s.apply();

    expect(s.retired()).toHaveLength(2);
    expect(s.retired()).toEqual(
      expect.arrayContaining([
        { taskId: TASK, taskStepId: STEP, payload: { path: ENV_LEGACY } },
        { taskId: TASK, taskStepId: STEP, payload: { path: GLOBS_LEGACY } },
      ]),
    );
  });

  it('records each removal while its file is still at its own name', async () => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, true);
    const dir = join(s.root, '.haive-data');
    const atOwnName: Array<{ env: boolean; globs: boolean }> = [];
    s.fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskEvents) {
        atOwnName.push({
          env: existsSync(join(s.root, ENV_LEGACY)),
          globs: existsSync(join(s.root, GLOBS_LEGACY)),
        });
      }
    };

    await s.apply();

    expect(atOwnName).toEqual([
      { env: true, globs: true },
      { env: false, globs: true },
    ]);
    expect(await bytesInDir(dir, HAIVE_GLOBS)).toBe(false);
  });

  it('keeps them, lists none and says so when the removals cannot be recorded', async () => {
    const files = { [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS };
    const s = await withLegacy(files, true);
    s.fake.hooks.beforeInsert = (table) => {
      if (table === schema.taskEvents) throw new Error('database refused');
    };

    const out = await s.apply();

    expect((await readdir(join(s.root, '.haive-data'))).sort()).toEqual([
      'environment.json',
      'exclusions.json',
      'state',
    ]);
    for (const [rel, content] of Object.entries(files)) {
      expect(await readFile(join(s.root, rel), 'utf8'), rel).toBe(content);
      expect(out.deletedPaths ?? [], rel).not.toContain(rel);
    }
    expect(s.retired()).toEqual([]);
    expect(out.warnings).toEqual([
      `${ENV_LEGACY} was left in place: its removal could not be recorded: database refused`,
      `${GLOBS_LEGACY} was left in place: its removal could not be recorded: database refused`,
    ]);

    s.fake.hooks.beforeInsert = null;
    const again = await s.apply();

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(false);
      expect(again.deletedPaths, rel).toContain(rel);
    }
    expect(s.retired()).toHaveLength(2);
  });

  it('takes their records back, and a retry lists none, when they are deleted during the wait', async () => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, true);
    const waits = [ENV_LEGACY, GLOBS_LEGACY];
    s.fake.hooks.beforeInsert = async (table) => {
      const rel = table === schema.taskEvents ? waits.shift() : undefined;
      if (rel !== undefined) await rm(join(s.root, rel));
    };

    const out = await s.apply();

    expect(waits).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect.soft(s.retired()).toEqual([]);
    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(false);
      expect(out.deletedPaths ?? [], rel).not.toContain(rel);
    }

    s.fake.hooks.beforeInsert = null;
    const again = await s.apply();

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect.soft(again.deletedPaths ?? [], rel).not.toContain(rel);
    }
  });

  it('does not list ones the person deleted, though HEAD still carries them', async () => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, true);
    await commitAll(s.root);
    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) await rm(join(s.root, rel));

    const out = await s.apply();

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(out.deletedPaths ?? [], rel).not.toContain(rel);
    }
    expect(out.warnings).toEqual([]);
  });

  it.each([
    ['a committed repository', true],
    ['no git at all', false],
  ])('lists them again on a retry of the task that removed them, in %s', async (_what, withGit) => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, true);
    if (withGit) await commitAll(s.root);
    s.crashAfterRetire();

    await expect(s.apply()).rejects.toThrow('crashed after retiring');
    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(false);
    }

    const out = await s.apply();

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(out.deletedPaths, rel).toContain(rel);
    }
    expect(out.warnings).toEqual([]);
  });

  it('lists none that git never tracked, though the record carries their values', async () => {
    const s = await withLegacy({}, true);
    await commitAll(s.root);

    const out = await s.apply();

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(out.deletedPaths ?? [], rel).not.toContain(rel);
    }
  });

  it('keeps a file that is not Haive’s, lists nothing, and says so', async () => {
    const s = await withLegacy(
      { [ENV_LEGACY]: '{"keep":true}', [GLOBS_LEGACY]: '{"keep":true}' },
      true,
    );

    const out = await s.apply();

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(true);
      expect(out.deletedPaths ?? [], rel).not.toContain(rel);
      expect(out.warnings, rel).toContain(
        `${rel} was left in place: it is not a Haive ${
          rel === ENV_LEGACY ? 'environment' : 'exclusions'
        } mirror`,
      );
    }
    expect(s.retired()).toEqual([]);
  });

  it('keeps a mirror whose value the record does not carry', async () => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, false);

    const out = await s.apply();

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(true);
      expect(out.deletedPaths ?? [], rel).not.toContain(rel);
    }
    expect(out.warnings).toEqual([]);
  });

  it('leaves them when the record write failed', async () => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, true);
    let refused = false;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };

    const out = await s.apply();

    expect(out.warnings).toContain('project state record write failed: database refused');
    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(true);
      expect(out.deletedPaths ?? [], rel).not.toContain(rel);
    }
  });

  it('lists them when a retry’s record write fails after an earlier attempt removed them', async () => {
    const s = await withLegacy({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS }, true);
    await s.apply();
    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(false);
    }
    refuseRecordWriteOnce(s);

    const out = await s.apply();

    expect(out.warnings).toEqual(['project state record write failed: database refused']);
    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(out.deletedPaths, rel).toContain(rel);
    }
  });
});

describe('02 and the legacy tooling mirror', () => {
  const TOOLING_LEGACY = '.haive-data/tooling.json';
  const TOOLING_UNIT = '.haive-data/state/settings/onboarding-tooling.json';
  const HAIVE_TOOLING = JSON.stringify({ schemaVersion: 1, tooling: { ragMode: 'internal' } });

  async function withTooling(content: string, column: boolean) {
    const s = await setup();
    if (column) {
      s.fake.patch(schema.repositories, REPO, {
        onboardingTooling: { schemaVersion: 1, tooling: { ragMode: 'internal' } },
      });
    }
    await mkdir(join(s.root, '.haive-data'), { recursive: true });
    await writeFile(join(s.root, TOOLING_LEGACY), content);
    return s;
  }

  it('retires a Haive-shaped one, lists it for the commit to drop and writes the unit', async () => {
    const s = await withTooling(HAIVE_TOOLING, true);

    const out = await s.apply();

    expect(existsSync(join(s.root, TOOLING_LEGACY))).toBe(false);
    expect(out.deletedPaths).toContain(TOOLING_LEGACY);
    expect(out.writtenPaths).toContain(TOOLING_UNIT);
    expect(out.warnings).toEqual([]);
  });

  it('keeps a file that is not Haive’s, lists nothing, and says so', async () => {
    const s = await withTooling('{"keep":true}', true);

    const out = await s.apply();

    expect(existsSync(join(s.root, TOOLING_LEGACY))).toBe(true);
    expect(out.deletedPaths ?? []).not.toContain(TOOLING_LEGACY);
    expect(out.warnings).toContain(
      `${TOOLING_LEGACY} was left in place: it is not a Haive tooling mirror`,
    );
  });

  it('keeps it when the record does not carry the tooling, or the record write failed', async () => {
    const none = await withTooling(HAIVE_TOOLING, false);
    const outNone = await none.apply();
    expect(existsSync(join(none.root, TOOLING_LEGACY))).toBe(true);
    expect(outNone.deletedPaths ?? []).not.toContain(TOOLING_LEGACY);

    const failed = await withTooling(HAIVE_TOOLING, true);
    let refused = false;
    failed.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };
    const outFailed = await failed.apply();
    expect(outFailed.warnings).toContain('project state record write failed: database refused');
    expect(existsSync(join(failed.root, TOOLING_LEGACY))).toBe(true);
    expect(outFailed.deletedPaths ?? []).not.toContain(TOOLING_LEGACY);
  });

  it('keeps it when the record cannot carry the tooling', async () => {
    const s = await withTooling(HAIVE_TOOLING, false);
    s.fake.patch(schema.repositories, REPO, {
      onboardingTooling: { schemaVersion: 2, tooling: { ragMode: 'internal' } },
    });
    await mkdir(join(s.root, '.haive-data/state/settings'), { recursive: true });
    await writeFile(join(s.root, TOOLING_UNIT), '{}\n');

    const out = await s.apply();

    expect(existsSync(join(s.root, TOOLING_LEGACY))).toBe(true);
    expect(out.deletedPaths ?? []).not.toContain(TOOLING_LEGACY);
    expect(out.warnings).toEqual([]);
  });
});
