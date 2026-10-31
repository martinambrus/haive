import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { PROJECT_STATE_IMPORT_STEP_ID } from '@haive/shared/project-state';
import {
  DATA_MIGRATIONS,
  supersedeGitDataArtifacts,
  type DataMigration,
} from '../src/data-migrations.js';
import { seedRepositoryCliTargets } from '../src/project-state/cli-targets-backfill.js';

const RETIRE = 'supersedeGitDataArtifacts';
const SEED = 'seedRepositoryCliTargets';
const RECOMPUTE = 'recomputeSyncedApplicableSets';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const registry = (): DataMigration[] => {
  expect(Array.isArray(DATA_MIGRATIONS), 'DATA_MIGRATIONS must be exported').toBe(true);
  return DATA_MIGRATIONS;
};
const entry = (id: string): DataMigration | undefined => registry().find((m) => m.id === id);
const ids = () => registry().map((m) => m.id);

describe('the supersedeGitDataArtifacts boot data migration', () => {
  it('is exported, and registered once as a convergent migration', () => {
    expect(typeof supersedeGitDataArtifacts, 'supersedeGitDataArtifacts must be exported').toBe(
      'function',
    );
    expect(ids().filter((id) => id === RETIRE)).toHaveLength(1);
    expect(entry(RETIRE)?.kind).toBe('convergent');
    expect(typeof entry(RETIRE)?.run).toBe('function');
  });

  it('runs before the CLI-membership seed and the applicable-set recompute', () => {
    const all = ids();
    expect(all).toContain(SEED);
    expect(all).toContain(RECOMPUTE);
    const at = all.indexOf(RETIRE);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(all.indexOf(SEED));
    expect(at).toBeLessThan(all.indexOf(RECOMPUTE));
  });

  // A repository with no render context, an older ordinary row recording ['claude-code'] and a
  // newer import marker at a git-data path recording ['codex']. The seed reads every LIVE row and
  // takes the newest valid snapshot's membership.
  const portable = {
    projectInfo: {},
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    rtkEnabled: false,
  };
  function world() {
    const fake = createFakeDb({
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
      tasks: schema.tasks,
      projectStateOutbox: schema.projectStateOutbox,
    });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      renderContext: null,
      rootClaimedAt: null,
      rtkChoiceMadeAt: null,
    });
    const ordinary = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: TASK,
      diskPath: '.claude/agents/code-reviewer.md',
      source: 'onboarding',
      sourceStepId: '12-post-onboarding',
      supersededAt: null,
      generatedAt: new Date(1),
      updatedAt: new Date(1),
      formValuesSnapshot: { ...portable, cliTargets: ['claude-code'] },
    });
    const marker = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: null,
      diskPath: '.git/hooks/pre-commit',
      source: 'backfill',
      sourceStepId: PROJECT_STATE_IMPORT_STEP_ID,
      supersededAt: null,
      generatedAt: new Date(2),
      updatedAt: new Date(2),
      importedAt: new Date(2),
      formValuesSnapshot: { ...portable, cliTargets: ['codex'] },
    });
    const cliTargets = () =>
      (fake.rows(schema.repositories)[0]!.renderContext as { cliTargets?: string[] } | null)
        ?.cliTargets;
    const row = (id: unknown) => fake.rows(schema.onboardingArtifacts).find((r) => r.id === id)!;
    return { db: fake.db as unknown as Database, ordinary, marker, cliTargets, row };
  }

  it('control: the seed alone takes the git-data marker membership, newest first', async () => {
    const { db, cliTargets } = world();
    await seedRepositoryCliTargets(db);
    expect(cliTargets()).toEqual(['codex']);
  });

  it('retiring the marker first makes the seed read the ordinary row, which is why the order matters', async () => {
    const { db, cliTargets } = world();
    await supersedeGitDataArtifacts(db);
    await seedRepositoryCliTargets(db);
    expect(cliTargets()).toEqual(['claude-code']);
  });

  it('gets that result from the registered entries run in registry order', async () => {
    const { db, cliTargets } = world();
    for (const m of registry().filter((m) => m.id === RETIRE || m.id === SEED)) {
      await m.run(db);
    }
    expect(cliTargets()).toEqual(['claude-code']);
  });

  it('retires the git-data marker and nothing else when the registered entry runs', async () => {
    const { db, ordinary, marker, row } = world();
    await entry(RETIRE)!.run(db);
    expect(row(marker.id).supersededAt).toBeInstanceOf(Date);
    expect(row(ordinary.id)).toEqual(ordinary);
    const retired = { ...row(marker.id) };
    expect(retired.updatedAt).toEqual(retired.supersededAt);
    expect({ ...retired, supersededAt: null, updatedAt: marker.updatedAt }).toEqual(marker);
  });
});
