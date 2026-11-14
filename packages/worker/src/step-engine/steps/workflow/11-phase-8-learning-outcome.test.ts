import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { StepApplyArgs, StepContext } from '../../step-definition.js';

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failAt: '',
  promote: vi.fn(async () => ({ id: 'draft-id' })),
  revert: vi.fn(async () => {}),
}));
vi.mock('@haive/shared/fs-safe', () => ({
  ensureDirNoFollow: vi.fn(),
  lstatNoFollow: vi.fn(),
  readdirNoFollow: async (_anchor: string, rel: string) =>
    [...io.files.keys()]
      .filter((key) => key.startsWith(rel + '/') && !key.slice(rel.length + 1).includes('/'))
      .map((key) => ({ name: key.slice(rel.length + 1), isFile: () => true })),
  readTextNoFollow: async (_anchor: string, rel: string) => io.files.get(rel) ?? null,
  writeFileNoFollow: async (_anchor: string, rel: string, body: string) => {
    if (rel === io.failAt) throw new Error('write refused');
    io.files.set(rel, body);
  },
  removeNoFollow: async (_anchor: string, rel: string) => {
    if (rel === io.failAt) throw new Error('remove refused');
    io.files.delete(rel);
  },
}));
vi.mock('../onboarding/_helpers.js', async (original) => ({
  ...(await original<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: async () => null,
}));
vi.mock('./_learning-feedback.js', () => ({
  recordLearningAccepted: async () => {},
  recordLearningInstruction: async () => {},
  loadOutstandingLearningInstruction: async () => '',
}));
vi.mock('../_global-kb-promote.js', async (original) => ({
  ...(await original<typeof import('../_global-kb-promote.js')>()),
  clearTaskPromotedDrafts: async () => {},
  promoteToGlobalKbDraft: io.promote,
}));
vi.mock('./_kb-commit.js', () => ({ revertKnowledgeBase: io.revert }));
const { phase8LearningStep } = await import('./11-phase-8-learning.js');
const EVENT = 'learning.reconciled';
const dir = '.haive-data/learnings';
const drafts = '.haive/learning-drafts/learnings';
const ops = (insert = 0, update = 0, del = 0) => ({ insert, update, delete: del });
const entry = (id: string, extra = {}) => ({
  id,
  title: `private-title-${id}`,
  body: `private-body-${id} src/a.ts:7`,
  ...extra,
});
const raw = () => ({
  entries: [
    entry('fresh'),
    entry('old', { op: 'update', targetId: 'old' }),
    { op: 'delete', targetId: 'gone' },
    entry('unknown', { op: 'update', targetId: 'missing' }),
    { op: 'delete', targetId: 'missing' },
    entry('removed'),
    entry('edited'),
    entry('uncited', { body: 'private uncited body' }),
    { title: 'malformed' },
    null,
  ],
  investigation: {
    title: 'private investigation',
    root_cause: 'private cause',
    lesson: 'private lesson',
  },
  globalCandidates: [
    {
      title: 'private global',
      body: 'private portable body',
      tech: 'node',
      evidence: 'src/a.ts:1',
    },
    { title: 'uncited global', body: 'private global body', tech: 'node' },
    { title: 'malformed global' },
  ],
});
function setup() {
  io.files.set(`${dir}/old.md`, '# Old\nold content');
  io.files.set(`${dir}/gone.md`, '# Gone\ngone content');
  io.files.set(`${drafts}/removed.md`, '  ');
  io.files.set(`${drafts}/edited.md`, '# private human edit\nprivate edited body');
  const rows = new Map<string, { eventType: string; payload: Record<string, any> }>();
  const warn = vi.fn();
  let refuseEvent = false;
  const db = {
    insert: () => ({
      values: (row: any) => ({
        onConflictDoNothing: async () => {
          if (refuseEvent) throw new Error('event refused');
          if (!rows.has(row.id)) rows.set(row.id, structuredClone(row));
        },
      }),
    }),
  };
  const ctx = {
    taskId: 'task-id',
    taskStepId: 'step-id',
    userId: 'user-id',
    round: 0,
    rerunGeneration: 0,
    epoch: 1,
    workspacePath: '/fixture',
    repoPath: '/fixture',
    db,
    logger: { info: vi.fn(), warn },
  } as unknown as StepContext;
  const detected = {
    taskTitle: 'private task',
    taskDescription: 'private description',
    feature: null,
    affectedClients: [],
    filesTouched: [],
    verifyPassed: true,
    isBugFix: true,
    existingLearnings: [
      { id: 'old', title: 'private listed', excerpt: 'private excerpt' },
      { id: 'title-only', title: 'private title only', excerpt: '' },
      { id: 'bad\nid', title: 'unlisted', excerpt: 'not shown' },
    ],
    omittedLearningCount: 2,
    existingSkills: [],
    existingGlobalArticles: [],
    otherGlobalArticleTitles: [],
    omittedGlobalArticleCount: 0,
    historyDigest: { text: '' },
    refineInstruction: '',
    priorDrafts: null,
    kbSyncSkipped: null,
    repoStack: { anchors: { packages: [] }, projectName: null },
  };
  const args = {
    detected,
    llmOutput: raw(),
    llmInvocationId: 'invocation-id',
    iteration: 0,
    previousIterations: [],
    formValues: { acceptGlobalCandidates: ['private-global'] },
  } as unknown as StepApplyArgs<any>;
  return {
    ctx,
    args,
    rows,
    warn,
    refuse: () => {
      refuseEvent = true;
    },
    event: () => [...rows.values()].find((row) => row.eventType === EVENT)?.payload,
  };
}
beforeEach(() => {
  io.files.clear();
  io.failAt = '';
  io.promote.mockClear();
  io.revert.mockClear();
});

describe('reconcile outcome', () => {
  it('separates listing, structural parsing, admission, reconciliation, human review and writes', async () => {
    const s = setup();
    await phase8LearningStep.apply(s.ctx, s.args);
    expect(s.event()).toMatchObject({
      version: 1,
      status: 'completed',
      source: 'llm',
      listed: { total: 2, withExcerpt: 1, omitted: 3 },
      learnings: {
        proposed: 10,
        parsed: 8,
        invalid: 2,
        rejected: { file_line_evidence: 1 },
        kept: ops(3, 2, 2),
        downgraded: { updateToInsert: 1, deleteDropped: 1 },
        planned: ops(4, 1, 1),
        human: { removed: 1, edited: 1, excluded: 0 },
        approved: ops(3, 1, 1),
        writes: { attempted: ops(3, 1, 1), succeeded: ops(3, 1, 1), failed: ops() },
      },
      investigation: {
        proposed: 1,
        parsed: 1,
        kept: 1,
        writes: { attempted: 1, succeeded: 1, failed: 0, notWritten: 0 },
      },
      globalCandidates: {
        proposed: 3,
        parsed: 2,
        invalid: 1,
        rejected: { file_line_evidence: 1 },
        kept: 1,
        writes: { attempted: 1, succeeded: 1, failed: 0, notWritten: 0 },
      },
    });
  });
  it('records only the file-line admission rule and never prose or arbitrary identities', async () => {
    const s = setup();
    await phase8LearningStep.apply(s.ctx, s.args);
    expect(s.event()).toBeDefined();
    const text = JSON.stringify(s.event());
    for (const prose of ['private', 'src/a.ts', 'missing', 'malformed', 'old content'])
      expect(text).not.toContain(prose);
    expect(Object.keys(s.event()!.learnings.rejected)).toEqual(['file_line_evidence']);
  });
  it('deduplicates replay across recovery epochs and creates a new event for explicit Retry', async () => {
    const s = setup();
    await phase8LearningStep.apply(s.ctx, s.args);
    const first = structuredClone(s.event());
    s.ctx.epoch = 9;
    await phase8LearningStep.apply(s.ctx, s.args);
    expect(s.rows.size).toBe(1);
    expect(s.event()).toEqual(first);
    (s.ctx as any).rerunGeneration = 1;
    await phase8LearningStep.apply(s.ctx, s.args);
    expect(s.rows.size).toBe(2);
  });
  it.each(['taskId', 'taskStepId', 'round', 'invocation'])(
    'includes %s in attempt identity',
    async (part) => {
      const s = setup();
      await phase8LearningStep.apply(s.ctx, s.args);
      if (part === 'invocation') s.args.llmInvocationId = 'other-invocation';
      else (s.ctx as any)[part] = part === 'round' ? 1 : 'other-id';
      await phase8LearningStep.apply(s.ctx, s.args);
      expect(s.rows.size).toBe(2);
    },
  );
  it('records partial successes and the failed operation before rethrowing the original write error', async () => {
    const s = setup();
    io.failAt = `${dir}/old.md`;
    await expect(phase8LearningStep.apply(s.ctx, s.args)).rejects.toThrow('write refused');
    expect(s.event()).toMatchObject({
      status: 'failed',
      learnings: {
        writes: {
          attempted: ops(1, 1),
          succeeded: ops(1),
          failed: ops(0, 1),
        },
      },
    });
  });
  it('tolerates and logs a failed event insert without changing the result', async () => {
    const s = setup();
    s.refuse();
    const out = await phase8LearningStep.apply(s.ctx, s.args);
    expect(out.written).toHaveLength(4);
    expect(s.warn).toHaveBeenCalledWith(
      expect.any(Object),
      'learning reconcile event insert failed (non-fatal)',
    );
  });
  it('records a refine apply without counting it as acceptance or a machine rejection', async () => {
    const s = setup();
    s.args.formValues = { instruction: 'private directive' };
    expect((await phase8LearningStep.apply(s.ctx, s.args)).refineRequested).toBe(true);
    expect(s.event()).toMatchObject({
      status: 'refine_requested',
      learnings: { proposed: 10, approved: ops(), writes: { succeeded: ops() } },
      investigation: { kept: 0 },
      globalCandidates: { kept: 0 },
    });
  });
  it('counts checkbox exclusions separately from cleared and edited drafts', async () => {
    const s = setup();
    s.args.formValues = { writeFiles: false, writeInvestigation: false };
    await phase8LearningStep.apply(s.ctx, s.args);
    expect(s.event()).toMatchObject({
      learnings: {
        human: { removed: 1, edited: 1, excluded: 5 },
        approved: ops(),
        writes: { succeeded: ops() },
      },
      investigation: { kept: 0 },
      globalCandidates: { kept: 0 },
    });
  });
  it('distinguishes failed global promotion from a kept and successfully written candidate', async () => {
    const s = setup();
    io.promote.mockResolvedValueOnce(null as never);
    await phase8LearningStep.apply(s.ctx, s.args);
    expect(s.event()).toMatchObject({
      globalCandidates: {
        kept: 1,
        writes: { attempted: 1, succeeded: 0, failed: 0, notWritten: 1 },
      },
    });
  });
});

describe('behavior fixture', () => {
  it('compares prompt, form, output and exact written bytes against unchanged code', async () => {
    const s = setup();
    const prompt = phase8LearningStep.llm!.buildPrompt({
      detected: s.args.detected,
      formValues: {},
    });
    const form = phase8LearningStep.form!(s.ctx, s.args.detected, s.args.llmOutput);
    const output = await phase8LearningStep.apply(s.ctx, s.args);
    const fixture = {
      prompt,
      form,
      output,
      files: [...io.files].sort(),
      promotions: io.promote.mock.calls,
    };
    // The real investigation renderer receives the clock; normalize only its timestamp.
    const serialized = JSON.stringify(fixture).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<now>');
    if (process.env.AMR_FIXTURE_OUT) await writeFile(process.env.AMR_FIXTURE_OUT, serialized);
    expect(JSON.parse(serialized)).toMatchSnapshot();
  });
});
