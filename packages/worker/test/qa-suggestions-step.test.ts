import { describe, expect, it } from 'vitest';
import {
  parseQaSuggestionsOutput,
  QaSuggestionsParseError,
  knowledgeQaSuggestionsStep,
  type KnowledgeQaSuggestionsDetect,
} from '../src/step-engine/steps/onboarding/09_1-qa-suggestions.js';

function fence(json: object): string {
  return '```json\n' + JSON.stringify(json) + '\n```';
}

describe('parseQaSuggestionsOutput', () => {
  it('parses a valid suggestions list', () => {
    const raw = fence({
      suggestions: [
        { questionId: 'q1', suggestedAnswers: ['Yes', 'No', 'Depends'] },
        { questionId: 'q2', suggestedAnswers: [] },
      ],
    });
    const out = parseQaSuggestionsOutput(raw);
    expect(out).toHaveLength(2);
    expect(out[0]!.questionId).toBe('q1');
    expect(out[0]!.suggestedAnswers).toEqual(['Yes', 'No', 'Depends']);
    expect(out[1]!.suggestedAnswers).toEqual([]);
  });

  it('accepts an empty top-level suggestions array', () => {
    const raw = fence({ suggestions: [] });
    expect(parseQaSuggestionsOutput(raw)).toEqual([]);
  });

  it('treats missing suggestions key as empty', () => {
    const raw = fence({});
    expect(parseQaSuggestionsOutput(raw)).toEqual([]);
  });

  it('truncates to first 4 when more than 4 suggestions are emitted', () => {
    const raw = fence({
      suggestions: [{ questionId: 'q1', suggestedAnswers: ['a', 'b', 'c', 'd', 'e'] }],
    });
    const out = parseQaSuggestionsOutput(raw);
    expect(out[0]!.suggestedAnswers).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops a suggestion over 160 chars but keeps the rest', () => {
    const long = 'x'.repeat(161);
    const raw = fence({
      suggestions: [{ questionId: 'q1', suggestedAnswers: ['Short ok', long, 'Also ok'] }],
    });
    const out = parseQaSuggestionsOutput(raw);
    expect(out[0]!.suggestedAnswers).toEqual(['Short ok', 'Also ok']);
  });

  it('keeps a suggestion right at the 160-char cap', () => {
    const exactly = 'y'.repeat(160);
    const raw = fence({
      suggestions: [{ questionId: 'q1', suggestedAnswers: [exactly] }],
    });
    const out = parseQaSuggestionsOutput(raw);
    expect(out[0]!.suggestedAnswers).toEqual([exactly]);
  });

  it('drops blank/whitespace-only suggestions', () => {
    const raw = fence({
      suggestions: [{ questionId: 'q1', suggestedAnswers: ['Yes', '   ', '', 'No'] }],
    });
    const out = parseQaSuggestionsOutput(raw);
    expect(out[0]!.suggestedAnswers).toEqual(['Yes', 'No']);
  });

  it('dedupes repeated suggestions within a question', () => {
    const raw = fence({
      suggestions: [{ questionId: 'q1', suggestedAnswers: ['Yes', 'Yes', 'No'] }],
    });
    const out = parseQaSuggestionsOutput(raw);
    expect(out[0]!.suggestedAnswers).toEqual(['Yes', 'No']);
  });

  it('throws on missing questionId', () => {
    const raw = fence({ suggestions: [{ suggestedAnswers: ['x'] }] });
    expect(() => parseQaSuggestionsOutput(raw)).toThrow(/questionId/);
  });

  it('throws on non-array suggestedAnswers', () => {
    const raw = fence({ suggestions: [{ questionId: 'q1', suggestedAnswers: 'no' }] });
    expect(() => parseQaSuggestionsOutput(raw)).toThrow(/must be an array/);
  });

  it('drops non-string answer entries silently', () => {
    const raw = fence({
      suggestions: [{ questionId: 'q1', suggestedAnswers: [42, 'Real answer', null] }],
    });
    const out = parseQaSuggestionsOutput(raw);
    expect(out[0]!.suggestedAnswers).toEqual(['Real answer']);
  });

  it('throws when no fenced JSON block is present', () => {
    expect(() => parseQaSuggestionsOutput('plain text')).toThrow(/fenced block/);
  });

  it('throws on invalid JSON inside fence', () => {
    expect(() => parseQaSuggestionsOutput('```json\n{not json}\n```')).toThrow(
      QaSuggestionsParseError,
    );
  });

  it('unwraps Claude Code { result } wrapper', () => {
    const inner = fence({ suggestions: [{ questionId: 'q1', suggestedAnswers: ['ok'] }] });
    const out = parseQaSuggestionsOutput({ result: inner });
    expect(out).toHaveLength(1);
    expect(out[0]!.suggestedAnswers).toEqual(['ok']);
  });
});

describe('knowledgeQaSuggestionsStep llm hooks', () => {
  const detected: KnowledgeQaSuggestionsDetect = {
    framework: 'symfony',
    language: 'php',
    agentQuestions: [
      { id: 'q1', topic: 't1', question: 'Q1?', context: 'c1' },
      { id: 'q2', topic: 't2', question: 'Q2?', context: 'c2' },
    ],
  };

  it('skipIf returns true when there are no questions', () => {
    expect(
      knowledgeQaSuggestionsStep.llm!.skipIf!({
        detected: { ...detected, agentQuestions: [] },
        formValues: {},
      }),
    ).toBe(true);
  });

  it('skipIf returns false when there are questions', () => {
    expect(knowledgeQaSuggestionsStep.llm!.skipIf!({ detected, formValues: {} })).toBe(false);
  });

  it('bypassStub returns one entry per question with empty answers', () => {
    const stub = knowledgeQaSuggestionsStep.llm!.bypassStub!({ detected, formValues: {} });
    expect(stub).toEqual({
      suggestions: [
        { questionId: 'q1', suggestedAnswers: [] },
        { questionId: 'q2', suggestedAnswers: [] },
      ],
    });
  });

  it('buildPrompt mentions every question id', () => {
    const prompt = knowledgeQaSuggestionsStep.llm!.buildPrompt({ detected, formValues: {} });
    expect(prompt).toContain('id: q1');
    expect(prompt).toContain('id: q2');
    expect(prompt).toContain('Framework: symfony');
  });

  it('buildPrompt with no questions emits the empty-suggestions instruction', () => {
    const prompt = knowledgeQaSuggestionsStep.llm!.buildPrompt({
      detected: { ...detected, agentQuestions: [] },
      formValues: {},
    });
    expect(prompt).toContain('"suggestions": []');
  });
});

describe('knowledgeQaSuggestionsStep.apply', () => {
  function makeCtx(): Parameters<typeof knowledgeQaSuggestionsStep.apply>[0] {
    return {
      taskId: 't',
      taskStepId: 's',
      userId: 'u',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      sandboxWorkdir: '/repo',
      cliProviderId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: undefined as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
      async emitProgress() {},
      signal: new AbortController().signal,
      throwIfCancelled() {},
    };
  }

  const detected: KnowledgeQaSuggestionsDetect = {
    framework: null,
    language: null,
    agentQuestions: [
      { id: 'q1', topic: 't1', question: 'Q1?', context: 'c1' },
      { id: 'q2', topic: 't2', question: 'Q2?', context: 'c2' },
    ],
  };

  it('merges parsed suggestions into agent questions in original order', async () => {
    const llmOutput = fence({
      suggestions: [
        { questionId: 'q2', suggestedAnswers: ['B1', 'B2'] },
        { questionId: 'q1', suggestedAnswers: ['A1'] },
      ],
    });
    const out = await knowledgeQaSuggestionsStep.apply(makeCtx(), {
      detected,
      formValues: {},
      llmOutput,
      iteration: 0,
      previousIterations: [],
    });
    expect(out.enrichedQuestions).toHaveLength(2);
    expect(out.enrichedQuestions[0]!.id).toBe('q1');
    expect(out.enrichedQuestions[0]!.suggestedAnswers).toEqual(['A1']);
    expect(out.enrichedQuestions[1]!.id).toBe('q2');
    expect(out.enrichedQuestions[1]!.suggestedAnswers).toEqual(['B1', 'B2']);
  });

  it('falls back to empty suggestedAnswers when llmOutput is undefined (skipIf path)', async () => {
    const out = await knowledgeQaSuggestionsStep.apply(makeCtx(), {
      detected,
      formValues: {},
      llmOutput: undefined,
      iteration: 0,
      previousIterations: [],
    });
    expect(out.enrichedQuestions).toHaveLength(2);
    expect(out.enrichedQuestions[0]!.suggestedAnswers).toEqual([]);
    expect(out.enrichedQuestions[1]!.suggestedAnswers).toEqual([]);
  });

  it('leaves a question with no matching suggestion entry empty', async () => {
    const llmOutput = fence({
      suggestions: [{ questionId: 'q1', suggestedAnswers: ['A1'] }],
    });
    const out = await knowledgeQaSuggestionsStep.apply(makeCtx(), {
      detected,
      formValues: {},
      llmOutput,
      iteration: 0,
      previousIterations: [],
    });
    expect(out.enrichedQuestions[0]!.suggestedAnswers).toEqual(['A1']);
    expect(out.enrichedQuestions[1]!.suggestedAnswers).toEqual([]);
  });
});
