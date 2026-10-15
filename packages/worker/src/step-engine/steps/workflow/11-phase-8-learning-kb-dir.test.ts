import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  ensureDir: vi.fn(),
  worktreePath: null as string | null,
}));

vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  stubs.ensureDir.mockImplementation(actual.ensureDirNoFollow);
  return { ...actual, ensureDirNoFollow: stubs.ensureDir };
});
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  loadTaskMeta: async () => ({
    title: 'Add rentals',
    description: 'A new capability',
    feature: null,
    affectedClients: [],
    category: null,
  }),
}));
vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: async (_db: unknown, _taskId: string, stepId: string) =>
    stepId === '01-worktree-setup' && stubs.worktreePath
      ? { output: { worktreePath: stubs.worktreePath } }
      : null,
  resolveSkillTargetDirs: async () => [],
}));
vi.mock('../../../repo/git-workspace.js', () => ({ gitWorkspaceStatus: async () => 'none' }));
vi.mock('./_task-history-digest.js', () => ({
  buildTaskHistoryDigest: async () => ({ text: '' }),
}));
vi.mock('../_global-kb-promote.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_global-kb-promote.js')>()),
  loadActiveGlobalArticlesForTask: async () => ({
    articles: [],
    otherTitles: [],
    otherDescriptions: [],
    omittedTitleCount: 0,
  }),
  clearTaskPromotedDrafts: async () => undefined,
}));
vi.mock('./_learning-feedback.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_learning-feedback.js')>()),
  loadOutstandingLearningInstruction: async () => '',
  recordLearningAccepted: async () => undefined,
}));

const { phase8LearningStep } = await import('./11-phase-8-learning.js');

const base = await mkdtemp(path.join(os.tmpdir(), 'haive-learning-kb-'));
const repo = path.join(base, 'repo');
const worktree = path.join(repo, '.haive/worktrees/feature');
const KB = '.haive-data/knowledge_base';

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  stubs.ensureDir.mockClear();
  stubs.worktreePath = null;
  await rm(repo, { recursive: true, force: true });
  await mkdir(worktree, { recursive: true });
});

const ctxAt = (workspacePath: string) =>
  ({
    db: { query: { tasks: { findFirst: async () => ({ metadata: {}, repositoryId: null }) } } },
    taskId: 'task-1',
    taskStepId: 'step-1',
    userId: 'user-1',
    workspacePath,
    repoPath: repo,
    logger: { info: () => {}, warn: () => {} },
  }) as never;

const llm = phase8LearningStep.llm!;
const promptOf = (detected: unknown) => llm.buildPrompt({ detected, formValues: {} });
const EDIT_THE_KB = 'EDIT the structured';
const KB_BLOCK = [
  'KNOWLEDGE BASE SYNC — before emitting the JSON',
  '2. bug_fix / refactor → SKIP KB edits',
  EDIT_THE_KB,
  'KB GAP DETECTION',
  'Report EVERY knowledge_base file you changed',
];

const INVESTIGATION = {
  entries: [],
  investigation: { title: 'Rentals crash', root_cause: 'a null rental', lesson: 'guard it' },
};

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

describe('step 11 in a task worktree', () => {
  it('creates a missing knowledge_base before its llm phase, owned like the worktree root', async () => {
    stubs.worktreePath = worktree;
    const ctx = ctxAt(worktree);
    const detected = await phase8LearningStep.detect!(ctx);
    expect(detected.kbSyncSkipped ?? null).toBeNull();
    expect(await exists(path.join(worktree, KB))).toBe(false);

    await llm.prepare!({ ctx, detected, formValues: {} });

    expect((await lstat(path.join(worktree, KB))).isDirectory()).toBe(true);
    const root = await lstat(worktree);
    const owner = { owner: { uid: root.uid, gid: root.gid } };
    expect(stubs.ensureDir.mock.calls).toEqual([[repo, `.haive/worktrees/feature/${KB}`, owner]]);
    expect(await exists(path.join(repo, '.haive-data'))).toBe(false);
    const prompt = promptOf(detected);
    for (const line of KB_BLOCK) expect(prompt).toContain(line);
  });

  it('changes nothing when the knowledge_base is already there', async () => {
    stubs.worktreePath = worktree;
    await mkdir(path.join(worktree, KB), { recursive: true });
    const ctx = ctxAt(worktree);
    const detected = await phase8LearningStep.detect!(ctx);
    expect(detected.kbSyncSkipped ?? null).toBeNull();

    await llm.prepare!({ ctx, detected, formValues: {} });

    expect(await readdir(path.join(worktree, '.haive-data'))).toEqual(['knowledge_base']);
    expect(await readdir(path.join(worktree, KB))).toEqual([]);
    const prompt = promptOf(detected);
    for (const line of KB_BLOCK) expect(prompt).toContain(line);
  });

  it('skips the KB sync when the knowledge_base is a file, and creates nothing', async () => {
    stubs.worktreePath = worktree;
    await mkdir(path.join(worktree, '.haive-data'), { recursive: true });
    await writeFile(path.join(worktree, KB), 'x');
    const ctx = ctxAt(worktree);
    const detected = await phase8LearningStep.detect!(ctx);
    expect(typeof detected.kbSyncSkipped).toBe('string');

    await llm.prepare!({ ctx, detected, formValues: {} });

    expect(stubs.ensureDir).not.toHaveBeenCalled();
    expect(promptOf(detected)).not.toContain(EDIT_THE_KB);
  });
});

describe('step 11 at the repository root', () => {
  it('creates nothing and skips the KB-sync half when there is no knowledge_base', async () => {
    const ctx = ctxAt(repo);
    const detected = await phase8LearningStep.detect!(ctx);
    expect(typeof detected.kbSyncSkipped).toBe('string');
    expect(detected.kbSyncSkipped).toContain('knowledge_base');

    await llm.prepare!({ ctx, detected, formValues: {} });

    expect(stubs.ensureDir).not.toHaveBeenCalled();
    expect(await exists(path.join(repo, '.haive-data'))).toBe(false);
    const prompt = promptOf(detected);
    expect(prompt).not.toContain(EDIT_THE_KB);
    expect(prompt).not.toContain('KB GAP DETECTION');
    expect(prompt).toContain('KNOWLEDGE BASE SYNC');
    expect(prompt).toContain('1. CLASSIFY the task');
    expect(prompt).toContain('"changes": []');
  });

  it('shows no KB sync at the gate and records the skip, even if the agent reports changes', async () => {
    const ctx = ctxAt(repo);
    const detected = await phase8LearningStep.detect!(ctx);
    const llmOutput = {
      entries: [],
      kbSync: {
        classification: 'new_feature',
        changes: [{ file: `${KB}/RENTALS.md`, op: 'insert', summary: 'rentals' }],
      },
    };

    const form = phase8LearningStep.form!(ctx, detected, llmOutput);
    expect(form!.fields.map((f) => f.id)).not.toContain('keepKbSync');
    expect(JSON.stringify(form)).not.toContain('Knowledge base sync');

    const out = await phase8LearningStep.apply(ctx, {
      detected,
      llmOutput,
      formValues: { writeFiles: false },
    } as never);
    expect(out.kbSync).toBeNull();
    expect(out.kbSyncSkipped).toBe(detected.kbSyncSkipped);
  });

  it('offers no local investigation and writes none, so no knowledge_base appears', async () => {
    const ctx = ctxAt(repo);
    const detected = { ...(await phase8LearningStep.detect!(ctx)), isBugFix: true };

    const form = phase8LearningStep.form!(ctx, detected, INVESTIGATION);
    expect(form!.fields.map((f) => f.id)).not.toContain('writeInvestigation');
    const promote = form!.fields.find((f) => f.id === 'promoteInvestigationGlobal');
    expect(promote?.label).toContain(detected.kbSyncSkipped!);

    const out = await phase8LearningStep.apply(ctx, {
      detected,
      llmOutput: INVESTIGATION,
      formValues: { writeFiles: false },
    } as never);
    expect(out.investigationWritten).toBeNull();
    expect(await exists(path.join(repo, KB))).toBe(false);
  });

  it('writes the investigation when the knowledge_base is there', async () => {
    await mkdir(path.join(repo, KB), { recursive: true });
    const ctx = ctxAt(repo);
    const detected = { ...(await phase8LearningStep.detect!(ctx)), isBugFix: true };

    const form = phase8LearningStep.form!(ctx, detected, INVESTIGATION);
    expect(form!.fields.map((f) => f.id)).toContain('writeInvestigation');
    const out = await phase8LearningStep.apply(ctx, {
      detected,
      llmOutput: INVESTIGATION,
      formValues: { writeFiles: false },
    } as never);
    expect(out.investigationWritten).toBe(`${KB}/investigations/rentals-crash.md`);
    expect(await exists(path.join(repo, out.investigationWritten!))).toBe(true);
  });

  it('changes nothing when the knowledge_base is there', async () => {
    await mkdir(path.join(repo, KB), { recursive: true });
    const ctx = ctxAt(repo);
    const detected = await phase8LearningStep.detect!(ctx);
    expect(detected.kbSyncSkipped ?? null).toBeNull();

    await llm.prepare!({ ctx, detected, formValues: {} });

    expect(await readdir(path.join(repo, '.haive-data'))).toEqual(['knowledge_base']);
    const prompt = promptOf(detected);
    for (const line of KB_BLOCK) expect(prompt).toContain(line);
    const out = await phase8LearningStep.apply(ctx, {
      detected,
      llmOutput: {
        entries: [],
        kbSync: { classification: 'bug_fix', changes: [] },
      },
      formValues: { writeFiles: false },
    } as never);
    expect(out.kbSyncSkipped).toBeNull();
  });
});
