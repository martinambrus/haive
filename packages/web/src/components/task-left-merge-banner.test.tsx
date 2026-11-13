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

it('waits for cancellation teardown before offering Undo', async () => {
  h.events = h.events.filter((e) => e.eventType !== 'task.cancel_finished');
  await render();
  expect(button('Undo merge')).toBeUndefined();
  h.events = [...h.events, { eventType: 'task.cancel_finished', payload: {} }];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(button('Undo merge')).toBeDefined();
});

const oweResync = () =>
  h.events.push({
    eventType: 'merge.left_committed_settled',
    payload: { ...payload, outcome: 'undone', reason: 'Restored main' },
  });
it('offers Retry for owed re-sync, keeps it available, and observes completion while polling', async () => {
  oweResync();
  await render();
  expect(document.body.textContent).toContain('project files were not re-synced');
  expect(button('Undo merge')).toBeUndefined();
  await click('Retry');
  expect(h.post).toHaveBeenCalledWith('/tasks/task/merges/resync', {
    dir: payload.dir,
    baseShaAfter: payload.baseShaAfter,
  });
  expect(button('Retry')).toBeDefined();
  h.events = [...h.events, { eventType: 'merge.left_committed_resynced', payload }];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(button('Retry')).toBeUndefined();
  expect(document.body.textContent).not.toContain('project files were not re-synced');
});
it('shows a failed Retry request and allows another press', async () => {
  oweResync();
  h.post.mockRejectedValueOnce(new Error('Queue unavailable'));
  await render();
  await click('Retry');
  expect(document.body.textContent).toContain('Queue unavailable');
  await click('Retry');
  expect(h.post).toHaveBeenCalledTimes(2);
});
it('shows owed recovery to a viewer but reserves Retry for the owner', async () => {
  oweResync();
  h.viewer = 'other';
  await render();
  expect(document.body.textContent).toContain('project files were not re-synced');
  expect(button('Retry')).toBeUndefined();
});
it('never derives Retry from stale display copy after completion', async () => {
  oweResync();
  h.events[2]!.payload.reason = 'project files were not re-synced';
  h.events.push({ eventType: 'merge.left_committed_resynced', payload });
  await render();
  expect(button('Retry')).toBeUndefined();
});
