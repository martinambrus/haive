import { describe, expect, it } from 'vitest';
import { PROMPT_STEP_TEMPLATE_MAX_BYTES, promptStepEntrySchema } from '@haive/shared/modularity';
import {
  PROMPT_STEP_OUTPUT_CAP_BYTES,
  PROMPT_STEP_VALUES_BUDGET_BYTES,
  buildPromptStep,
  promptStepNamedText,
} from '../src/step-engine/steps/custom/prompt-step.js';

// Controls of J6b fix-1 (task #186). Tags: [F1] fails before the fix, [F0] passes before and after.

const ID = 'custom.demo.budget';
const ACCOUNT = '{{integration:a.account}}';
const FIELD = '{{field:x}}';
const LABEL = '§'.repeat(200);
const COPIES = Math.floor(PROMPT_STEP_TEMPLATE_MAX_BYTES / ACCOUNT.length);
const DETECTED = { taskTitle: '', taskDescription: '', stepOutputs: {} };

interface Over {
  accounts?: Record<string, string>;
  fields?: Record<string, unknown>;
  title?: string;
}

const entryFor = (template: string) =>
  promptStepEntrySchema.parse({
    slug: 'budget',
    title: 'Budget',
    template,
    capabilities: [],
    timeoutMs: 120_000,
    integrations: [{ id: 'a', category: 'forge', access: 'read' }],
  });

const stepFor = (template: string) => buildPromptStep(ID, entryFor(template), 0);

const prompt = (template: string, over: Over = {}) =>
  stepFor(template).llm!.buildPrompt({
    detected: { ...DETECTED, taskTitle: over.title ?? '' },
    formValues: over.fields ?? {},
    integrationAccounts: over.accounts ?? {},
  });

const bytesOf = (text: string, char: string): number =>
  (text.split(char).length - 1) * Buffer.byteLength(char, 'utf8');

describe('J6b fix-1: account texts and the value budget', () => {
  it('[F1] keeps a template full of tokens inside the budget', () => {
    const text = prompt(ACCOUNT.repeat(COPIES), { accounts: { a: LABEL } });

    expect(bytesOf(text, '§')).toBeLessThanOrEqual(PROMPT_STEP_VALUES_BUDGET_BYTES);
    expect(text).toContain('[truncated:');
  });

  it('[F1] cuts a token as it cuts a field', () => {
    const fromTokens = prompt(ACCOUNT.repeat(COPIES), { accounts: { a: LABEL } });
    const fromFields = prompt(FIELD.repeat(COPIES), { fields: { x: LABEL } });

    expect(bytesOf(fromTokens, '§')).toBe(bytesOf(fromFields, '§'));
  });

  it('[F1] counts a token with the fields and the task title', () => {
    const line = `{{task.title}} {{field:x}} ${ACCOUNT}\n`;
    const template = line.repeat(Math.floor(PROMPT_STEP_TEMPLATE_MAX_BYTES / line.length));
    const text = prompt(template, {
      accounts: { a: LABEL },
      fields: { x: '¶'.repeat(200) },
      title: '†'.repeat(200),
    });
    const bytes = bytesOf(text, '§') + bytesOf(text, '¶') + bytesOf(text, '†');

    expect(bytes).toBeLessThanOrEqual(PROMPT_STEP_VALUES_BUDGET_BYTES);
  });

  it('[F1] cuts a single text that is longer than a value may be', () => {
    const text = prompt(`Acting as ${ACCOUNT}.`, { accounts: { a: '§'.repeat(10_000) } });

    expect(bytesOf(text, '§')).toBeLessThanOrEqual(PROMPT_STEP_OUTPUT_CAP_BYTES);
    expect(text).toContain('[truncated:');
  });

  it('[F0] renders the whole label of a single token', () => {
    const text = prompt(`Acting as ${ACCOUNT}.`, { accounts: { a: LABEL } });

    expect(text).toContain(`Acting as ${LABEL}.`);
    expect(text).not.toContain('[truncated:');
  });

  it('[F0] cuts a field in the house-rule text as it cuts it in the prompt', () => {
    const template = `{{field:x}}\n${ACCOUNT.repeat(400)}`;
    const fields = { x: '¶'.repeat(200) };
    const named = promptStepNamedText(stepFor(template), DETECTED, fields);
    const sent = prompt(template, { accounts: { a: LABEL }, fields });

    expect(bytesOf(named!, '¶')).toBe(bytesOf(sent, '¶'));
  });

  it('[F0] renders an account whose requirement id is __proto__', () => {
    const text = prompt('Acting as {{integration:__proto__.account}}.', {
      accounts: JSON.parse('{"__proto__":"octo-user"}') as Record<string, string>,
    });

    expect(text).toContain('Acting as octo-user.');
  });
});
