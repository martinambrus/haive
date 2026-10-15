import { describe, expect, it } from 'vitest';
import {
  CUSTOM_TOOL_STRING_DEFAULT_LENGTH,
  customToolSchema,
  type CustomTool,
  type HttpGetTool,
} from '@haive/shared/modularity';
import type { StoredPromptStep } from './api-client';
import type { PromptStepIssue } from './composition-messages';
import { isToolIssue, newParam, newTool, readPromptSteps } from './prompt-step-editing';
import { buildUpdateBody, compositionChanged } from './task-type-form';

const tool = customToolSchema.parse({
  action: 'http-get',
  name: 'repo_status',
  description: 'Fetches the status of one repository.',
  url: 'https://api.example.com/v1/status',
}) as HttpGetTool;
const old: StoredPromptStep = {
  slug: 'a',
  title: 'Check it',
  template: 'Review',
  capabilities: [],
  timeoutMs: 600_000,
};
const IDS = ['custom.t.a'];

describe('newTool', () => {
  it('reads as the schema reads a minimal tool, with the text left blank', () => {
    expect(newTool()).toEqual({
      ...customToolSchema.parse({ action: 'http-get', name: 'x', description: 'x', url: 'x' }),
      name: '',
      description: '',
      url: '',
    });
    expect(newTool('rag-query')).toEqual({
      ...customToolSchema.parse({
        action: 'rag-query',
        name: 'x',
        description: 'x',
        scope: 'global',
      }),
      name: '',
      description: '',
    });
  });

  it('keeps the name, description and response cap when the action changes, and nothing else', () => {
    const http: CustomTool = { ...tool, maxResponseBytes: 2048 };
    const switched = newTool('rag-query', http);
    expect(switched).toMatchObject({
      action: 'rag-query',
      name: tool.name,
      description: tool.description,
      maxResponseBytes: 2048,
    });
    expect(Object.keys(switched).sort()).toEqual([
      'action',
      'description',
      'maxResponseBytes',
      'name',
      'scope',
      'topK',
    ]);
  });
});

describe('newParam', () => {
  it.each([
    ['string', { type: 'string', maxLength: CUSTOM_TOOL_STRING_DEFAULT_LENGTH }],
    ['integer', { type: 'integer' }],
    ['boolean', { type: 'boolean' }],
    ['enum', { type: 'enum', values: [] }],
  ] as const)('starts a %s parameter blank, with that type only', (type, rest) => {
    expect(newParam(type)).toEqual({ name: '', description: '', required: false, ...rest });
  });

  it('takes its string default from the schema', () => {
    const parsed = customToolSchema.parse({
      ...tool,
      params: [{ name: 'p', description: 'd', type: 'string' }],
    }) as HttpGetTool;
    expect(parsed.params[0]).toEqual({ ...newParam('string'), name: 'p', description: 'd' });
  });

  it('keeps the name, description and flag when the type changes', () => {
    const was = { name: 'repo', description: 'The repo.', required: true };
    expect(newParam('enum', { ...newParam('integer'), ...was })).toEqual({
      ...was,
      type: 'enum',
      values: [],
    });
  });
});

describe('isToolIssue', () => {
  const issue = (kind: PromptStepIssue['kind'], raw?: string): PromptStepIssue => ({
    kind,
    stepId: 'custom.t.a',
    ...(raw === undefined ? {} : { raw }),
  });

  it('matches a problem that is about one tool by the name in raw', () => {
    expect(isToolIssue(issue('tool-url-not-https', 'repo_status'), tool)).toBe(true);
    expect(isToolIssue(issue('tool-no-longer-valid', 'repo_status'), tool)).toBe(true);
    expect(isToolIssue(issue('tool-url-not-https', 'other'), tool)).toBe(false);
    expect(isToolIssue(issue('tool-url-not-https'), tool)).toBe(false);
  });

  it('leaves the problems of the template and of the whole list on the step', () => {
    expect(isToolIssue(issue('unknown-token', 'repo_status'), tool)).toBe(false);
    expect(isToolIssue(issue('too-many-tools', ''), { name: '' })).toBe(false);
  });

  it('matches a tool that has no name yet, so its first problems have a row', () => {
    expect(isToolIssue(issue('tool-name-invalid', ''), { name: '' })).toBe(true);
  });
});

describe('a step stored before tools existed', () => {
  const stored = { a: old };

  it('is read as one with an empty list, and every other key is kept', () => {
    expect(readPromptSteps(stored)).toEqual({ a: { ...old, tools: [] } });
    expect(readPromptSteps({ a: { ...old, tools: [tool] } }).a!.tools).toEqual([tool]);
  });

  it('is not changed by being read that way', () => {
    const saved = { stepIds: IDS, stepLoopLimitDefaults: {}, promptSteps: stored };
    const current = { stepIds: IDS, loopLimits: {}, promptSteps: readPromptSteps(stored) };
    expect(compositionChanged(current, saved)).toBe(false);
  });

  it('sends the prompt steps when a tool is added, and only then', () => {
    const saved = { stepIds: IDS, stepLoopLimitDefaults: {}, promptSteps: stored };
    const send = (promptSteps: ReturnType<typeof readPromptSteps>) =>
      buildUpdateBody(
        {},
        ['stepIds', 'promptSteps'],
        {
          stepIds: IDS,
          loopLimits: {},
          promptSteps,
          typeSlug: 't',
          saved,
        },
        {},
      );
    expect(send(readPromptSteps(stored))).toEqual({});
    expect(send({ a: { ...old, tools: [tool] } })).toEqual({
      promptSteps: { a: { ...old, tools: [tool] } },
    });
  });
});
