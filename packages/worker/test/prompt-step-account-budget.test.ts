import { describe, expect, it } from 'vitest';
import { PROMPT_STEP_TEMPLATE_MAX_BYTES, promptStepEntrySchema } from '@haive/shared/modularity';
import {
  PROMPT_STEP_OUTPUT_CAP_BYTES,
  PROMPT_STEP_OUTPUTS_BUDGET_BYTES,
  PROMPT_STEP_VALUES_BUDGET_BYTES,
  buildPromptStep,
  capStepOutput,
  promptStepNamedText,
} from '../src/step-engine/steps/custom/prompt-step.js';

// Controls of J6b fix-1 and fix-2 (task #186). Tags: [F1] and [N1] fail before the fix, [F0] and [N0] pass before and after.

const ID = 'custom.demo.budget';
const ACCOUNT = '{{integration:a.account}}';
const FIELD = '{{field:x}}';
const LABEL = '§'.repeat(200);
const COPIES = Math.floor(PROMPT_STEP_TEMPLATE_MAX_BYTES / ACCOUNT.length);
const DETECTED = { taskTitle: '', taskDescription: '', stepOutputs: {} };

interface Over {
  accounts?: Record<string, string>;
  fields?: Record<string, unknown>;
  outputs?: Record<string, string>;
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
    detected: { ...DETECTED, taskTitle: over.title ?? '', stepOutputs: over.outputs ?? {} },
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

const QUOTE = '{{step:a}}';
const FIELD_COPIES = Math.floor(PROMPT_STEP_TEMPLATE_MAX_BYTES / FIELD.length);
const QUOTE_COPIES = Math.floor(PROMPT_STEP_TEMPLATE_MAX_BYTES / (QUOTE.length + 1));

/** What the values add to the prompt, notices of cut values included: the prompt less the same prompt with every value empty. */
const valueBytes = (template: string, over: Over, empty: Over = {}): number =>
  Buffer.byteLength(prompt(template, over)) - Buffer.byteLength(prompt(template, empty));

describe('J6b fix-2: the notice of a cut value counts inside its share', () => {
  const CAPS = [64, 100, 1001, PROMPT_STEP_OUTPUT_CAP_BYTES];
  const CUT = [
    ['ASCII', 'x'.repeat(50_000)],
    ['two-byte', '§'.repeat(50_000)],
  ] as const;

  it.each(CUT.flatMap(([kind, text]) => CAPS.map((cap) => [kind, cap, text] as const)))(
    '[N1] a cut %s value comes back in at most %i bytes, notice included',
    (_kind, cap, text) => {
      const capped = capStepOutput(text, cap);

      expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(cap);
      expect(capped).toContain('[truncated:');
    },
  );

  it('[N1] keeps a template full of cut field tokens inside the values budget, notices included', () => {
    const template = FIELD.repeat(FIELD_COPIES);

    const bytes = valueBytes(template, { fields: { x: 'x'.repeat(20_000) } });

    expect(bytes).toBeLessThanOrEqual(PROMPT_STEP_VALUES_BUDGET_BYTES);
  });

  it('[N1] keeps a template full of cut account tokens inside the values budget, notices included', () => {
    const template = ACCOUNT.repeat(COPIES);

    const bytes = valueBytes(template, { accounts: { a: 'x'.repeat(200) } });

    expect(bytes).toBeLessThanOrEqual(PROMPT_STEP_VALUES_BUDGET_BYTES);
  });

  it('[N1] keeps a template full of cut quotes inside the quotes budget, notices included', () => {
    const template = `${QUOTE}\n`.repeat(QUOTE_COPIES);

    const bytes = valueBytes(
      template,
      { outputs: { a: 'x'.repeat(20_000) } },
      { outputs: { a: '' } },
    );

    expect(bytes).toBeLessThanOrEqual(PROMPT_STEP_OUTPUTS_BUDGET_BYTES);
  });

  it.each([
    ['ASCII', 'x'.repeat(1000)],
    ['two-byte', '§'.repeat(500)],
  ])('[N0] gives back a %s value that fits its cap as it is, to the byte', (_kind, text) => {
    const cap = Buffer.byteLength(text);

    expect(capStepOutput(text, cap)).toBe(text);
    expect(capStepOutput(text, cap + 1)).toBe(text);
  });

  it('[N0] says how many bytes it left out', () => {
    const text = 'x'.repeat(5000);

    const capped = capStepOutput(text, 1000);

    const [head, left] = capped.split(/\n\[truncated: (\d+) more bytes not shown\]$/);
    expect(Buffer.byteLength(head!) + Number(left)).toBe(5000);
  });

  it('[N0] shows no head, and does not cut from the end, when the cap is smaller than the notice', () => {
    const capped = capStepOutput('x'.repeat(1000), 10);

    expect(Buffer.byteLength(capped)).toBeLessThan(100);
    expect(capped).toContain('[truncated:');
  });
});
