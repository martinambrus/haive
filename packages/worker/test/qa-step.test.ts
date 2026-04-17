import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseQaPrepOutput,
  QaPrepParseError,
  type AgentQuestion,
} from '../src/step-engine/steps/onboarding/09-qa.js';
import {
  buildResolveForm,
  collectAgentAnswers,
  parseQaResolveOutput,
  QaResolveParseError,
  sanitizeKbRelPath,
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

  it('throws when no fenced JSON block is present', () => {
    expect(() => parseQaPrepOutput('plain text no fence')).toThrow(/fenced block/);
  });

  it('throws on invalid JSON inside fence', () => {
    expect(() => parseQaPrepOutput('```json\n{not json}\n```')).toThrow(/JSON parse/);
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

const sampleQuestions: AgentQuestion[] = [
  {
    id: 'q1',
    topic: 'Order delivery',
    question: 'How does partial delivery work?',
    context: 'src/order.ts',
    suggestedKbFile: 'BUSINESS_LOGIC.md',
  },
  {
    id: 'q2',
    topic: 'Product scope',
    question: 'What does the default scope hide?',
    context: 'src/products.ts',
  },
];

describe('buildResolveForm', () => {
  it('renders one textarea per agent question + the user-questions textarea', () => {
    const detected: KnowledgeQaResolveDetect = {
      agentQuestions: sampleQuestions,
      explicitNoQuestions: false,
      kbFiles: [],
    };
    const form = buildResolveForm(detected);
    expect(form.fields).toHaveLength(3);
    expect(form.fields[0]!.id).toBe('agentAnswer__q1');
    expect(form.fields[0]!.type).toBe('textarea');
    expect(form.fields[0]!.description).toContain('How does partial delivery work?');
    expect(form.fields[0]!.description).toContain('Suggested KB file: BUSINESS_LOGIC.md');
    expect(form.fields[1]!.id).toBe('agentAnswer__q2');
    expect(form.fields[1]!.description).not.toContain('Suggested KB file');
    expect(form.fields[2]!.id).toBe('userQuestions');
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
  it('parses a full valid output', () => {
    const raw = fence({
      kbWrites: [
        {
          relPath: 'BUSINESS_LOGIC.md',
          section: 'Order delivery',
          content: 'Long markdown body.',
        },
      ],
      answers: [
        {
          question: 'How does delivery work?',
          answer: 'Partial...',
          source: 'code',
          citedFile: '.claude/knowledge_base/BUSINESS_LOGIC.md',
        },
      ],
      unanswered: [{ question: 'X?', reason: 'Not in code' }],
    });
    const out = parseQaResolveOutput(raw);
    expect(out.kbWrites).toHaveLength(1);
    expect(out.answers).toHaveLength(1);
    expect(out.unanswered).toHaveLength(1);
  });

  it('accepts empty arrays (when no input questions)', () => {
    const raw = fence({ kbWrites: [], answers: [], unanswered: [] });
    const out = parseQaResolveOutput(raw);
    expect(out.kbWrites).toEqual([]);
  });

  it('treats missing arrays as empty', () => {
    const raw = fence({});
    const out = parseQaResolveOutput(raw);
    expect(out.kbWrites).toEqual([]);
    expect(out.answers).toEqual([]);
    expect(out.unanswered).toEqual([]);
  });

  it('throws when source is invalid', () => {
    const raw = fence({
      kbWrites: [],
      answers: [{ question: 'q', answer: 'a', source: 'bogus' }],
      unanswered: [],
    });
    expect(() => parseQaResolveOutput(raw)).toThrow(/source/);
  });

  it('throws when kbWrites missing required field', () => {
    const raw = fence({
      kbWrites: [{ relPath: 'X.md', section: 'Y' }],
    });
    expect(() => parseQaResolveOutput(raw)).toThrow(/content/);
  });
});

/* ------------------------------------------------------------------ */
/* sanitizeKbRelPath                                                   */
/* ------------------------------------------------------------------ */

describe('sanitizeKbRelPath', () => {
  it('accepts a normal path and adds .md if missing', () => {
    const out = sanitizeKbRelPath('BUSINESS_LOGIC');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.normalized).toBe('BUSINESS_LOGIC.md');
  });
  it('preserves an existing .md extension', () => {
    const out = sanitizeKbRelPath('QA/foo.md');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.normalized).toBe('QA/foo.md');
  });
  it('strips a leading .claude/knowledge_base/ prefix', () => {
    const out = sanitizeKbRelPath('.claude/knowledge_base/BUSINESS_LOGIC.md');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.normalized).toBe('BUSINESS_LOGIC.md');
  });
  it('rejects absolute paths', () => {
    expect(sanitizeKbRelPath('/etc/passwd').ok).toBe(false);
  });
  it('rejects ".." segments', () => {
    expect(sanitizeKbRelPath('../escape.md').ok).toBe(false);
    expect(sanitizeKbRelPath('a/../b.md').ok).toBe(false);
  });
  it('rejects empty paths', () => {
    expect(sanitizeKbRelPath('').ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* knowledgeQaResolveStep.apply (writes KB files)                      */
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
      // The apply function only uses repoPath + logger; the rest is stubbed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
      async emitProgress() {},
    };
  }

  it('appends a section to an existing KB file', async () => {
    const target = path.join(kbDir, 'BUSINESS_LOGIC.md');
    await writeFile(target, '# Business Logic\n\n## Existing\n\nold.\n', 'utf8');
    const llmOutput = fence({
      kbWrites: [{ relPath: 'BUSINESS_LOGIC.md', section: 'Order delivery', content: 'New body.' }],
      answers: [],
      unanswered: [],
    });
    const out = await knowledgeQaResolveStep.apply(makeCtx(), {
      detected: { agentQuestions: [], explicitNoQuestions: true, kbFiles: [] },
      formValues: { userQuestions: 'q1?\nq2?' },
      llmOutput,
    });
    const final = await readFile(target, 'utf8');
    expect(final).toContain('## Existing');
    expect(final).toContain('## Order delivery');
    expect(final).toContain('New body.');
    expect(out.kbWritten).toHaveLength(1);
    expect(out.kbWritten[0]!.relPath).toBe('.claude/knowledge_base/BUSINESS_LOGIC.md');
    expect(out.userQuestionCount).toBe(2);
    expect(out.agentQuestionCount).toBe(0);
  });

  it('creates a new KB file (and parent dir) when the path does not exist', async () => {
    const llmOutput = fence({
      kbWrites: [
        { relPath: 'QA/order-delivery.md', section: 'Partial delivery', content: 'Body.' },
      ],
      answers: [],
      unanswered: [],
    });
    await knowledgeQaResolveStep.apply(makeCtx(), {
      detected: { agentQuestions: [], explicitNoQuestions: true, kbFiles: [] },
      formValues: { userQuestions: '' },
      llmOutput,
    });
    const created = await readFile(path.join(kbDir, 'QA', 'order-delivery.md'), 'utf8');
    expect(created).toContain('# QA / order-delivery');
    expect(created).toContain('## Partial delivery');
    expect(created).toContain('Body.');
  });

  it('records skipped writes for unsafe paths instead of writing', async () => {
    const llmOutput = fence({
      kbWrites: [
        { relPath: '../escape.md', section: 'X', content: 'Y' },
        { relPath: 'OK.md', section: 'OK section', content: 'OK body' },
      ],
      answers: [],
      unanswered: [],
    });
    const out = await knowledgeQaResolveStep.apply(makeCtx(), {
      detected: { agentQuestions: [], explicitNoQuestions: true, kbFiles: [] },
      formValues: { userQuestions: '' },
      llmOutput,
    });
    expect(out.kbWritten).toHaveLength(1);
    expect(out.kbWritten[0]!.relPath).toBe('.claude/knowledge_base/OK.md');
    expect(out.kbSkipped).toHaveLength(1);
    expect(out.kbSkipped[0]!.relPath).toBe('../escape.md');
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
