import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import PricingPage from './page';
import {
  buttons,
  controls,
  createRenderer,
  fire,
  isDisabled,
  textOf,
} from '../../../../../test/render-tree';
import { POLL_TIMEOUT_MS } from '@/lib/cli-jobs';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: h }));

let status: Record<string, unknown>;
let loads: number;
let mounted: boolean;
const JOB = 'repeat:cli-refresh-versions-repeatable:1792800000000';
const JOB_PATH = `/cli-pricing/refresh/${JOB}`;

beforeEach(() => {
  vi.useFakeTimers();
  loads = 0;
  mounted = true;
  status = { status: 'pending', state: 'waiting', message: 'completed' };
  h.post.mockReset().mockResolvedValue({ jobId: JOB });
  h.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/cli-pricing') {
      loads++;
      return { currencies: [], feeds: [], providers: [], prices: [] };
    }
    if (path === JOB_PATH) return status;
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(() => vi.useRealTimers());

async function settle(view: ReturnType<typeof createRenderer>) {
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
}
async function start() {
  const view = createRenderer(() => (mounted ? createElement(PricingPage) : null));
  await settle(view);
  fire.click(buttons(view.tree(), /^refresh now$/i)[0]!);
  await settle(view);
  return view;
}

describe('pricing refresh job', () => {
  it('stops polling on unmount without loading the completed result', async () => {
    const view = await start();
    const polls = h.get.mock.calls.filter(([path]) => path === JOB_PATH).length;
    mounted = false;
    view.draw();
    status = { status: 'done' };
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    expect(h.get.mock.calls.filter(([path]) => path === JOB_PATH)).toHaveLength(polls);
    expect(loads).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps Save rate enabled while the refresh is queued and running', async () => {
    const view = await start();
    fire.type(controls(view.tree(), 'model')[0]!, 'test-model');
    view.draw();
    expect(isDisabled(buttons(view.tree(), /^save rate$/i)[0]!)).toBe(false);
    status = { status: 'pending', state: 'active' };
    await vi.advanceTimersByTimeAsync(2000);
    view.draw();
    expect(isDisabled(buttons(view.tree(), /^save rate$/i)[0]!)).toBe(false);
  });

  it('waits through a long queue and running job, then reloads exactly on completion', async () => {
    const view = await start();
    expect(buttons(view.tree(), /queued/i)).toHaveLength(1);
    expect(isDisabled(buttons(view.tree(), /queued/i)[0]!)).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    view.draw();
    expect(loads).toBe(1);
    expect(h.get).toHaveBeenCalledWith(JOB_PATH, expect.any(AbortSignal));

    status = { status: 'pending', state: 'active', message: 'failed' };
    await vi.advanceTimersByTimeAsync(2000);
    view.draw();
    expect(isDisabled(buttons(view.tree(), /refreshing/i)[0]!)).toBe(true);
    expect(loads).toBe(1);

    status = { status: 'done', result: { ok: true, refreshed: [], errors: [] } };
    await vi.advanceTimersByTimeAsync(2000);
    view.draw();
    expect(loads).toBe(2);
    expect(isDisabled(buttons(view.tree(), /^refresh now$/i)[0]!)).toBe(false);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('shows the job failure and enables retry without reloading stale prices', async () => {
    const view = await start();
    status = { status: 'failed', error: 'pricing refresh worker crashed' };
    await vi.advanceTimersByTimeAsync(2000);
    view.draw();
    expect(textOf(view.tree())).toContain('pricing refresh worker crashed');
    expect(loads).toBe(1);
    expect(isDisabled(buttons(view.tree(), /^refresh now$/i)[0]!)).toBe(false);
  });

  it('shows the poll timeout and enables retry', async () => {
    const view = await start();
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    view.draw();
    expect(textOf(view.tree())).toContain('Still queued behind running CLI jobs');
    expect(loads).toBe(1);
    expect(isDisabled(buttons(view.tree(), /^refresh now$/i)[0]!)).toBe(false);
  });

  it('shows a structured expired-job response', async () => {
    h.get.mockImplementation(async (path: string) => {
      if (path === JOB_PATH)
        throw Object.assign(new Error('job expired'), { code: 'job_expired', status: 404 });
      loads++;
      return { currencies: [], feeds: [], providers: [], prices: [] };
    });
    const view = await start();
    expect(textOf(view.tree())).toContain('job expired');
    expect(isDisabled(buttons(view.tree(), /^refresh now$/i)[0]!)).toBe(false);
  });
});
