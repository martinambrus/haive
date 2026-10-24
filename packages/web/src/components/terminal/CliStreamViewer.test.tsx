import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliStreamViewer } from './CliStreamViewer';
import { createRenderer, findAll, fire, textOf, type Renderer } from '../../../test/render-tree';

// Exercise the live viewer after its connection is established. The tree renderer
// leaves DOM refs empty, so xterm and the WebSocket effect do not run here.
vi.mock('react', async (importOriginal) => {
  const { reactHooks } = await import('../../../test/render-tree');
  return {
    ...(await importOriginal<typeof import('react')>()),
    ...reactHooks,
    useState: (initial: unknown) =>
      reactHooks.useState(initial === 'connecting' ? 'connected' : initial),
  };
});
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
const net = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  api: { post: net.post },
  apiWebSocketUrl: (path: string) => path,
}));

const cancel = (view: Renderer) =>
  findAll(view.tree(), (h) => h.tag === 'button' && h.props['data-action'] === 'cancel-cli')[0]!;
const notices = (view: Renderer) => findAll(view.tree(), (h) => h.props.role === 'status');
const settle = async (view: Renderer) => {
  for (let i = 0; i < 3; i += 1) await view.flush();
};
beforeEach(() => net.post.mockReset());

describe('CliStreamViewer empty Stop result (#395)', () => {
  it.each([
    { killed: 0, cancelled: 0, stopped: 0, notice: true },
    { killed: 1, cancelled: 0, stopped: 0, notice: false },
    { killed: 0, cancelled: 1, stopped: 0, notice: false },
    { killed: 0, cancelled: 0, stopped: 1, notice: false },
    { notice: false },
  ])('shows the empty result notice for %j', async ({ notice, ...result }) => {
    net.post.mockResolvedValue(result);
    const view = createRenderer(() => <CliStreamViewer taskId="t1" invocationId="i1" />);
    expect(cancel(view).props.disabled).toBe(false);
    fire.click(cancel(view));
    await settle(view);
    expect(net.post).toHaveBeenCalledWith('/tasks/t1/cancel-active-cli', {});
    expect(notices(view)).toHaveLength(notice ? 1 : 0);
    if (notice) {
      expect(textOf(notices(view)[0]!)).toBe('Nothing was running to stop.');
      expect(notices(view)[0]!.props.className).toContain('text-neutral-400');
    }
  });

  it('clears the notice at the next cancel and keeps failures in the error slot', async () => {
    net.post.mockResolvedValueOnce({ killed: 0, cancelled: 0, stopped: 0 });
    const view = createRenderer(() => <CliStreamViewer taskId="t1" invocationId="i1" />);
    fire.click(cancel(view));
    await settle(view);
    expect(notices(view)).toHaveLength(1);
    let reject!: (err: Error) => void;
    net.post.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    fire.click(cancel(view));
    await view.flush();
    expect(notices(view)).toHaveLength(0);
    reject(new Error('cancel failed probe'));
    await settle(view);
    expect(textOf(view.tree())).toContain('cancel failed probe');
    net.post.mockResolvedValueOnce({ killed: 1, cancelled: 0, stopped: 0 });
    fire.click(cancel(view));
    await settle(view);
    expect(textOf(view.tree())).not.toContain('cancel failed probe');
  });
});
