import { describe, expect, it, vi } from 'vitest';
import type { ComposableStepEntry } from '@haive/shared/modularity';
import type { TaskTypeCatalog } from '@/lib/api-client';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';
import type { PromptSteps } from '@/lib/prompt-step-editing';
import { TaskTypeComposer } from './task-type-composer';
import { buttons, createRenderer, findAll, fire, textOf } from '../../test/render-tree';

// No DOM in this package: the composer runs through test/render-tree.ts, and the markdown body is its plain text.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));

const ask = {
  slug: 'ask',
  title: 'Ask the agent',
  template: '{{bogus}} and again {{bogus}}',
  capabilities: [] as [],
  tools: [],
  timeoutMs: 300_000,
};

const needy: ComposableStepEntry = {
  stepId: '06-needy',
  label: 'Needy',
  group: 'spec',
  dispatchesCli: false,
  requires: [
    { needs: 'zzz', reason: 'Needs zzz' },
    { needs: 'zzz', reason: 'Needs zzz' },
  ],
  provides: [],
};
const WITH_NEEDY: TaskTypeCatalog = {
  ...TEST_CATALOG,
  steps: [
    ...TEST_CATALOG.steps,
    { stepId: needy.stepId, source: 'core', title: needy.label, entry: needy },
  ],
  registeredStepIds: [...TEST_CATALOG.registeredStepIds, needy.stepId],
};

function mount(start: { stepIds: string[]; promptSteps?: PromptSteps; catalog?: TaskTypeCatalog }) {
  let stepIds = start.stepIds;
  let promptSteps = start.promptSteps ?? {};
  const view = createRenderer(() => (
    <TaskTypeComposer
      catalog={start.catalog ?? TEST_CATALOG}
      stepIds={stepIds}
      loopLimits={{}}
      requiresRepository
      typeSlug="t"
      promptSteps={promptSteps}
      onPromptStepsChange={(next) => {
        promptSteps = next;
      }}
      onStepIdsChange={(next) => {
        stepIds = next;
      }}
      onLoopLimitsChange={() => {}}
    />
  ));
  return {
    summary: () =>
      findAll(view.tree(), (h) => h.tag === 'p' && /^(No problems|\d+ problems?)$/.test(textOf(h)))
        .map((h) => textOf(h))
        .join(),
    announced: () =>
      findAll(view.tree(), (h) => h.props.role === 'status')
        .map((h) => textOf(h))
        .join(),
    press: (name: RegExp) => {
      fire.click(buttons(view.tree(), name)[0]!);
      view.draw();
    },
  };
}

describe('what the composer announces after a change', () => {
  it('counts a problem the summary shows once as once, though it comes up twice', () => {
    const m = mount({
      stepIds: ['custom.t.ask', '04-phase-0b-pre-planning'],
      promptSteps: { ask },
    });
    expect(m.summary()).toBe('1 problem');
    m.press(/^move ask the agent down$/);
    expect(m.summary()).toBe('1 problem');
    expect(m.announced()).toBe('Moved Ask the agent to position 2; 1 problem');
  });

  it('counts a composition problem the summary shows once as once, though it comes up twice', () => {
    const m = mount({ stepIds: ['04-phase-0b-pre-planning', '06-needy'], catalog: WITH_NEEDY });
    expect(m.summary()).toBe('1 problem');
    m.press(/^move needy up$/);
    expect(m.summary()).toBe('1 problem');
    expect(m.announced()).toBe('Moved Needy to position 1; 1 problem');
  });

  it('says no problems when the summary says none', () => {
    const m = mount({
      stepIds: ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality', '01-worktree-setup'],
    });
    expect(m.summary()).toBe('No problems');
    m.press(/^move worktree setup up$/);
    expect(m.summary()).toBe('No problems');
    expect(m.announced()).toBe('Moved Worktree setup to position 2; no problems');
  });

  it('counts the problems of the list a removal leaves, as the summary then does', () => {
    const m = mount({
      stepIds: ['custom.t.ask', '04-phase-0b-pre-planning', '06-needy'],
      promptSteps: { ask },
      catalog: WITH_NEEDY,
    });
    expect(m.summary()).toBe('2 problems');
    m.press(/^remove needy$/);
    expect(m.summary()).toBe('1 problem');
    expect(m.announced()).toBe('Removed Needy; 1 problem');
  });
});
