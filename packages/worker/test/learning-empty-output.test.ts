import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  parseLearningOutput,
  phase8LearningStep,
} from '../src/step-engine/steps/workflow/11-phase-8-learning.js';

vi.mock('@haive/shared/fs-safe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/fs-safe')>()),
  readdirNoFollow: vi.fn(async () => null),
  readTextNoFollow: vi.fn(async () => null),
  writeFileNoFollow: vi.fn(async () => undefined),
}));
vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/step-engine/steps/_global-kb-promote.js')>()),
  clearTaskPromotedDrafts: async () => 0,
}));

const sync = {
  kbSync: {
    classification: 'feature_update',
    changes: [
      {
        file: '.haive-data/knowledge_base/BUSINESS_LOGIC.md',
        op: 'update',
        summary: 'World fallback',
      },
      {
        file: '.haive-data/knowledge_base/API_REFERENCE.md',
        op: 'update',
        summary: 'Greeting contract',
      },
      {
        file: '.haive-data/knowledge_base/TESTING_STANDARDS.md',
        op: 'update',
        summary: 'Fallback coverage',
      },
    ],
  },
  skillSync: {
    ops: [{ op: 'feature_update', skillId: 'lowercase-greeting', rationale: 'World fallback' }],
  },
};
const emptyReply = `\`\`\`json\n${JSON.stringify({ entries: [], ...sync })}\n\`\`\``;
const learning = {
  id: 'fallback',
  title: 'Fallback',
  body: 'Normalize names in src/greeting.ts:12',
};
const nonEmptyReply = JSON.stringify({ entries: [learning], ...sync });
const gate = phase8LearningStep.llm!.shouldRetryPreForm!;

const detected = {
  taskTitle: 'Greeting fallback',
  taskDescription: 'Use world for empty names',
  feature: null,
  affectedClients: [],
  implementSummary: '',
  filesTouched: ['src/greeting.ts'],
  verifyPassed: true,
  commitSha: null,
  commitMessage: '',
  isBugFix: false,
  historyDigest: {
    text: '',
    tier: 'low',
    maxRound: 0,
    fixLoopCount: 0,
    findingCount: 0,
    steerCount: 0,
  },
  worktreePath: '/repo',
  existingLearnings: [],
  existingSkills: [{ id: 'lowercase-greeting', title: 'Greeting', description: '' }],
  repoStack: null,
  existingGlobalArticles: [],
  otherGlobalArticleTitles: [],
  omittedGlobalArticleCount: 0,
  refineInstruction: '',
  priorDrafts: null,
  knowledgeDiffArtifactPath: null,
} satisfies Awaited<ReturnType<NonNullable<typeof phase8LearningStep.detect>>>;

function context(): StepContext {
  const fake = createFakeDb({ taskEvents: schema.taskEvents, taskSteps: schema.taskSteps });
  return {
    db: fake.db,
    taskId: '00000000-0000-4000-8000-000000000001',
    taskStepId: '00000000-0000-4000-8000-000000000002',
    userId: '00000000-0000-4000-8000-000000000003',
    workspacePath: '/repo',
    repoPath: '/repo',
    logger: { info() {}, warn() {} },
  } as unknown as StepContext;
}

beforeEach(() => vi.clearAllMocks());

describe('learning results with no entries', () => {
  it('accepts a valid empty list with KB and skill proposals without retrying', () => {
    expect(parseLearningOutput(emptyReply)).toEqual([]);
    expect(gate(emptyReply)).toBe(false);
  });

  it.each([[], { entries: [] }, '[]', '{"entries":[]}'].map((raw) => ({ raw })))(
    'accepts an empty list as $raw',
    ({ raw }) => {
      expect(parseLearningOutput(raw)).toEqual([]);
      expect(gate(raw)).toBe(false);
    },
  );

  it.each(['no usable JSON', '{"kbSync":{}}', '{"entries":null}'])('still retries %s', (raw) => {
    expect(parseLearningOutput(raw)).toBeNull();
    expect(gate(raw)).toBe(true);
  });

  it.each(['', '   ', null, undefined])('preserves the bypass behavior for %j', (raw) => {
    expect(gate(raw)).toBe(false);
  });

  it('shows sync proposals and an explicit no-learnings state in the form', () => {
    const form = phase8LearningStep.form!(context(), detected, emptyReply)!;
    expect(form.description).toContain('No learnings were drafted');
    expect(form.infoSections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Knowledge base sync (feature_update, 3 files)' }),
        expect.objectContaining({ title: 'Skill sync (1 new/updated, 0 removed)' }),
      ]),
    );
    expect(
      form.infoSections?.find((s) => s.title.startsWith('Knowledge base sync'))?.body,
    ).toContain(sync.kbSync.changes[2]!.file);
    expect(form.infoSections?.find((s) => s.title.startsWith('Skill sync'))?.body).toContain(
      'lowercase-greeting',
    );
    expect(form.fields.map((f) => f.id)).toEqual(['keepKbSync', 'keepSkillSync', 'instruction']);
  });

  it('accepts sync proposals without synthesizing or writing a learning', async () => {
    const out = await phase8LearningStep.apply(context(), {
      iteration: 0,
      previousIterations: [],
      detected,
      llmOutput: emptyReply,
      formValues: {},
    });
    expect(out).toMatchObject({
      source: 'llm',
      entries: [],
      written: [],
      deleted: [],
      kbSync: sync.kbSync,
      kbReverted: false,
      skillSync: { newUpdate: sync.skillSync.ops, remove: [] },
      refineRequested: false,
    });
    expect(writeFileNoFollow).not.toHaveBeenCalled();
  });

  it('keeps non-empty learnings through retry, form and apply', async () => {
    expect(gate(nonEmptyReply)).toBe(false);
    const form = phase8LearningStep.form!(context(), detected, nonEmptyReply)!;
    expect(form.fields.some((f) => f.id === 'writeFiles')).toBe(true);
    const out = await phase8LearningStep.apply(context(), {
      iteration: 0,
      previousIterations: [],
      detected,
      llmOutput: nonEmptyReply,
      formValues: {},
    });
    expect(out.source).toBe('llm');
    expect(out.entries).toEqual([expect.objectContaining(learning)]);
    expect(out.written).toHaveLength(1);
    expect(writeFileNoFollow).toHaveBeenCalledTimes(1);
  });

  it('retains the fallback for unparseable output after retries are exhausted', async () => {
    const out = await phase8LearningStep.apply(context(), {
      iteration: 0,
      previousIterations: [],
      detected,
      llmOutput: 'no usable JSON',
      formValues: {},
    });
    expect(out.source).toBe('stub');
    expect(out.entries).toHaveLength(1);
    expect(out.written).toHaveLength(1);
  });
});
