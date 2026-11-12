// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LatestRefreshRun, RefreshCliVersionsJobResult } from '@haive/shared/constants';
import { LatestRefresh } from './latest-refresh';
import { createRenderer, textOf } from '../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: h }));
const result = {
  ok: false,
  refreshed: [],
  errors: [{ name: 'fx', error: 'current failure' }],
  runId: 'current',
  startedAt: '2026-11-11T12:00:00Z',
};
const stored = (overrides: Partial<LatestRefreshRun> = {}): LatestRefreshRun => ({
  kind: 'versions',
  runId: 'current',
  trigger: 'manual',
  startedAt: result.startedAt,
  finishedAt: null,
  result: null,
  ...overrides,
});
beforeEach(() => {
  vi.useFakeTimers();
  h.get.mockReset();
});
afterEach(() => vi.useRealTimers());
const settle = async (view: ReturnType<typeof createRenderer>) => {
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
};

it.each([
  ['its own unfinished row', stored()],
  [
    'an older completed run',
    stored({
      runId: 'older',
      startedAt: '2026-11-11T11:00:00Z',
      finishedAt: '2026-11-11T11:01:00Z',
      result: { ok: true, refreshed: [], errors: [] },
    }),
  ],
])('prefers the completed job result over %s even if the reread fails', async (_label, run) => {
  h.get.mockResolvedValueOnce({ run }).mockRejectedValue(new Error('offline'));
  let active = true;
  let completed: RefreshCliVersionsJobResult | null = null;
  const view = createRenderer(() => (
    <LatestRefresh endpoint="/latest" active={active} result={completed} />
  ));
  await settle(view);
  active = false;
  completed = result;
  view.draw();
  await settle(view);
  expect(textOf(view.tree())).toContain('current failure');
  expect(textOf(view.tree())).not.toContain('has not finished');
});
it('lets a structurally newer stored run supersede the previous manual result', async () => {
  h.get.mockResolvedValue({ run: stored({ runId: 'newer', startedAt: '2026-11-11T13:00:00Z' }) });
  const view = createRenderer(() => (
    <LatestRefresh endpoint="/latest" active={false} result={result} />
  ));
  await settle(view);
  expect(textOf(view.tree())).toContain('has not finished');
  expect(textOf(view.tree())).not.toContain('current failure');
});

it('keeps the stored run when a different completed result has no start time', async () => {
  h.get.mockResolvedValue({ run: stored({ runId: 'newer' }) });
  const view = createRenderer(() => (
    <LatestRefresh endpoint="/latest" active={false} result={{ ...result, startedAt: undefined }} />
  ));
  await settle(view);
  expect(textOf(view.tree())).toContain('has not finished');
  expect(textOf(view.tree())).not.toContain('current failure');
});

it('uses a completed result with no start time when its run id matches', async () => {
  h.get.mockResolvedValue({ run: stored() });
  const view = createRenderer(() => (
    <LatestRefresh endpoint="/latest" active={false} result={{ ...result, startedAt: undefined }} />
  ));
  await settle(view);
  expect(textOf(view.tree())).toContain('current failure');
  expect(textOf(view.tree())).not.toContain('has not finished');
});

it.each(['unknown', 'legacy-trigger'])(
  'describes a %s trigger plainly with readable dates',
  async (trigger) => {
    h.get.mockResolvedValue({
      run: stored({
        trigger: trigger as LatestRefreshRun['trigger'],
        finishedAt: '2026-11-11T12:01:00Z',
        result: { ok: true, refreshed: [], errors: [] },
      }),
    });
    const view = createRenderer(() => (
      <LatestRefresh endpoint="/latest" active={false} result={null} />
    ));
    await settle(view);
    const text = textOf(view.tree());
    expect(text).toContain('The latest refresh finished at');
    expect(text).not.toContain(trigger);
    expect(text).not.toContain('2026-11-11T12:01:00Z');
    expect(text).toContain(new Date('2026-11-11T12:01:00Z').toLocaleString());
  },
);
it.each([true, false])('reports structurally skipped prices when ok=%s', async (ok) => {
  h.get.mockResolvedValue({
    run: stored({
      finishedAt: '2026-11-11T12:01:00Z',
      result: { ok, refreshed: [], errors: [], skipped: ['prices'] },
    }),
  });
  const view = createRenderer(() => (
    <LatestRefresh endpoint="/latest" active={false} result={null} />
  ));
  await settle(view);
  expect(textOf(view.tree())).toContain('Skipped: prices');
  expect(textOf(view.tree())).not.toContain('All sources refreshed successfully');
});
it('also reports skipped prices in the just-completed job result', () => {
  h.get.mockResolvedValue({ run: null });
  const completed = { ok: true, refreshed: [], errors: [], skipped: ['prices'] };
  const view = createRenderer(() => (
    <LatestRefresh endpoint="/latest" active={false} result={completed} />
  ));
  expect(textOf(view.tree())).toContain('Skipped: prices');
  expect(textOf(view.tree())).not.toContain('All sources refreshed successfully');
});

it('clears the scheduled poll and aborts its request on unmount', async () => {
  h.get.mockResolvedValue({ run: null });
  let mounted = true;
  const view = createRenderer(() =>
    mounted ? <LatestRefresh endpoint="/latest" active={false} result={null} /> : null,
  );
  await settle(view);
  const signal = h.get.mock.calls[0]![1] as AbortSignal;
  expect(vi.getTimerCount()).toBe(1);
  mounted = false;
  view.draw();
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get).toHaveBeenCalledOnce();
});
it('does not restart polling when an in-flight read resolves after unmount', async () => {
  let release!: (value: { run: null }) => void;
  h.get.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let mounted = true;
  const view = createRenderer(() =>
    mounted ? <LatestRefresh endpoint="/latest" active={false} result={null} /> : null,
  );
  mounted = false;
  view.draw();
  expect((h.get.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  release({ run: null });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('keeps one 10-second poll chain across active changes and repeated renders', async () => {
  h.get.mockResolvedValue({ run: null });
  let active = false;
  const view = createRenderer(() => (
    <LatestRefresh endpoint="/latest" active={active} result={null} />
  ));
  await settle(view);
  for (const next of [true, false, true, false]) {
    active = next;
    view.draw();
    await settle(view);
    view.draw();
    expect(vi.getTimerCount()).toBe(1);
  }
  expect(h.get).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get).toHaveBeenCalledTimes(8);
  expect(vi.getTimerCount()).toBe(1);
});
it('waits for a slow read to settle before scheduling another poll', async () => {
  let release!: (value: { run: null }) => void;
  h.get
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ run: null });
  createRenderer(() => <LatestRefresh endpoint="/latest" active={false} result={null} />);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.get).toHaveBeenCalledOnce();
  release({ run: null });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(h.get).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.get).toHaveBeenCalledTimes(2);
});
it('shows a load error and clears it after a successful retry', async () => {
  h.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ run: null });
  const view = createRenderer(() => (
    <LatestRefresh endpoint="/latest" active={false} result={null} />
  ));
  await settle(view);
  expect(textOf(view.tree())).toContain('Unable to load');
  await vi.advanceTimersByTimeAsync(10_000);
  view.draw();
  expect(textOf(view.tree())).not.toContain('Unable to load');
  expect(h.get).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
});
it('ignores an aborted old endpoint response and keeps one poll for the new endpoint', async () => {
  let release!: (value: { run: LatestRefreshRun }) => void;
  h.get
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ run: null });
  let endpoint = '/old';
  const view = createRenderer(() => (
    <LatestRefresh endpoint={endpoint} active={false} result={null} />
  ));
  endpoint = '/new';
  view.draw();
  await settle(view);
  release({ run: stored() });
  await settle(view);
  expect(textOf(view.tree())).not.toContain('has not finished');
  expect((h.get.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.get.mock.calls.map(([path]) => path)).toEqual(['/old', '/new', '/new']);
});
