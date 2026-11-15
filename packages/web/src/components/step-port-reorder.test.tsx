import { describe, expect, it, vi } from 'vitest';
import { TaskTypeComposer } from './task-type-composer';
import { TEST_CATALOG } from '@/lib/composition-test-catalog';
import { createRenderer, buttons, findAll, fire, textOf } from '../../test/render-tree';
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('./step-port-view', () => ({
  StepPortView: ({
    children,
    onReorder,
  }: {
    children: unknown;
    onReorder?: (from: number, to: number) => void;
  }) => (
    <>
      {children}
      <button onClick={() => onReorder?.(0, 1)}>Canvas reorder</button>
    </>
  ),
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
function mount(ids: string[]) {
  let draft = ids;
  const set = vi.fn((next: string[]) => {
    draft = next;
  });
  const renderer = createRenderer(() => (
    <TaskTypeComposer
      catalog={TEST_CATALOG}
      stepIds={draft}
      loopLimits={{}}
      requiresRepository={false}
      onStepIdsChange={set}
      onLoopLimitsChange={() => {}}
    />
  ));
  return {
    set,
    draft: () => draft,
    press: (label: RegExp) => {
      fire.click(buttons(renderer.tree(), label)[0]!);
      renderer.draw();
    },
    message: () =>
      findAll(renderer.tree(), (n) => n.props.role === 'status')
        .map((node) => textOf(node))
        .join(''),
  };
}
describe('one list/canvas reorder mutation', () => {
  it('produces the same serialized draft for a legal move', () => {
    const ids = ['04-phase-0b-pre-planning', '01-worktree-setup'];
    const list = mount(ids);
    const canvas = mount(ids);
    list.press(/^move phase 0b: pre-planning down$/i);
    canvas.press(/^canvas reorder$/i);
    expect(list.set).toHaveBeenCalledOnce();
    expect(canvas.set).toHaveBeenCalledOnce();
    expect(canvas.draft()).toEqual(list.draft());
  });
  it('refuses a token-breaking canvas move with the same list message and leaves the draft intact', () => {
    const ids = ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality'];
    const list = mount(ids);
    const canvas = mount(ids);
    list.press(/^move phase 0b: pre-planning down$/i);
    expect(list.set).not.toHaveBeenCalled();
    canvas.press(/^canvas reorder$/i);
    expect(canvas.set).not.toHaveBeenCalled();
    expect(canvas.draft()).toEqual(ids);
    expect(canvas.message()).toBe(list.message());
    expect(canvas.message()).toContain('Needs spec first');
  });
});
