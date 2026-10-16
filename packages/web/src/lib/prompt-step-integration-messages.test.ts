import { describe, expect, it } from 'vitest';
import {
  CUSTOM_TOOL_PROBLEM_KINDS,
  PROMPT_STEP_PROBLEM_KINDS,
  validatePromptStep,
  type PromptStepValidationContext,
  type PromptStepValidationInput,
} from '@haive/shared/modularity';
import { describePromptStepIssue, promptStepIssuesOf } from './composition-messages';

// Control of J6a (task #185), web side: every issue kind the save validator can raise for what a prompt step
// declares has a message in describePromptStepIssue, a switch with no default. Tags: [C4] is inside the brief,
// [C4+] is a pin the brief does not state (listed in the harness README).

const KINDS_BEFORE_J6A: ReadonlySet<string> = new Set([
  'unknown-token',
  'field-not-declared',
  'persona-id-invalid',
  'reserved-marker-in-template',
  'integration-token',
  'template-too-large',
  'timeout-out-of-range',
  'capability-not-allowed',
  'persona-without-repository',
  'file-write-without-repository',
  'step-id-too-long',
  'step-token-not-earlier',
  'step-token-not-quotable',
  'step-token-not-own-line',
  ...CUSTOM_TOOL_PROBLEM_KINDS,
  'tool-no-longer-valid',
]);

const CORE_CATEGORIES = [
  'rich-documents',
  'spreadsheets',
  'file-storage',
  'mail',
  'chat',
  'issues',
  'wiki',
  'forge',
];
const req = (id: string, category: string, access: 'read' | 'write' = 'read') => ({
  id,
  category,
  access,
});
const NINE = [
  ...CORE_CATEGORIES.map((category, i) => req(`r${i}`, category)),
  req('r8', 'module.demo.extra'),
];

const entry = (over: Record<string, unknown>): PromptStepValidationInput =>
  ({
    template: 'Review {{task.title}}',
    capabilities: [],
    timeoutMs: 300_000,
    ...over,
  }) as PromptStepValidationInput;
const ctxOf = (over: Record<string, unknown> = {}): PromptStepValidationContext =>
  ({
    typeSlug: 'audit',
    requiresRepository: true,
    stepIdsBefore: ['01-worktree-setup'],
    ...over,
  }) as PromptStepValidationContext;

// The six refusals of the brief, each as the one thing wrong with an otherwise valid step.
const REFUSALS: [string, PromptStepValidationInput, PromptStepValidationContext][] = [
  ['more than eight requirements', entry({ integrations: NINE }), ctxOf()],
  [
    'a requirement that pins a provider',
    entry({ integrations: [{ id: 'gh', provider: 'github', access: 'read' }] }),
    ctxOf(),
  ],
  [
    'two requirements of one category',
    entry({ integrations: [req('first', 'issues'), req('second', 'issues', 'write')] }),
    ctxOf(),
  ],
  ['an id that breaks the grammar', entry({ integrations: [req('1st', 'forge')] }), ctxOf()],
  [
    'a category the context does not list',
    entry({ integrations: [req('talk', 'chat')] }),
    ctxOf({ integrationCategoryIds: new Set(['forge', 'issues']) }),
  ],
  [
    'forge on a type with no repository',
    entry({ integrations: [req('prs', 'forge')] }),
    ctxOf({ requiresRepository: false }),
  ],
];

const STEP_ID = 'custom.audit.check';
const issueOf = (problem: { kind: string; raw: string }) =>
  ({
    kind: problem.kind,
    stepId: STEP_ID,
    ...(problem.raw ? { raw: problem.raw } : {}),
  }) as Parameters<typeof describePromptStepIssue>[0];

describe('[C4] a message for each issue kind of a declared requirement', () => {
  it.each(REFUSALS)('[C4] has words for what the validator raises for %s', (name, e, c) => {
    const problems = validatePromptStep(e, c);

    expect(problems.length, `the validator raised nothing for ${name}`).toBeGreaterThan(0);
    for (const problem of problems) {
      const text = describePromptStepIssue(issueOf(problem)) as string | undefined;
      expect(text, `no message for the kind ${problem.kind}`).toBeTypeOf('string');
      expect(text).toMatch(/\S/);
      expect(text).not.toBe('undefined');
    }
  });

  it('[C4] says something different for each of the six kinds', () => {
    const texts = REFUSALS.map(([name, e, c]) => {
      const [problem] = validatePromptStep(e, c);
      expect(problem, `the validator raised nothing for ${name}`).toBeDefined();
      return describePromptStepIssue(issueOf(problem!)) as string | undefined;
    });

    expect(
      texts.every((text) => typeof text === 'string' && /\S/.test(text)),
      'a kind has no message',
    ).toBe(true);
    expect(new Set(texts).size).toBe(6);
  });

  it('[C4+] has words for the problem of a stored requirement that no longer parses', () => {
    const problems = validatePromptStep(entry({ invalidIntegrations: ['broken'] }), ctxOf());

    expect(problems.length, 'the validator raised nothing for a stored requirement').toBe(1);
    const text = describePromptStepIssue(issueOf(problems[0]!)) as string | undefined;
    expect(text, `no message for the kind ${problems[0]!.kind}`).toBeTypeOf('string');
    expect(text).toMatch(/\S/);
    expect(text).toContain('broken');
  });

  it('[C4+] names the requirement a message is about, when the issue carries a name', () => {
    const named = REFUSALS.filter(([name]) => name !== 'more than eight requirements');

    for (const [name, e, c] of named) {
      const problems = validatePromptStep(e, c);
      expect(problems.length, `the validator raised nothing for ${name}`).toBeGreaterThan(0);
      for (const problem of problems.filter((p) => p.raw !== '')) {
        const text = describePromptStepIssue(issueOf(problem)) as string | undefined;
        expect(text, `no message for the kind ${problem.kind}`).toBeTypeOf('string');
        expect(text, name).toContain(problem.raw);
      }
    }
  });

  it('[C4+] reads those issues from the body of a refusal by the server', () => {
    const issues = REFUSALS.flatMap(([, e, c]) =>
      validatePromptStep(e, c).map((problem) => ({
        kind: problem.kind,
        stepId: STEP_ID,
        message: problem.message,
        raw: problem.raw,
      })),
    );

    expect(issues.length).toBeGreaterThanOrEqual(6);
    expect(promptStepIssuesOf(issues)).toHaveLength(issues.length);
  });

  it('[C4+] has words for every kind added to the validator, and there are at least six of them', () => {
    const added = PROMPT_STEP_PROBLEM_KINDS.filter((kind) => !KINDS_BEFORE_J6A.has(kind));

    expect(added.length, 'kinds added to PROMPT_STEP_PROBLEM_KINDS').toBeGreaterThanOrEqual(6);
    for (const kind of added) {
      const text = describePromptStepIssue({ kind, stepId: STEP_ID, raw: 'some-id' }) as
        string | undefined;
      expect(text, `no message for the kind ${kind}`).toBeTypeOf('string');
      expect(text).toMatch(/\S/);
    }
  });
});
