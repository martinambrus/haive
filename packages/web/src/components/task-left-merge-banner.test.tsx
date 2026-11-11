// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskLeftMergeBanner } from './task-left-merge-banner';

const h = vi.hoisted(() => ({
  viewer: 'owner',
  post: vi.fn(),
  events: [] as { eventType: string; payload: Record<string, unknown> }[],
}));
vi.mock('@/lib/api-client', () => ({
  api: {
    get: async (url: string) =>
      url === '/auth/me' ? { user: { id: h.viewer } } : { events: h.events },
    post: h.post,
  },
}));
vi.mock('@/components/markdown/inline-markdown', () => ({
  InlineMarkdown: ({ body }: { body: string }) => <p>{body}</p>,
}));
const payload = {
  dir: '/repo',
  repoPath: '/repo',
  landedOn: 'main',
  baseShaBefore: 'a'.repeat(40),
  baseShaAfter: 'b'.repeat(40),
  landedAt: '2026-11-11T00:00:00Z',
  featureBranch: 'feature',
  featureSha: 'c'.repeat(40),
  mergeStage: 'feature',
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  h.viewer = 'owner';
  h.post.mockReset();
  h.post.mockResolvedValue({ queued: true });
  h.events = [
    { eventType: 'merge.left_committed', payload },
    { eventType: 'task.cancel_finished', payload: {} },
  ];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () => {
    root.render(<TaskLeftMergeBanner taskId="task" taskStatus="cancelled" ownerId="owner" />);
  });
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label);
const click = (label: string) =>
  act(async () => {
    expect(button(label)).toBeDefined();
    button(label)!.click();
  });

it('shows Undo only to the owner', async () => {
  h.viewer = 'other';
  await render();
  expect(button('Undo merge')).toBeUndefined();
});
it('confirms the exact move, posts only after confirmation, then displays the outcome', async () => {
  await render();
  await click('Undo merge');
  expect(document.body.textContent).toContain(payload.baseShaBefore);
  expect(document.body.textContent).toContain(payload.baseShaAfter);
  expect(document.body.textContent).toContain('main');
  expect(h.post).not.toHaveBeenCalled();
  await click('Cancel');
  expect(h.post).not.toHaveBeenCalled();
  await click('Undo merge');
  const dialog = document.querySelector('[role="dialog"]')!;
  const confirm = [...dialog.querySelectorAll('button')].find(
    (b) => b.textContent === 'Undo merge',
  )!;
  await act(async () => confirm.click());
  expect(h.post).toHaveBeenCalledWith('/tasks/task/merges/undo', {
    dir: '/repo',
    baseShaAfter: payload.baseShaAfter,
  });
  h.events = [
    ...h.events,
    {
      eventType: 'merge.left_committed_settled',
      payload: {
        dir: '/repo',
        baseShaAfter: payload.baseShaAfter,
        outcome: 'undone',
        reason: 'Restored main',
      },
    },
  ];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(document.body.textContent).toContain('Restored main');
  expect(button('Undo merge')).toBeUndefined();
});

it('offers another Undo after a retryable refusal and shows the reason', async () => {
  await render();
  await click('Undo merge');
  const confirm = [...document.querySelector('[role="dialog"]')!.querySelectorAll('button')].find(
    (b) => b.textContent === 'Undo merge',
  )!;
  await act(async () => confirm.click());
  expect(document.body.textContent).toContain('Undoing…');
  h.events = [
    ...h.events,
    {
      eventType: 'merge.left_committed_settled',
      payload: { ...payload, outcome: 'refused', reason: 'The root is busy.' },
    },
  ];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(document.body.textContent).toContain('The root is busy.');
  expect(document.body.textContent).not.toContain('Undoing…');
  expect(button('Undo merge')).toBeDefined();
});
