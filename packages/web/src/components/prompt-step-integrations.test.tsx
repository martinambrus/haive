import { describe, expect, it, vi } from 'vitest';
import { integrationRequirementSchema, type PromptStepEntry } from '@haive/shared/modularity';
import { TaskTypeComposer } from './task-type-composer';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';
import { PromptStepEditor } from './prompt-step-editor';
import { buttons, controls, createRenderer, findAll, fire, textOf } from '../../test/render-tree';
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
const base: PromptStepEntry = {
  slug: 'review',
  title: 'Review',
  template: 'Review',
  capabilities: [],
  tools: [],
  timeoutMs: 300000,
};
const moduleCategories = [{ id: 'module.notes.docs', label: 'Module documents' }];
function mount(integrations?: unknown[]) {
  let entry = { ...base, integrations } as PromptStepEntry;
  const view = createRenderer(() => (
    <PromptStepEditor
      entry={entry}
      integrationCategories={moduleCategories}
      onChange={(next) => {
        entry = next;
      }}
      onRemove={() => {}}
    />
  ));
  const type = (label: RegExp, value: string) => {
    fire.type(controls(view.tree(), label)[0]!, value);
    view.draw();
  };
  const click = (label: RegExp) => {
    fire.click(buttons(view.tree(), label)[0]!);
    view.draw();
  };
  return { view, type, click, entry: () => entry };
}
describe('prompt step integration authoring', () => {
  it('authors a module category, access and optional flag with a named account token', () => {
    const m = mount();
    m.click(/^add integration$/i);
    m.type(/^integration id$/i, 'docs');
    m.type(/^access$/i, 'write');
    fire.check(controls(m.view.tree(), /^optional$/i)[0]!, true);
    m.view.draw();
    expect(m.entry().integrations).toEqual([
      { id: 'docs', category: 'module.notes.docs', access: 'write', optional: true },
    ]);
    expect(integrationRequirementSchema.safeParse(m.entry().integrations![0]).success).toBe(true);
    expect(textOf(m.view.tree())).toContain('{{integration:docs.account}}');
    m.click(/^remove integration$/i);
    expect(m.entry().integrations).toEqual([]);
  });
  it('preserves malformed stored siblings until each is repaired or removed', () => {
    const m = mount([null, { id: 'old', provider: 'github', access: 'read' }]);
    m.type(/^integration id$/i, 'docs');
    m.type(/^category$/i, 'module.notes.docs');
    m.type(/^access$/i, 'read');
    expect(m.entry().integrations).toEqual([
      { id: 'docs', category: 'module.notes.docs', access: 'read' },
      { id: 'old', provider: 'github', access: 'read' },
    ]);
    fire.type(controls(m.view.tree(), /^category$/i)[1]!, 'module.notes.docs');
    m.view.draw();
    expect(m.entry().integrations![1]).toEqual({
      id: 'old',
      category: 'module.notes.docs',
      access: 'read',
    });
  });
  it('updates the selected row overview when a requirement category is repaired, preserving its invalid sibling', () => {
    let entry = {
      ...base,
      integrations: [{ id: 'docs', category: 'module.notes.docs', access: 'read' }, null],
    } as unknown as PromptStepEntry;
    const view = createRenderer(() => (
      <TaskTypeComposer
        catalog={TEST_CATALOG}
        typeSlug="t"
        stepIds={['custom.t.review']}
        promptSteps={{ review: entry }}
        loopLimits={{}}
        requiresRepository={false}
        integrationCategories={[...moduleCategories, { id: 'mail', label: 'Email' }]}
        integrationInfo={{
          status: 'current',
          providers: [],
          categories: [...moduleCategories, { id: 'mail', label: 'Email' }],
          modules: [{ id: 'notes', name: 'Notes', state: 'loaded' }],
        }}
        onStepIdsChange={() => {}}
        onLoopLimitsChange={() => {}}
        onPromptStepsChange={(next) => {
          entry = next.review!;
        }}
      />
    ));
    const overview = () =>
      textOf(
        findAll(view.tree(), (host) => host.props['aria-label'] === 'Integration requirements')[0]!,
      );
    expect(overview()).toContain('Module documents');
    fire.click(buttons(view.tree(), /^edit prompt step review$/i)[0]!);
    view.draw();
    fire.type(controls(view.tree(), /^category$/i)[0]!, 'mail');
    view.draw();
    expect(overview()).toContain('Email');
    expect(overview()).not.toContain('Module documents');
    expect(overview()).toContain('Invalid stored requirement');
    expect(entry.integrations![1]).toBe(null);
  });
});
