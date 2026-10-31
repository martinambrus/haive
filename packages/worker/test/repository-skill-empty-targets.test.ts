import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { resolveTaskSkillTargetDirs } from '../src/step-engine/steps/onboarding/_helpers.js';
import { skillGenerationStep } from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import { skillRepairStep } from '../src/step-engine/steps/onboarding/09_5b-skill-repair.js';
import { skillSyncStep } from '../src/step-engine/steps/workflow/11d-skill-sync.js';
import { collectOnboardingStagePaths } from '../src/step-engine/steps/onboarding/_stage-paths.js';

let root: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const skill = {
  id: 'kept',
  title: 'Kept skill',
  description: 'A complete generated skill',
  overview: 'Domain overview.',
  subSkills: ['alpha', 'beta', 'gamma'].map((slug) => ({
    slug,
    name: `kept-${slug}`,
    title: slug,
    description: `Description of ${slug}`,
    summary: slug,
    body: `## Purpose\n\nThe ${slug} leaf explains this facet in enough detail to clear the body floor and refers to lib/example.ts:1.`,
  })),
};
const result = {
  agentId: 'kept',
  agentTitle: 'kept',
  status: 'done',
  output: { skills: [skill] },
  rawOutput: null,
  errorMessage: null,
};
const ctxFor = () =>
  ({
    repoPath: root,
    workspacePath: root,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  }) as unknown as StepContext;
const generated = (dirs: string[] | undefined = []) => ({
  framework: null,
  language: null,
  kbFiles: [],
  requiredDomains: [],
  bundleSkills: [],
  ...(dirs === undefined ? {} : { skillTargetDirs: dirs }),
});
const repaired = (dirs: string[] | undefined = []) => ({
  ...generated(dirs),
  failingSkills: [
    {
      skillId: 'kept',
      issues: ['broken'],
      skillMdExcerpt: '# old',
      maxSub: 8,
      bodyLen: '100-250',
      shrunk: false,
    },
  ],
});
const synced = (dirs: string[] = []) => ({
  ...generated(dirs),
  worktreePath: root,
  targets: [
    {
      kind: 'update',
      skillId: 'kept',
      capability: 'A domain',
      rationale: 'Changed',
      skillMdExcerpt: '# old',
    },
  ],
  removals: ['remove-me'],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't118-empty-skills-'));
  vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function put(rel: string, bytes: string) {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), bytes);
}

describe('authoritative empty skill targets', () => {
  it('does not stage persisted repair outputs at a default directory when detected targets were []', async () => {
    const fake = createFakeDb({ taskSteps: schema.taskSteps });
    const taskId = randomUUID();
    fake.insert(schema.taskSteps, {
      taskId,
      stepId: '09_5b-skill-repair',
      round: 0,
      detectOutput: { skillTargetDirs: [] },
      output: { repaired: ['kept'], repairedSubSkillSlugs: { kept: ['alpha'] } },
    });
    await put('.claude/skills/kept/SKILL.md', 'personal original\n');
    const plan = await collectOnboardingStagePaths(root, fake.db as never, taskId);
    expect(plan).toEqual({ add: [], remove: [] });
  });
  it.each([
    { label: 'missing legacy field', dirs: undefined, dir: '.claude/skills' },
    { label: 'known Gemini destination', dirs: ['.gemini/skills'], dir: '.gemini/skills' },
  ])('retains generation and repair for $label', async ({ dirs, dir }) => {
    const generation = generated(dirs);
    const repair = repaired(dirs);
    if (dirs === undefined) {
      delete generation.skillTargetDirs;
      delete repair.skillTargetDirs;
    }
    const written = await skillGenerationStep.apply(ctxFor(), {
      detected: generation,
      formValues: {},
      llmOutput: { skills: [skill] },
      iteration: 0,
      previousIterations: [],
      isFinalLlmAttempt: true,
    } as never);
    expect(written.written.map((row) => row.id)).toEqual(['kept']);
    expect(await readFile(join(root, dir, 'kept/SKILL.md'), 'utf8')).toContain('name: kept');
    const fixed = await skillRepairStep.apply(ctxFor(), {
      detected: repair,
      formValues: {},
      agentMiningResults: [result],
      iteration: 0,
      previousIterations: [],
    } as never);
    expect(fixed.repaired).toEqual(['kept']);
    expect(await readFile(join(root, dir, 'kept/SKILL.md'), 'utf8')).toContain('name: kept');
    if (dirs !== undefined) expect(await readdir(root)).toEqual(['.gemini']);
  });

  it('skips generation dispatch and writes no default-path skill even from a complete reply', async () => {
    const detected = generated();
    expect
      .soft(skillGenerationStep.llm!.skipIf!({ detected, formValues: {}, iteration: 0 } as never))
      .toBe(true);
    const agents = await skillGenerationStep.agentMining!.selectAgents({
      ctx: ctxFor(),
      detected: { ...detected, requiredDomains: ['Billing', 'Rental', 'Search'] },
      formValues: {},
    } as never);
    expect.soft(agents).toEqual([]);
    const out = await skillGenerationStep.apply(ctxFor(), {
      detected,
      formValues: {},
      llmOutput: { skills: [skill] },
      iteration: 0,
      previousIterations: [],
      isFinalLlmAttempt: true,
    } as never);
    expect.soft(out.written).toEqual([]);
    expect.soft(await readdir(root)).toEqual([]);
    expect
      .soft(skillGenerationStep.loop!.shouldContinue!({ applyOutput: out } as never))
      .toBe(false);
  });

  it('does not dispatch repair or rewrite an unmanaged default-path skill', async () => {
    await put('.claude/skills/kept/SKILL.md', 'personal original\n');
    await put('.claude/skills/README.md', 'personal index\n');
    const detected = repaired();
    expect
      .soft(
        await skillRepairStep.agentMining!.selectAgents({
          ctx: ctxFor(),
          detected,
          formValues: {},
        } as never),
      )
      .toEqual([]);
    const out = await skillRepairStep.apply(ctxFor(), {
      detected,
      formValues: {},
      agentMiningResults: [result],
      iteration: 0,
      previousIterations: [],
    } as never);
    expect.soft(out.repaired).toEqual([]);
    expect
      .soft(await readFile(join(root, '.claude/skills/kept/SKILL.md'), 'utf8'))
      .toBe('personal original\n');
    expect
      .soft(await readFile(join(root, '.claude/skills/README.md'), 'utf8'))
      .toBe('personal index\n');
    expect.soft(await readdir(join(root, '.claude/skills/kept'))).toEqual(['SKILL.md']);
  });

  it('does not dispatch, write, remove, stage or commit default-path workflow skills', async () => {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'T118 fixture');
    git('config', 'user.email', 't118@example.invalid');
    await put('.claude/skills/kept/SKILL.md', 'personal original\n');
    await put('.claude/skills/remove-me/SKILL.md', 'personal removal sentinel\n');
    git('add', '.claude');
    git('commit', '-qm', 'personal skills');
    const before = git('rev-parse', 'HEAD');
    const detected = synced();
    expect
      .soft(
        await skillSyncStep.agentMining!.selectAgents({
          ctx: ctxFor(),
          detected,
          formValues: {},
        } as never),
      )
      .toEqual([]);
    const fake = createFakeDb({
      users: schema.users,
      tasks: schema.tasks,
    });
    const out = await skillSyncStep.apply(
      { ...ctxFor(), db: fake.db } as never,
      {
        detected,
        formValues: {},
        agentMiningResults: [result],
        iteration: 0,
        previousIterations: [],
      } as never,
    );
    expect.soft(out.generated).toEqual([]);
    expect.soft(out.removed).toEqual([]);
    expect.soft(out.committed).toBe(false);
    expect.soft(git('rev-parse', 'HEAD')).toBe(before);
    expect.soft(git('status', '--porcelain')).toBe('');
    expect
      .soft(await readFile(join(root, '.claude/skills/kept/SKILL.md'), 'utf8'))
      .toBe('personal original\n');
    expect
      .soft(
        await readFile(join(root, '.claude/skills/remove-me/SKILL.md'), 'utf8').catch(() => null),
      )
      .toBe('personal removal sentinel\n');
  });

  it('retains the callers fallback only while membership is unresolved, never for repository []', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
      cliProviders: schema.cliProviders,
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
    });
    const taskId = randomUUID();
    const repositoryId = randomUUID();
    const userId = randomUUID();
    fake.insert(schema.tasks, {
      id: taskId,
      repositoryId,
      userId,
      type: 'onboarding',
    });
    const column = {
      projectInfo: {},
      framework: null,
      acceptedAgentIds: [],
      customAgentSpecs: [],
      lspLanguages: [],
      rtkChoiceRecorded: false,
      cliTargets: [],
    };
    const repo = fake.insert(schema.repositories, {
      id: repositoryId,
      userId,
      renderContext: column,
    });
    const ctx = {
      ...ctxFor(),
      db: fake.db,
      taskId,
      userId,
      emitProgress: async () => {},
    } as unknown as StepContext;
    await put('.claude/skills/broken/SKILL.md', 'not a skill');
    expect(await resolveTaskSkillTargetDirs(ctx, ['.claude/skills'])).toEqual([]);
    fake.patch(schema.repositories, repo.id as string, {
      renderContext: { ...column, cliTargets: ['future-cli'] },
    });
    expect(await resolveTaskSkillTargetDirs(ctx, ['.claude/skills'])).toEqual([]);
    fake.patch(schema.repositories, repo.id as string, { renderContext: null });
    expect(await resolveTaskSkillTargetDirs(ctx, ['.claude/skills'])).toEqual(['.claude/skills']);
  });
});

it.each(['', '.', 'other/skills', '.claude/skills/../skills'])(
  'does not stage stored generation or repair outputs in noncatalog dir %j',
  async (dir) => {
    const fake = createFakeDb({ taskSteps: schema.taskSteps });
    const taskId = randomUUID();
    fake.insert(schema.taskSteps, {
      taskId,
      stepId: '09_5-skill-generation',
      round: 0,
      output: { written: [{ id: 'kept', mirroredDirs: [dir], subSkillSlugs: ['alpha'] }] },
    });
    fake.insert(schema.taskSteps, {
      taskId,
      stepId: '09_5b-skill-repair',
      round: 0,
      detectOutput: { skillTargetDirs: [dir] },
      output: { repaired: ['kept'], repairedSubSkillSlugs: { kept: ['alpha'] } },
    });
    expect(await collectOnboardingStagePaths(root, fake.db as never, taskId)).toEqual({
      add: [],
      remove: [],
    });
  },
);
it('does not stage a stored multisegment skill ID', async () => {
  const fake = createFakeDb({ taskSteps: schema.taskSteps });
  const taskId = randomUUID();
  fake.insert(schema.taskSteps, {
    taskId,
    stepId: '09_5-skill-generation',
    round: 0,
    output: {
      written: [{ id: 'a/b', mirroredDirs: ['.claude/skills'], subSkillSlugs: ['alpha'] }],
    },
  });
  fake.insert(schema.taskSteps, {
    taskId,
    stepId: '09_5b-skill-repair',
    round: 0,
    detectOutput: { skillTargetDirs: ['.claude/skills'] },
    output: { repaired: ['a/b'] },
  });
  expect(await collectOnboardingStagePaths(root, fake.db as never, taskId)).toEqual({
    add: [],
    remove: [],
  });
});
