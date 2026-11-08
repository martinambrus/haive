import { describe, expect, it } from 'vitest';
import { promptStepEntrySchema } from '@haive/shared/modularity';
import {
  CUSTOM_TEMPLATE_INVALID_REASON,
  buildPromptStep,
  promptStepNamedText,
} from '../src/step-engine/steps/custom/prompt-step.js';

const ID = 'custom.demo.invalid';
const DETECTED = { taskTitle: '', taskDescription: '', stepOutputs: {} };

const stepFor = (template: string) =>
  buildPromptStep(
    ID,
    promptStepEntrySchema.parse({
      slug: 'invalid',
      title: 'Invalid',
      template,
      capabilities: [],
      timeoutMs: 120_000,
    }),
    0,
  );

const build = (template: string, fields: Record<string, unknown> = {}) =>
  stepFor(template).llm!.buildPrompt({
    detected: DETECTED,
    formValues: fields,
    integrationAccounts: {},
  });

describe('a pinned template that no longer parses', () => {
  it('[T1] fails building the prompt instead of rendering it half-done', () => {
    expect(() => build('Say {{nope}} and {{field:x}}', { x: 'hi' })).toThrow(
      `${CUSTOM_TEMPLATE_INVALID_REASON}: `,
    );
    expect(() => build('Say {{nope}} and {{field:x}}', { x: 'hi' })).toThrow('{{nope}}');
  });

  it('[T2] names at most 8 problems and counts the rest', () => {
    const template = Array.from({ length: 11 }, (_, i) => `{{bad${i}}}`).join(' ');
    expect(() => build(template)).toThrow(/ And 3 more\. The task pinned it/);
  });

  it('[T0] leaves the house rules reader answering without throwing', () => {
    expect(() =>
      promptStepNamedText(stepFor('Say {{nope}} and {{field:x}}'), DETECTED, { x: 'hi' }),
    ).not.toThrow();
  });

  it('[T0] still builds a valid template', () => {
    const text = build('A {{field:x}} B\n{{step:a}}\n', { x: 'hi' });
    expect(text).toContain('A hi B');
  });
});
