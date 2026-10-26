import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { isRenderContextSnapshot } from '@haive/shared/project-state';
import {
  resolveSkillTargetDirs,
  resolveTaskSkillTargetDirs,
} from '../src/step-engine/steps/onboarding/_helpers.js';

const portable = {
  projectInfo: { name: 'Snapshot membership' },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkEnabled: false,
};
const snapshot = (cliTargets: string[]) => ({ ...portable, cliTargets });
const column = (cliTargets: string[]) => ({ ...snapshot(cliTargets), rtkChoiceRecorded: false });
const legacy = {
  ...portable,
  rtkChoiceRecorded: false,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
};

function world(renderContext: unknown = null) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
  });
  const userId = randomUUID(),
    repositoryId = randomUUID(),
    taskId = randomUUID();
  fake.insert(schema.repositories, { id: repositoryId, userId, renderContext });
  fake.insert(schema.tasks, { id: taskId, userId, repositoryId, type: 'workflow' });
  fake.insert(schema.cliProviders, { userId, name: 'codex', enabled: true });
  const db = fake.db as unknown as Database;
  const add = (value: unknown, generatedAt = 1, overrides = {}) =>
    fake.insert(schema.onboardingArtifacts, {
      repositoryId,
      userId,
      supersededAt: null,
      generatedAt: new Date(generatedAt),
      formValuesSnapshot: value,
      ...overrides,
    });
  const resolve = () => resolveSkillTargetDirs(db, userId, ['.claude/skills'], repositoryId);
  const taskResolve = () => resolveTaskSkillTargetDirs({ db, userId, taskId }, ['.claude/skills']);
  return { fake, add, resolve, taskResolve, taskId, repositoryId, userId };
}

describe('skill destinations from recorded live snapshots', () => {
  it('uses decoder-valid recorded Claude/Gemini membership while only local Codex is enabled', async () => {
    const s = world();
    const recorded = snapshot(['claude-code', 'gemini']);
    expect(isRenderContextSnapshot(recorded)).toBe(true);
    s.add(recorded);
    expect(await s.resolve()).toEqual(['.claude/skills', '.gemini/skills']);
    expect(await s.taskResolve()).toEqual(['.claude/skills', '.gemini/skills']);
  });

  it.each([[[]], [['future-cli']]])(
    'keeps historical %j authoritative over local providers and caller fallback',
    async (names) => {
      const s = world();
      const recorded = snapshot(names);
      expect(isRenderContextSnapshot(recorded)).toBe(true);
      s.add(recorded);
      expect(await s.resolve()).toEqual([]);
      expect(await s.taskResolve()).toEqual([]);
    },
  );

  it('keeps current explicit [] ahead of recorded live membership', async () => {
    const s = world(column([]));
    s.add(snapshot(['claude-code', 'gemini']));
    expect(await s.resolve()).toEqual([]);
    expect(await s.taskResolve()).toEqual([]);
  });

  it('keeps an authoritative current list ahead of a different snapshot', async () => {
    const s = world(column(['claude-code']));
    s.add(snapshot(['gemini']));
    expect(await s.resolve()).toEqual(['.claude/skills']);
  });

  it('takes newest valid recorded membership before legacy column metadata', async () => {
    const s = world(legacy);
    s.add(snapshot(['gemini']));
    expect(await s.resolve()).toEqual(['.gemini/skills']);
    expect(await s.taskResolve()).toEqual(['.gemini/skills']);
  });

  it('skips malformed and newer membership-less snapshots without hiding older known membership', async () => {
    const s = world();
    s.add(snapshot(['gemini']), 1);
    s.add(portable, 2);
    s.add({ ...snapshot(['codex']), unexpectedFutureKey: true }, 3);
    expect(isRenderContextSnapshot(portable)).toBe(true);
    expect(isRenderContextSnapshot({ ...snapshot(['codex']), unexpectedFutureKey: true })).toBe(
      false,
    );
    expect(await s.resolve()).toEqual(['.gemini/skills']);
  });

  it('ignores superseded snapshots and snapshots of another repository', async () => {
    const s = world();
    s.add(snapshot(['gemini']), 1);
    s.add(snapshot(['codex']), 2, { supersededAt: new Date(3) });
    s.add(snapshot(['claude-code']), 4, { repositoryId: randomUUID() });
    expect(await s.resolve()).toEqual(['.gemini/skills']);
  });

  it('keeps the pending onboarding07 union first, even ahead of current[] and snapshots', async () => {
    const s = world(column([]));
    s.add(snapshot(['codex']));
    s.fake.patch(schema.tasks, s.taskId, { type: 'onboarding' });
    s.fake.insert(schema.taskSteps, {
      taskId: s.taskId,
      stepId: '07-generate-files',
      round: 0,
      detectOutput: { cliTargets: ['claude-code', 'gemini'] },
    });
    expect(await s.taskResolve()).toEqual(['.claude/skills', '.gemini/skills']);
  });

  it('retains recorded legacy metadata and genuinely unknown local fallback', async () => {
    const known = world(legacy);
    expect(await known.resolve()).toEqual(['.claude/skills']);
    const unknown = world();
    unknown.add(portable);
    expect(await unknown.resolve()).toEqual(['.agents/skills']);
    expect(await unknown.taskResolve()).toEqual(['.agents/skills']);
  });
});
