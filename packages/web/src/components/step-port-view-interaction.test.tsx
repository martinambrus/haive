import { describe, expect, it, vi } from 'vitest';
import { createRenderer, buttons, findAll, fire, textOf } from '../../test/render-tree';
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/api-client', () => ({ api: h }));
vi.mock('next/dynamic', () => ({
  default:
    () =>
    ({ graph }: { graph: { nodes: { label: string }[] } }) => (
      <div aria-label="Canvas fixture">{graph.nodes.map((n) => n.label).join(',')}</div>
    ),
}));
import { StepPortView } from './step-port-view';
const graph = (label: string) => ({
  candidates: [
    {
      executionPath: null,
      graph: { nodes: [{ id: label, label, inputs: [], outputs: [] }], edges: [] },
    },
  ],
});
describe('port view toggle and request freshness', () => {
  it('keeps the list default, discards a late old draft response, and preserves the current list', async () => {
    const replies: ((value: unknown) => void)[] = [];
    h.post.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
    let name = 'old';
    const view = createRenderer(() => (
      <StepPortView request={{ path: '/admin/task-types/ports', body: { name } }}>
        <ol>
          <li>{name} list</li>
        </ol>
      </StepPortView>
    ));
    expect(textOf(view.tree())).toContain('old list');
    expect(h.post).not.toHaveBeenCalled();
    fire.click(buttons(view.tree(), /^canvas$/)[0]!);
    view.draw();
    expect(h.post).toHaveBeenCalledOnce();
    name = 'new';
    view.draw();
    expect(h.post).toHaveBeenCalledTimes(2);
    replies[0]!(graph('old graph'));
    await Promise.resolve();
    view.draw();
    expect(textOf(view.tree())).not.toContain('old graph');
    replies[1]!(graph('new graph'));
    await Promise.resolve();
    view.draw();
    expect(findAll(view.tree(), (n) => n.props['aria-label'] === 'Canvas fixture')).toHaveLength(1);
    expect(textOf(view.tree())).toContain('new graph');
    fire.click(buttons(view.tree(), /^list$/)[0]!);
    view.draw();
    expect(textOf(view.tree())).toContain('new list');
    expect(textOf(view.tree())).not.toContain('new graph');
  });
});

it('shows an explicit state when the selected path is absent instead of borrowing another graph', async () => {
  h.get.mockResolvedValue(graph('wrong path'));
  const view = createRenderer(() => (
    <StepPortView request={{ path: '/tasks/t/ports' }} executionPath="quick_bugfix">
      <div>List</div>
    </StepPortView>
  ));
  fire.click(buttons(view.tree(), /^canvas$/)[0]!);
  view.draw();
  await Promise.resolve();
  view.draw();
  expect(textOf(view.tree())).toContain('No port graph is available for the selected path.');
  expect(textOf(view.tree())).not.toContain('wrong path');
});
