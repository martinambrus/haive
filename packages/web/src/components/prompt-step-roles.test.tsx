import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { STEP_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import { PromptStepEditor } from './prompt-step-editor';
import { samePromptSteps } from '../lib/prompt-step-editing';
const role = STEP_ROLES.codeAudit,
  contract = STEP_ROLE_REGISTRY[role].contract;
const entry = {
  slug: 'use',
  title: 'Use',
  template: '{{role:report}}',
  capabilities: [],
  tools: [],
  timeoutMs: 60000,
  consumesRoles: [{ input: 'report', role, contract, optional: false }],
};
it('authors role inputs, token insertion and structured output in the existing editor', () => {
  const html = renderToStaticMarkup(
    <PromptStepEditor
      entry={{ ...entry, outputMode: 'structured', providesRoles: [{ role, contract }] }}
      onChange={() => {}}
      onRemove={() => {}}
    />,
  );
  for (const copy of [
    'Role inputs',
    '{{role:report}}',
    'Insert token',
    'Add role input',
    'Structured output',
    'Provided role',
    'haive.code-audit@1',
  ])
    expect(html).toContain(copy);
});
it('retains role declaration and mode edits as unsaved changes', () => {
  const before = { use: entry };
  expect(samePromptSteps(before, { use: { ...entry, consumesRoles: [] } })).toBe(false);
  expect(
    samePromptSteps(before, {
      use: { ...entry, outputMode: 'structured', providesRoles: [{ role, contract }] },
    }),
  ).toBe(false);
});

it('clearly disables structured output when production has no providable roles', () => {
  const html = renderToStaticMarkup(
    <PromptStepEditor entry={entry} onChange={() => {}} onRemove={() => {}} />,
  );
  expect(html).toContain('Structured output is unavailable');
  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/);
});
