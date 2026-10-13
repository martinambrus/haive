import { describe, expect, it } from 'vitest';
import { schema, type Database, type DbTx } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  reviveRefusal,
  upgradeAdmission,
  type RepositoryForUpgrade,
} from '../src/onboarding-admission.js';
import { RTK_ENABLED_UNIT, claimFileName } from '../src/project-state/index.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const DONE = '00000000-0000-4000-8000-0000000000c1';
const UPGRADE = '00000000-0000-4000-8000-0000000000c2';
const LIVE = '00000000-0000-4000-8000-0000000000c3';
const DAY = 86_400_000;
const FRAMEWORK = 'project/render.json#framework';
const AGENTS = 'project/render.json#acceptedAgentIds';

const repo: RepositoryForUpgrade = {
  id: REPO,
  renderContext: null,
  status: 'ready',
  storagePath: null,
  localPath: null,
  onboardedAt: new Date(Date.now() - 3 * DAY),
  onboardingResetAt: null,
};

function setup() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateConflicts: schema.projectStateConflicts,
    repositories: schema.repositories,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'acme', status: 'ready' });
  fake.insert(schema.tasks, {
    id: DONE,
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding',
    title: 'done',
    status: 'completed',
    completedAt: new Date(Date.now() - 2 * DAY),
  });
  const pend = (unit: string, over: Record<string, unknown> = {}) =>
    fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit,
      base: { v: 1 },
      local: { v: 2 },
      incoming: { v: 3 },
      ...over,
    });
  const admission = () => upgradeAdmission(fake.db as unknown as Database, USER, repo);
  return { fake, pend, admission };
}

describe('upgradeAdmission: a pending project state conflict', () => {
  it('admits an onboarded repository that has none', async () => {
    expect(await setup().admission()).toEqual({ admitted: true });
  });

  it('holds the upgrade and names every contested unit', async () => {
    const s = setup();
    s.pend(FRAMEWORK);
    s.pend(AGENTS);

    const admission = await s.admission();

    expect(admission).toMatchObject({ admitted: false, reason: 'contested' });
    expect([...(admission as { units: string[] }).units].sort()).toEqual([AGENTS, FRAMEWORK]);
  });

  it('holds on a pending row of any unit, not only a render key', async () => {
    const s = setup();
    s.pend(RTK_ENABLED_UNIT);

    expect(await s.admission()).toEqual({
      admitted: false,
      reason: 'contested',
      units: [RTK_ENABLED_UNIT],
    });
  });

  it('admits an upgrade over a contested setting other than RTK, and over the environment', async () => {
    const s = setup();
    s.pend('settings/review-dimensions.json');
    s.pend('settings/lsp-servers.json');
    s.pend('project/environment.json#confirmedValues');

    expect(await s.admission()).toEqual({ admitted: true });
  });

  it('holds on a contested RTK setting, beside others that do not hold', async () => {
    const s = setup();
    s.pend('settings/review-dimensions.json');
    s.pend(RTK_ENABLED_UNIT);

    expect(await s.admission()).toEqual({
      admitted: false,
      reason: 'contested',
      units: [RTK_ENABLED_UNIT],
    });
  });

  it('holds on a pending claim row, the unit being the claim file name', async () => {
    const s = setup();
    const unit = claimFileName('.claude/agents/code-reviewer.md');
    s.pend(unit);

    expect(await s.admission()).toEqual({ admitted: false, reason: 'contested', units: [unit] });
  });

  it('admits again once the row is resolved, and ignores another repository’s row', async () => {
    const s = setup();
    s.pend(FRAMEWORK, { resolution: 'keep_mine', resolvedAt: new Date() });
    s.pend(FRAMEWORK, { repositoryId: OTHER });

    expect(await s.admission()).toEqual({ admitted: true });
  });

  it('still names the live onboarding first', async () => {
    const s = setup();
    s.pend(FRAMEWORK);
    s.fake.insert(schema.tasks, {
      id: LIVE,
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding',
      title: 'live',
      status: 'running',
    });

    expect(await s.admission()).toEqual({
      admitted: false,
      reason: 'live-onboarding',
      taskId: LIVE,
    });
  });

  it('refuses the revival of a failed upgrade, naming the reason', async () => {
    const s = setup();
    s.fake.insert(schema.repositories, { id: OTHER, userId: USER, name: 'other' });
    s.fake.insert(schema.tasks, {
      id: UPGRADE,
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      title: 'upgrade',
      status: 'failed',
      completedAt: new Date(),
    });
    expect(
      await s.fake.db.transaction((tx) => reviveRefusal(tx as unknown as DbTx, UPGRADE)),
    ).toBeNull();

    s.pend(FRAMEWORK);

    const verdict = await s.fake.db.transaction((tx) =>
      reviveRefusal(tx as unknown as DbTx, UPGRADE),
    );
    expect(verdict).toMatchObject({ admission: { admitted: false, reason: 'contested' } });
  });
});
