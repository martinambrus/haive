import type { Dirent } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { lstatNoFollow, readdirNoFollow } from '@haive/shared/fs-safe';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { verifyFilesStep } from '../src/step-engine/steps/onboarding/07_5-verify-files.js';
import { skillVerificationStep } from '../src/step-engine/steps/onboarding/09_6-skill-verification.js';
import { finalReviewStep } from '../src/step-engine/steps/onboarding/11-final-review.js';

vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  readdirNoFollow: vi.fn(async () => []),
  readTextNoFollow: async () => null,
  lstatNoFollow: vi.fn(async () => null),
}));
vi.mock('../src/step-engine/workspace-probe.js', () => ({
  hasWorkspaceEntry: async () => true,
}));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', async (original) => ({
  ...(await original<object>()),
  listFilesMatching: async (_root: string, matches: (rel: string, isDir: boolean) => boolean) =>
    Array.from({ length: 10 }, (_, i) => `.codex/agents/agent-${i}.toml`).filter((rel) =>
      matches(rel, false),
    ),
}));
vi.mock('../src/step-engine/_parallel-cap.js', () => ({ resolveParallelCap: async () => 1 }));

const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const CLI = '00000000-0000-4000-8000-000000000003';

function world(cliTargets: string[] = ['codex']) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    cliProviders: schema.cliProviders,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, type: 'onboarding', repositoryId: null });
  fake.insert(schema.cliProviders, {
    id: CLI,
    userId: USER,
    name: 'codex',
    label: 'Codex',
    enabled: true,
    createdAt: new Date(0),
  });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '07-generate-files',
    round: 0,
    detectOutput: { cliTargets },
  });
  const ctx = {
    db: fake.db,
    userId: USER,
    taskId: TASK,
    cliProviderId: CLI,
    repoPath: '/repo',
    logger: { info: vi.fn() },
  } as unknown as StepContext;
  const generated = (ids: string[], round = 0) =>
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: '09_5-skill-generation',
      round,
      output: { written: ids.map((id) => ({ id })) },
    });
  return { ctx, generated, fake };
}

beforeEach(() => {
  vi.mocked(readdirNoFollow).mockResolvedValue([]);
  vi.mocked(lstatNoFollow).mockResolvedValue(null);
});

it('07_5 passes a fresh onboarding before any skills are generated', async () => {
  const { ctx } = world();
  const detected = await verifyFilesStep.detect!(ctx);
  expect(detected.failedCount).toBe(0);
  expect(detected.checks.map((check) => check.id)).toEqual(['agents_dir', 'workflow_config']);
  const output = await verifyFilesStep.apply(ctx, {
    detected,
    formValues: {},
    iteration: 0,
    previousIterations: [],
  });
  expect(output.passed).toBe(true);
});

it.each([
  ['codex', '.agents/skills'],
  ['gemini', '.gemini/skills'],
  ['claude-code', '.claude/skills'],
])('09_6 flags a generated skill missing entirely from %s destinations', async (cli, dir) => {
  const { ctx, generated } = world([cli]);
  generated(['missing']);
  const detected = await skillVerificationStep.detect!(ctx);
  expect(detected.skillTargetDirs).toEqual([dir]);
  expect(detected.checks).toMatchObject([
    { skillId: 'missing', skillsDir: dir, passed: false, issues: ['SKILL.md missing'] },
  ]);
  expect(detected.missingFileIds).toEqual(['missing']);
  const form = skillVerificationStep.form!(ctx, detected)!;
  expect(form.fields.find((field) => field.id === 'decision')).toMatchObject({
    options: [{ value: 'accept' }, { value: 'regenerate' }],
    default: 'accept',
  });
  expect(form.description).toContain('Skills absent from every mirror need Regenerate');
  const output = await skillVerificationStep.apply(ctx, {
    detected,
    formValues: {},
    iteration: 0,
    previousIterations: [],
  });
  expect(output.passed).toBe(false);
});

it('09_6 checks only the latest generation round and refuses unsafe stored IDs', async () => {
  const { ctx, generated } = world(['codex', 'gemini']);
  generated(['obsolete']);
  generated(['current', '../escape', '.git'], 1);
  const detected = await skillVerificationStep.detect!(ctx);
  expect(detected.checks.map((check) => [check.skillsDir, check.skillId, check.passed])).toEqual([
    ['.agents/skills', 'current', false],
    ['.gemini/skills', 'current', false],
  ]);
});

it('09_6 still discovers existing skills without a generation output', async () => {
  const { ctx } = world();
  vi.mocked(readdirNoFollow).mockResolvedValue([
    { name: 'existing', isDirectory: () => true } as Dirent,
  ]);
  const detected = await skillVerificationStep.detect!(ctx);
  expect(detected.missingFileIds).toEqual(['existing']);
});

it('09_6 offers Repair for present skills and explains Regenerate for mixed absent failures', async () => {
  const { ctx, generated } = world(['codex', 'gemini']);
  // Only one mirror has the directory, with a missing SKILL.md. Repair discovers it
  // from that directory and can restore both mirrors; absence of the file is not absence
  // of the directory from every mirror.
  vi.mocked(readdirNoFollow).mockImplementation(async (_root, rel) =>
    rel === '.agents/skills' ? [{ name: 'existing', isDirectory: () => true } as Dirent] : [],
  );
  const present = await skillVerificationStep.detect!(ctx);
  const presentForm = skillVerificationStep.form!(ctx, present)!;
  expect(presentForm.fields.find((field) => field.id === 'decision')).toMatchObject({
    options: [{ value: 'accept' }, { value: 'repair' }, { value: 'regenerate' }],
  });

  generated(['existing', 'absent']);
  const mixed = await skillVerificationStep.detect!(ctx);
  const mixedForm = skillVerificationStep.form!(ctx, mixed)!;
  expect(mixedForm.fields.find((field) => field.id === 'decision')).toMatchObject({
    options: [{ value: 'accept' }, { value: 'repair' }, { value: 'regenerate' }],
  });
  expect(mixedForm.description).toContain('Repair fixes only skills with an existing directory');
  expect(mixedForm.description).toContain('Skills absent from every mirror need Regenerate');
});

it('09_6 falls back to disk discovery when written is not an array', async () => {
  const { ctx, fake } = world();
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '09_5-skill-generation',
    round: 0,
    output: { written: { id: 'not-an-array' } },
  });
  vi.mocked(readdirNoFollow).mockResolvedValue([
    { name: 'existing', isDirectory: () => true } as Dirent,
  ]);
  const detected = await skillVerificationStep.detect!(ctx);
  expect(detected.checks.map((check) => check.skillId)).toEqual(['existing']);
});

it('09_6 keeps an explicit empty destination list empty even with old generated skills', async () => {
  const { ctx, generated } = world([]);
  generated(['old']);
  const detected = await skillVerificationStep.detect!(ctx);
  expect(detected.skillTargetDirs).toEqual([]);
  expect(detected.checks).toEqual([]);
  expect(skillVerificationStep.form!(ctx, detected)).toBeNull();
});

it.each([
  [['codex'], ['.agents/skills']],
  [['gemini'], ['.gemini/skills']],
  [
    ['codex', 'gemini'],
    ['.agents/skills', '.gemini/skills'],
  ],
])('11 counts installed skills once across %j destinations', async (clis, dirs) => {
  const { ctx } = world(clis);
  vi.mocked(readdirNoFollow).mockImplementation(async (_root, rel) =>
    dirs.includes(rel) ? [{ name: 'installed', isDirectory: () => true } as Dirent] : [],
  );
  vi.mocked(lstatNoFollow).mockResolvedValue({ kind: 'file' } as NonNullable<
    Awaited<ReturnType<typeof lstatNoFollow>>
  >);
  const detected = await finalReviewStep.detect!(ctx);
  expect(detected.counts.skills).toBe(1);
  expect(detected.findings.some((finding) => finding.id === 'no-skills')).toBe(false);
});

it('11 reports missing skills at the maintained CLI destination', async () => {
  const { ctx } = world(['codex']);
  const detected = await finalReviewStep.detect!(ctx);
  expect(detected.counts.skills).toBe(0);
  expect(detected.findings.find((finding) => finding.id === 'no-skills')?.detail).toContain(
    '.agents/skills',
  );
});

it('11 does not warn about skills when the repository maintains no destinations', async () => {
  const { ctx } = world([]);
  const detected = await finalReviewStep.detect!(ctx);
  expect(detected.counts.skills).toBe(0);
  expect(detected.findings.some((finding) => finding.id === 'no-skills')).toBe(false);
});
