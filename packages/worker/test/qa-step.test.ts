import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseQaPrepOutput,
  QaPrepParseError,
  type AgentQuestion,
} from '../src/step-engine/steps/onboarding/09-qa.js';
import type { EnrichedAgentQuestion } from '../src/step-engine/steps/onboarding/09_1-qa-suggestions.js';
import {
  buildResolveForm,
  collectAgentAnswers,
  parseQaResolveOutput,
  QaResolveParseError,
  splitUserQuestions,
  knowledgeQaResolveStep,
  type KnowledgeQaResolveDetect,
} from '../src/step-engine/steps/onboarding/09_2-qa-resolve.js';

/* ------------------------------------------------------------------ */
/* parseQaPrepOutput                                                   */
/* ------------------------------------------------------------------ */

function fence(json: object): string {
  return '```json\n' + JSON.stringify(json) + '\n```';
}

describe('parseQaPrepOutput', () => {
  it('parses a valid array of agent questions', () => {
    const raw = fence({
      agentQuestions: [
        {
          id: 'order-state',
          topic: 'Order partial delivery',
          question: 'How does partial delivery affect order state?',
          context: 'Read src/order.ts; transition not obvious.',
        },
        {
          id: 'product-filter',
          topic: 'Default product scope',
          question: 'What records does the default scope hide?',
          context: 'Read src/products.ts.',
          suggestedKbFile: 'BUSINESS_LOGIC.md',
        },
      ],
      explicitNoQuestions: false,
    });
    const out = parseQaPrepOutput(raw);
    expect(out.agentQuestions).toHaveLength(2);
    expect(out.agentQuestions[0]!.id).toBe('order-state');
    expect(out.agentQuestions[1]!.suggestedKbFile).toBe('BUSINESS_LOGIC.md');
    expect(out.explicitNoQuestions).toBe(false);
  });

  it('parses an empty list with explicitNoQuestions=true', () => {
    const raw = fence({ agentQuestions: [], explicitNoQuestions: true });
    const out = parseQaPrepOutput(raw);
    expect(out.agentQuestions).toEqual([]);
    expect(out.explicitNoQuestions).toBe(true);
  });

  it('throws when empty list lacks explicitNoQuestions=true', () => {
    const raw = fence({ agentQuestions: [], explicitNoQuestions: false });
    expect(() => parseQaPrepOutput(raw)).toThrow(QaPrepParseError);
  });

  it('throws on more than 30 questions', () => {
    const big: AgentQuestion[] = [];
    for (let i = 0; i < 31; i++) {
      big.push({
        id: `q-${i}`,
        topic: `t${i}`,
        question: `q${i}?`,
        context: 'c',
      });
    }
    const raw = fence({ agentQuestions: big, explicitNoQuestions: false });
    expect(() => parseQaPrepOutput(raw)).toThrow(/cap is 30/);
  });

  it('accepts exactly 30 questions', () => {
    const list: AgentQuestion[] = [];
    for (let i = 0; i < 30; i++) {
      list.push({
        id: `q-${i}`,
        topic: `t${i}`,
        question: `q${i}?`,
        context: 'c',
      });
    }
    const raw = fence({ agentQuestions: list, explicitNoQuestions: false });
    const out = parseQaPrepOutput(raw);
    expect(out.agentQuestions).toHaveLength(30);
  });

  it('throws on duplicate ids', () => {
    const raw = fence({
      agentQuestions: [
        { id: 'dup', topic: 't', question: '?', context: 'c' },
        { id: 'dup', topic: 't2', question: '?', context: 'c' },
      ],
      explicitNoQuestions: false,
    });
    expect(() => parseQaPrepOutput(raw)).toThrow(/Duplicate/);
  });

  it('throws on missing required fields', () => {
    const raw = fence({
      agentQuestions: [{ id: 'x', topic: '', question: 'q', context: 'c' }],
      explicitNoQuestions: false,
    });
    expect(() => parseQaPrepOutput(raw)).toThrow(QaPrepParseError);
  });

  it('throws when no JSON is present at all', () => {
    expect(() => parseQaPrepOutput('plain text no fence')).toThrow(QaPrepParseError);
  });

  it('throws on invalid JSON inside fence', () => {
    expect(() => parseQaPrepOutput('```json\n{not json}\n```')).toThrow(QaPrepParseError);
  });

  it('throws when explicitNoQuestions is missing', () => {
    const raw = '```json\n{"agentQuestions": []}\n```';
    expect(() => parseQaPrepOutput(raw)).toThrow(/explicitNoQuestions/);
  });

  it('unwraps Claude Code { result: "..." } wrapper', () => {
    const inner = fence({
      agentQuestions: [{ id: 'x', topic: 't', question: 'q?', context: 'c' }],
      explicitNoQuestions: false,
    });
    const out = parseQaPrepOutput({ result: inner });
    expect(out.agentQuestions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* buildResolveForm                                                    */
/* ------------------------------------------------------------------ */

const sampleQuestions: EnrichedAgentQuestion[] = [
  {
    id: 'q1',
    topic: 'Order delivery',
    question: 'How does partial delivery work?',
    context: 'src/order.ts',
    suggestedKbFile: 'BUSINESS_LOGIC.md',
    suggestedAnswers: ['Partial completes order', 'Partial keeps order open'],
  },
  {
    id: 'q2',
    topic: 'Product scope',
    question: 'What does the default scope hide?',
    context: 'src/products.ts',
    suggestedAnswers: [],
  },
];

describe('buildResolveForm', () => {
  it('wraps agent questions in an accordion + appends the user-questions textarea', () => {
    const detected: KnowledgeQaResolveDetect = {
      agentQuestions: sampleQuestions,
      explicitNoQuestions: false,
      kbFiles: [],
    };
    const form = buildResolveForm(detected);
    expect(form.fields).toHaveLength(2);

    const accordion = form.fields[0]!;
    expect(accordion.type).toBe('accordion');
    expect(accordion.id).toBe('agent-questions');
    if (accordion.type !== 'accordion') throw new Error('not accordion');
    expect(accordion.label).toContain('(2)');
    expect(accordion.items).toHaveLength(2);

    const item0 = accordion.items[0]!;
    expect(item0.title).toBe('How does partial delivery work?');
    expect(item0.description).toContain('Topic: Order delivery');
    expect(item0.description).toContain('Suggested KB file: BUSINESS_LOGIC.md');
    expect(item0.fields).toHaveLength(1);
    const item0Field = item0.fields[0]!;
    expect(item0Field.id).toBe('agentAnswer__q1');
    expect(item0Field.type).toBe('radio-with-textarea');
    if (item0Field.type !== 'radio-with-textarea') throw new Error('not radio-with-textarea');
    expect(item0Field.predefined.map((p) => p.value)).toEqual([
      'Partial completes order',
      'Partial keeps order open',
    ]);

    const item1 = accordion.items[1]!;
    expect(item1.title).toBe('What does the default scope hide?');
    expect(item1.description).not.toContain('Suggested KB file');
    const item1Field = item1.fields[0]!;
    expect(item1Field.id).toBe('agentAnswer__q2');
    expect(item1Field.type).toBe('radio-with-textarea');
    if (item1Field.type !== 'radio-with-textarea') throw new Error('not radio-with-textarea');
    expect(item1Field.predefined).toEqual([]);

    expect(form.fields[1]!.id).toBe('userQuestions');
    expect(form.fields[1]!.type).toBe('textarea');
  });

  it('renders only the user-questions textarea when there are no agent questions', () => {
    const detected: KnowledgeQaResolveDetect = {
      agentQuestions: [],
      explicitNoQuestions: true,
      kbFiles: [],
    };
    const form = buildResolveForm(detected);
    expect(form.fields).toHaveLength(1);
    expect(form.fields[0]!.id).toBe('userQuestions');
    expect(form.description).toContain('reviewed the repository');
  });

  it('describes user-questions textarea with examples', () => {
    const detected: KnowledgeQaResolveDetect = {
      agentQuestions: [],
      explicitNoQuestions: true,
      kbFiles: [],
    };
    const form = buildResolveForm(detected);
    const userField = form.fields[0]!;
    expect(userField.description).toContain('order');
    expect(userField.description).toContain('delivered');
    expect(userField.description).toContain('default scope');
  });
});

/* ------------------------------------------------------------------ */
/* splitUserQuestions / collectAgentAnswers                            */
/* ------------------------------------------------------------------ */

describe('splitUserQuestions', () => {
  it('splits by newline, trims, drops blanks', () => {
    expect(splitUserQuestions('a?\n\n  b? \n c?\n')).toEqual(['a?', 'b?', 'c?']);
  });
  it('returns empty for non-string input', () => {
    expect(splitUserQuestions(undefined)).toEqual([]);
    expect(splitUserQuestions(123)).toEqual([]);
  });
  it('is uncapped — accepts very many lines', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `q${i}?`).join('\n');
    expect(splitUserQuestions(lines)).toHaveLength(200);
  });
});

describe('collectAgentAnswers', () => {
  it('returns only questions with non-empty trimmed answers', () => {
    const values = {
      agentAnswer__q1: 'My answer',
      agentAnswer__q2: '   ',
      agentAnswer__missing: 'orphaned',
    };
    const pairs = collectAgentAnswers(sampleQuestions, values);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.question.id).toBe('q1');
    expect(pairs[0]!.answer).toBe('My answer');
  });
});

/* ------------------------------------------------------------------ */
/* parseQaResolveOutput                                                */
/* ------------------------------------------------------------------ */

describe('parseQaResolveOutput', () => {
  it('parses a full valid output with inline proposedWrite', () => {
    const raw = fence({
      answers: [
        {
          question: 'How does delivery work?',
          answer: 'Partial...',
          source: 'code',
          citedFile: 'src/order.ts',
          proposedWrite: {
            relPath: 'BUSINESS_LOGIC.md',
            section: 'Order delivery',
            content: 'Long markdown body.',
          },
        },
      ],
      unanswered: [{ question: 'X?', reason: 'Not in code' }],
    });
    const out = parseQaResolveOutput(raw);
    expect(out.answers).toHaveLength(1);
    expect(out.answers[0]!.proposedWrite?.section).toBe('Order delivery');
    expect(out.unanswered).toHaveLength(1);
  });

  it('omits proposedWrite for source kb (answer already in KB)', () => {
    const raw = fence({
      answers: [
        {
          question: 'Where is auth?',
          answer: 'See KB.',
          source: 'kb',
          citedFile: '.claude/knowledge_base/AUTH.md',
        },
      ],
      unanswered: [],
    });
    const out = parseQaResolveOutput(raw);
    expect(out.answers).toHaveLength(1);
    expect(out.answers[0]!.proposedWrite).toBeUndefined();
  });

  it('accepts empty arrays (when no input questions)', () => {
    const raw = fence({ answers: [], unanswered: [] });
    const out = parseQaResolveOutput(raw);
    expect(out.answers).toEqual([]);
    expect(out.unanswered).toEqual([]);
  });

  it('treats missing arrays as empty', () => {
    const raw = fence({});
    const out = parseQaResolveOutput(raw);
    expect(out.answers).toEqual([]);
    expect(out.unanswered).toEqual([]);
  });

  it('throws when source is invalid', () => {
    const raw = fence({
      answers: [{ question: 'q', answer: 'a', source: 'bogus' }],
      unanswered: [],
    });
    expect(() => parseQaResolveOutput(raw)).toThrow(/source/);
  });

  it('throws when proposedWrite is required (source code) but absent', () => {
    const raw = fence({
      answers: [{ question: 'q', answer: 'a', source: 'code' }],
      unanswered: [],
    });
    expect(() => parseQaResolveOutput(raw)).toThrow(/proposedWrite required/);
  });

  it('throws when proposedWrite is missing a required field', () => {
    const raw = fence({
      answers: [
        {
          question: 'q',
          answer: 'a',
          source: 'code',
          proposedWrite: { relPath: 'X.md', section: 'Y' },
        },
      ],
      unanswered: [],
    });
    expect(() => parseQaResolveOutput(raw)).toThrow(/content/);
  });
});

/* ------------------------------------------------------------------ */
/* knowledgeQaResolveStep.apply (gather-only — no KB write)            */
/* ------------------------------------------------------------------ */

describe('knowledgeQaResolveStep.apply', () => {
  let tmpRoot: string;
  let kbDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'qa-resolve-'));
    kbDir = path.join(tmpRoot, '.claude', 'knowledge_base');
    await mkdir(kbDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function makeCtx(): Parameters<typeof knowledgeQaResolveStep.apply>[0] {
    return {
      taskId: 't',
      taskStepId: 's',
      userId: 'u',
      repoPath: tmpRoot,
      workspacePath: tmpRoot,
      sandboxWorkdir: '/repo',
      cliProviderId: null,
      // The apply function only uses logger; the rest is stubbed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
      async emitProgress() {},
    };
  }

  it('gathers answers + unanswered and counts, writing nothing to the KB', async () => {
    const llmOutput = fence({
      answers: [
        {
          question: 'How does delivery work?',
          answer: 'Partial completes the item only.',
          source: 'code',
          citedFile: 'src/order.ts',
          proposedWrite: {
            relPath: 'BUSINESS_LOGIC.md',
            section: 'Order delivery',
            content: 'New body.',
          },
        },
      ],
      unanswered: [{ question: 'Why cron?', reason: 'No scheduler found in code.' }],
    });
    const out = await knowledgeQaResolveStep.apply(makeCtx(), {
      detected: { agentQuestions: [], explicitNoQuestions: true, kbFiles: [] },
      formValues: { userQuestions: 'q1?\nq2?' },
      llmOutput,
    });
    expect(out.answers).toHaveLength(1);
    expect(out.answers[0]!.proposedWrite?.section).toBe('Order delivery');
    expect(out.unanswered).toHaveLength(1);
    expect(out.userQuestionCount).toBe(2);
    expect(out.agentQuestionCount).toBe(0);
    // Nothing is written here — that is 09_3-qa-review's job.
    expect(await readdir(kbDir)).toHaveLength(0);
  });

  it('throws when LLM output is unparseable, surfacing failure for retry', async () => {
    await expect(
      knowledgeQaResolveStep.apply(makeCtx(), {
        detected: { agentQuestions: [], explicitNoQuestions: true, kbFiles: [] },
        formValues: { userQuestions: '' },
        llmOutput: 'no fence',
      }),
    ).rejects.toThrow(QaResolveParseError);
  });
});
