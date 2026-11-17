// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { RefreshCliVersionsJobResult } from '@haive/shared/constants';
import PricingPage from './page';
import {
  buttons,
  controls,
  createRenderer,
  findAll,
  fire,
  isDisabled,
  textOf,
} from '../../../../../test/render-tree';
import { POLL_TIMEOUT_MS } from '@/lib/cli-jobs';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', () => ({
  default: (props: Record<string, unknown>) => createElement('a', props),
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
    if (path === '/cli-pricing/refresh/latest') return { run: null };
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

const alerts = (view: ReturnType<typeof createRenderer>) =>
  findAll(view.tree(), (host) => host.props.role === 'alert');

const PARTIAL: RefreshCliVersionsJobResult = {
  ok: false,
  refreshed: [{ name: 'claude-code', count: 3, latest: '1.2.3' }],
  errors: [
    { name: 'fx', error: 'fx feed unreachable' },
    { name: 'price:codex', error: 'litellm HTTP 503' },
    { name: 'price:gemini', error: 'litellm HTTP 503' },
  ],
};

describe('stored refresh result', () => {
  it.each(['scheduled', 'manual'])(
    'shows unsupported prices from a %s result without calling them failures',
    async (mode) => {
      const result = {
        ok: true,
        refreshed: [],
        errors: [],
        unsupported: [
          { model: 'timed-model', reason: 'time-window' },
          { model: 'variable-model', reason: 'variable-price' },
        ],
      };
      let view: ReturnType<typeof createRenderer>;
      if (mode === 'scheduled') {
        const original = h.get.getMockImplementation()!;
        h.get.mockImplementation((path: string) =>
          path === '/cli-pricing/refresh/latest'
            ? Promise.resolve({
                run: {
                  startedAt: '2026-11-01T00:00:00Z',
                  finishedAt: '2026-11-01T00:01:00Z',
                  trigger: 'scheduled',
                  result,
                },
              })
            : original(path),
        );
        view = createRenderer(() => createElement(PricingPage));
        await settle(view);
      } else {
        view = await start();
        status = { status: 'done', result };
        await vi.advanceTimersByTimeAsync(2000);
        view.draw();
      }
      const text = textOf(view.tree());
      for (const expected of ['timed-model', 'time-window', 'variable-model', 'variable-price'])
        expect(text).toContain(expected);
      expect(alerts(view)).toHaveLength(0);
      expect(
        findAll(
          view.tree(),
          (node) =>
            typeof node.props.className === 'string' &&
            node.props.className.includes('text-indigo-300'),
        ),
      ).not.toHaveLength(0);
    },
  );
  it('shows a scheduled failure on page load without starting a job', async () => {
    h.get.mockImplementation(async (path: string) =>
      path === '/cli-pricing/refresh/latest'
        ? {
            run: {
              startedAt: '2026-11-01T00:00:00Z',
              finishedAt: '2026-11-01T00:01:00Z',
              trigger: 'scheduled',
              result: PARTIAL,
            },
          }
        : { currencies: [], feeds: [], providers: [], prices: [] },
    );
    const view = createRenderer(() => createElement(PricingPage));
    await settle(view);
    expect(textOf(view.tree())).toContain('fx feed unreachable');
    expect(textOf(view.tree())).toContain('scheduled');
    expect(h.post).not.toHaveBeenCalled();
  });
  it('shows an unfinished run using its timestamps even if a stale success result exists', async () => {
    h.get.mockImplementation(async (path: string) =>
      path === '/cli-pricing/refresh/latest'
        ? {
            run: {
              startedAt: '2026-11-01T00:00:00Z',
              finishedAt: null,
              trigger: 'boot',
              result: { ok: true, refreshed: [], errors: [] },
            },
          }
        : { currencies: [], feeds: [], providers: [], prices: [] },
    );
    const view = createRenderer(() => createElement(PricingPage));
    await settle(view);
    expect(textOf(view.tree())).toContain('has not finished');
  });
  it('shows a later stored failure after the manual poll window ends', async () => {
    const original = h.get.getMockImplementation()!;
    let run: unknown = null;
    h.get.mockImplementation((path: string) =>
      path === '/cli-pricing/refresh/latest' ? Promise.resolve({ run }) : original(path),
    );
    const view = await start();
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    view.draw();
    expect(textOf(view.tree())).toContain('The latest refresh result is saved');
    run = {
      startedAt: '2026-11-01T00:00:00Z',
      finishedAt: '2026-11-01T00:01:00Z',
      trigger: 'manual',
      result: PARTIAL,
    };
    await vi.advanceTimersByTimeAsync(10_000);
    view.draw();
    expect(textOf(view.tree())).toContain('fx feed unreachable');
  });
});

describe('pricing refresh result', () => {
  it('names each failed source with its reason once, and still reloads the table', async () => {
    const view = await start();
    status = { status: 'done', result: PARTIAL };
    await vi.advanceTimersByTimeAsync(2000);
    view.draw();

    const shown = alerts(view);
    expect(shown).toHaveLength(1);
    const text = textOf(shown[0]!);
    const reasons = ['fx feed unreachable', 'litellm HTTP 503'];
    // A name must be shown on its own: "fx" alone would also match inside its reason.
    const withoutReasons = reasons.reduce((rest, reason) => rest.replaceAll(reason, ''), text);
    for (const name of ['fx', 'price:codex', 'price:gemini'])
      expect(withoutReasons).toContain(name);
    for (const reason of reasons) expect(text).toContain(reason);
    expect(text.split('litellm HTTP 503')).toHaveLength(2);
    expect(findAll(shown[0]!, (host) => host.tag === 'li')).toHaveLength(2);

    expect(loads).toBe(2);
    expect(isDisabled(buttons(view.tree(), /^refresh now$/i)[0]!)).toBe(false);
  });

  it('shows no notice when every source refreshed', async () => {
    const view = await start();
    status = { status: 'done', result: { ok: true, refreshed: PARTIAL.refreshed, errors: [] } };
    await vi.advanceTimersByTimeAsync(2000);
    view.draw();

    expect(loads).toBe(2);
    expect(alerts(view)).toHaveLength(0);
  });

  it('removes the earlier notice while another refresh is queued', async () => {
    const view = await start();
    status = { status: 'done', result: PARTIAL };
    await vi.advanceTimersByTimeAsync(2000);
    view.draw();
    expect(alerts(view)).toHaveLength(1);

    status = { status: 'pending', state: 'waiting' };
    fire.click(buttons(view.tree(), /^refresh now$/i)[0]!);
    await settle(view);

    expect(buttons(view.tree(), /queued/i)).toHaveLength(1);
    expect(alerts(view)).toHaveLength(0);
  });
});

it('lists complete prompt tiers below base rates and preserves them when replacing base rates', async () => {
  const rates = {
    inputRate: 1e-6,
    outputRate: 2e-6,
    cacheReadRate: null,
    cacheWriteRate: null,
    cacheWrite1hRate: null,
  };
  const tiers = [
    { ...rates, aboveTokens: 100000, inclusive: false, inputRate: 5e-6, cacheWrite1hRate: 8e-6 },
  ];
  const original = h.get.getMockImplementation()!;
  h.get.mockImplementation((path: string) =>
    path === '/cli-pricing'
      ? Promise.resolve({
          currencies: [],
          feeds: [],
          providers: [],
          prices: [
            {
              id: 'x',
              provider: null,
              modelKey: 'tiered',
              source: 'manual',
              rates: { ...rates, tiers },
              currency: 'USD',
              note: null,
              effectiveFrom: '2026-11-01T00:00:00Z',
            },
          ],
        })
      : original(path),
  );
  const view = createRenderer(() => createElement(PricingPage));
  await settle(view);
  expect(textOf(view.tree())).toContain('Prompt > 100,000 tokens');
  expect(textOf(view.tree())).toContain('$5.00');
  expect(textOf(view.tree())).toContain('$8.00');
  fire.type(controls(view.tree(), 'model')[0]!, 'tiered');
  view.draw();
  fire.click(buttons(view.tree(), /^save rate$/i)[0]!);
  await settle(view);
  expect(h.post).toHaveBeenCalledWith(
    '/cli-pricing/prices',
    expect.objectContaining({ rates: expect.objectContaining({ tiers }) }),
  );
});

it('edits complete manual tiers and retains an empty 1h write rate as unknown', async () => {
  const view = createRenderer(() => createElement(PricingPage));
  await settle(view);
  fire.type(controls(view.tree(), 'model')[0]!, 'new-model');
  view.draw();
  fire.type(controls(view.tree(), 'input /m')[0]!, '1');
  view.draw();
  fire.click(buttons(view.tree(), /^add prompt tier$/i)[0]!);
  view.draw();
  fire.type(controls(view.tree(), 'prompt threshold')[0]!, '100000');
  view.draw();
  fire.type(controls(view.tree(), 'tier 1 input /m')[0]!, '5');
  view.draw();
  fire.type(controls(view.tree(), 'tier 1 output /m')[0]!, '25');
  view.draw();
  fire.click(buttons(view.tree(), /^save rate$/i)[0]!);
  await settle(view);
  expect(h.post).toHaveBeenCalledWith(
    '/cli-pricing/prices',
    expect.objectContaining({
      rates: expect.objectContaining({
        tiers: [
          {
            aboveTokens: 100000,
            inclusive: false,
            inputRate: 5e-6,
            outputRate: 25e-6,
            cacheReadRate: null,
            cacheWriteRate: null,
            cacheWrite1hRate: null,
          },
        ],
      }),
    }),
  );
});
it.each(['negative', 'descending'] as const)(
  'refuses %s manual pricing edits before saving',
  async (bad) => {
    const view = createRenderer(() => createElement(PricingPage));
    await settle(view);
    fire.type(controls(view.tree(), 'model')[0]!, 'new-model');
    view.draw();
    fire.type(controls(view.tree(), 'input /m')[0]!, bad === 'negative' ? '-1' : '1');
    view.draw();
    if (bad === 'descending') {
      for (const threshold of ['100000', '50000']) {
        fire.click(buttons(view.tree(), /^add prompt tier$/i)[0]!);
        view.draw();
        const all = controls(view.tree(), 'prompt threshold');
        fire.type(all[all.length - 1]!, threshold);
        view.draw();
      }
    }
    fire.click(buttons(view.tree(), /^save rate$/i)[0]!);
    await settle(view);
    expect(h.post).not.toHaveBeenCalled();
    expect(textOf(view.tree())).toContain(bad === 'negative' ? 'non-negative' : 'ascending');
  },
);
it('shows individual unknown-tier ranges and unpriced missing bounds on the admin page', async () => {
  const original = h.get.getMockImplementation()!;
  h.get.mockImplementation((path: string) =>
    path === '/cli-pricing'
      ? Promise.resolve({
          currencies: [],
          feeds: [],
          providers: [],
          prices: [],
          unknownTierInvocations: [
            { id: 'a', modelKey: 'model-a', tier: { lowUsd: 1, highUsd: 5 } },
            { id: 'b', modelKey: 'model-b', tier: {} },
          ],
        })
      : original(path),
  );
  const view = createRenderer(() => createElement(PricingPage));
  await settle(view);
  expect(textOf(view.tree())).toContain('prompt tier unknown · $1.00–$5.00');
  expect(textOf(view.tree())).toContain('prompt tier unknown · unpriced');
});

it('prefills small rates without floating point tails and warns that tier-only overrides shadow base prices', async () => {
  const rates = {
    inputRate: 1e-7,
    outputRate: 2e-7,
    cacheReadRate: 5e-8,
    cacheWriteRate: null,
    cacheWrite1hRate: null,
  };
  const original = h.get.getMockImplementation()!;
  h.get.mockImplementation((path: string) =>
    path === '/cli-pricing'
      ? Promise.resolve({
          currencies: [],
          feeds: [],
          providers: [],
          prices: [
            {
              id: 'x',
              provider: null,
              modelKey: 'tiered',
              source: 'manual',
              rates: { ...rates, tiers: [{ ...rates, aboveTokens: 100000, inclusive: false }] },
              currency: 'USD',
              note: null,
              effectiveFrom: '2026-11-01T00:00:00Z',
            },
          ],
        })
      : original(path),
  );
  const view = createRenderer(() => createElement(PricingPage));
  await settle(view);
  fire.click(buttons(view.tree(), /^edit$/i)[0]!);
  view.draw();
  for (const [label, expected] of [
    ['input /m', '0.1'],
    ['output /m', '0.2'],
    ['cache read /m', '0.05'],
  ])
    expect(controls(view.tree(), label!)[0]!.props.value).toBe(expected);
  fire.click(buttons(view.tree(), /^save rate$/i)[0]!);
  await settle(view);
  expect(h.post).toHaveBeenCalledWith(
    '/cli-pricing/prices',
    expect.objectContaining({
      rates: expect.objectContaining({ ...rates, tiers: [expect.objectContaining(rates)] }),
    }),
  );
  fire.click(buttons(view.tree(), /^edit$/i)[0]!);
  view.draw();
  expect(textOf(view.tree())).not.toContain('All base rates are empty.');
  for (const label of [
    'input /m',
    'output /m',
    'cache read /m',
    'cache write /m',
    'cache write 1h /m',
  ]) {
    fire.type(controls(view.tree(), label)[0]!, '');
    view.draw();
  }
  expect(textOf(view.tree())).toContain(
    'This manual rate overrides the feed, so requests below the first tier will be unpriced.',
  );
});

it('links each visible short invocation id to its task with an accessible full-id label', async () => {
  const id = '12345678-abcd-4321-9876-123456789abc';
  const other = '87654321-abcd-4321-9876-123456789abc';
  const original = h.get.getMockImplementation()!;
  h.get.mockImplementation((path: string) =>
    path === '/cli-pricing'
      ? Promise.resolve({
          currencies: [],
          feeds: [],
          providers: [],
          prices: [],
          unknownTierInvocations: [
            { id, taskId: 'task-a', modelKey: 'same-model', tier: { lowUsd: 1, highUsd: 5 } },
            { id: other, taskId: 'task-b', modelKey: 'same-model', tier: {} },
          ],
        })
      : original(path),
  );
  const view = createRenderer(() => createElement(PricingPage));
  await settle(view);
  for (const [invocation, task] of [
    [id, 'task-a'],
    [other, 'task-b'],
  ]) {
    const links = findAll(
      view.tree(),
      (host) => host.tag === 'a' && host.props.href === `/tasks/${task}`,
    );
    expect(links).toHaveLength(1);
    expect(textOf(links[0]!)).toBe(invocation!.slice(0, 8));
    expect(links[0]!.props['aria-label']).toBe(`View task for invocation ${invocation}`);
  }
});
