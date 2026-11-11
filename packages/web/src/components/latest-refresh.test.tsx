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
