import { expect, it, vi } from 'vitest';
import type { PromptStepEntry } from '@haive/shared/modularity';
import { STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import { TEST_PROMPT_ROLE } from '../../test/support/prompt-role.js';
import { PromptStepEditor } from './prompt-step-editor';
import { buttons, controls, createRenderer, fire } from '../../test/render-tree';
vi.mock('../../../shared/dist/step-engine/output-contracts.js', async (original) => {
  const { withTestPromptRole } = await import('../../test/support/prompt-role.js');
  return withTestPromptRole(
    await original<typeof import('../../../shared/dist/step-engine/output-contracts.js')>(),
  );
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
it('inserts and renames role tokens and toggles structured mode with an empty initial selection', () => {
  let entry: PromptStepEntry = {
    slug: 'use',
    title: 'Use',
    template: 'Read',
    timeoutMs: 60000,
    capabilities: [],
    tools: [],
    consumesRoles: [
      {
        input: 'report',
        role: TEST_PROMPT_ROLE,
        contract: STEP_ROLE_REGISTRY[TEST_PROMPT_ROLE].contract,
        optional: false,
      },
    ],
  };
  const view = createRenderer(() => (
    <PromptStepEditor
      entry={entry}
      onChange={(next) => {
        entry = next;
      }}
      onRemove={() => {}}
    />
  ));
  fire.click(buttons(view.tree(), /^insert token$/i)[0]!);
  view.draw();
  expect(entry.template).toBe('Read\n{{role:report}}\n');
  fire.type(controls(view.tree(), /^role input 1 name$/i)[0]!, 'result');
  view.draw();
  expect(entry.template).toBe('Read\n{{role:result}}\n');
  fire.type(controls(view.tree(), /^role input 1 name$/i)[0]!, '');
  view.draw();
  fire.type(controls(view.tree(), /^role input 1 name$/i)[0]!, 'renamed');
  view.draw();
  expect(entry.template).toBe('Read\n{{role:renamed}}\n');
  fire.check(controls(view.tree(), /^structured output$/i)[0]!, true);
  view.draw();
  expect(entry.outputMode).toBe('structured');
  expect(entry.providesRoles).toEqual([]);
  fire.type(controls(view.tree(), /^provided role$/i)[0]!, TEST_PROMPT_ROLE);
  view.draw();
  expect(entry.providesRoles?.[0]?.role).toBe(TEST_PROMPT_ROLE);
  fire.check(controls(view.tree(), /^structured output$/i)[0]!, false);
  view.draw();
  expect(entry).not.toHaveProperty('outputMode');
  expect(entry).not.toHaveProperty('providesRoles');
});
