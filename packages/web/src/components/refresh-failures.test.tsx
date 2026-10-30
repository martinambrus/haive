import { describe, expect, it } from 'vitest';
import type { RefreshCliVersionsJobResult } from '@haive/shared/constants';
import { createRenderer, findAll, textOf } from '../../test/render-tree';
import { groupRefreshFailures, RefreshFailures } from './refresh-failures';

const refreshed = [{ name: 'claude-code', count: 3, latest: '1.2.3' }];
const errors = [
  { name: 'price:codex', error: 'litellm HTTP 503' },
  { name: 'fx', error: 'fx feed unreachable' },
  { name: 'price:gemini', error: 'litellm HTTP 503' },
];

const draw = (result: RefreshCliVersionsJobResult | null | undefined) =>
  createRenderer(() => <RefreshFailures result={result} />).tree();
const alertsIn = (tree: ReturnType<typeof draw>) =>
  findAll(tree, (host) => host.props.role === 'alert');

describe('groupRefreshFailures', () => {
  it('merges sources that share a reason and keeps first-seen order', () => {
    expect(
      groupRefreshFailures([
        ...errors,
        { name: 'chrome', error: 'registry timed out' },
        { name: 'price:claude-code', error: 'litellm HTTP 503' },
      ]),
    ).toEqual([
      { names: ['price:codex', 'price:gemini', 'price:claude-code'], error: 'litellm HTTP 503' },
      { names: ['fx'], error: 'fx feed unreachable' },
      { names: ['chrome'], error: 'registry timed out' },
    ]);
  });

  it('keeps reasons that are not identical apart', () => {
    expect(
      groupRefreshFailures([
        { name: 'chrome', error: 'HTTP 503' },
        { name: 'edge', error: 'HTTP 504' },
      ]),
    ).toEqual([
      { names: ['chrome'], error: 'HTTP 503' },
      { names: ['edge'], error: 'HTTP 504' },
    ]);
  });

  it('has no group for no errors', () => {
    expect(groupRefreshFailures([])).toEqual([]);
  });
});

describe('RefreshFailures', () => {
  it.each<[string, RefreshCliVersionsJobResult | null | undefined]>([
    ['no result', null],
    ['a result the server did not send', undefined],
    ['a clean result', { ok: true, refreshed, errors: [] }],
    ['a clean result that still lists errors', { ok: true, refreshed, errors }],
  ])('renders nothing for %s', (_label, result) => {
    expect(draw(result).kids).toHaveLength(0);
  });

  it('renders one alert with a line per reason: the sources, then the reason', () => {
    const alerts = alertsIn(draw({ ok: false, refreshed, errors }));

    expect(alerts).toHaveLength(1);
    const items = findAll(alerts[0]!, (host) => host.tag === 'li');
    expect(items.map((item) => textOf(item))).toEqual([
      expect.stringContaining('litellm HTTP 503'),
      expect.stringContaining('fx feed unreachable'),
    ]);
    expect(textOf(items[0]!)).not.toContain('fx');
    expect(textOf(alerts[0]!).split('litellm HTTP 503')).toHaveLength(2);
    // A long URL in a reason has to wrap instead of widening a 375px page.
    for (const item of items) expect(String(item.props.className)).toContain('break-words');
    const names = findAll(alerts[0]!, (host) => String(host.props.className).includes('font-mono'));
    expect(names.map((name) => textOf(name))).toEqual(['price:codex, price:gemini', 'fx']);
  });

  it('reads the verdict from ok, so a failed job that lists nothing is still shown', () => {
    expect(alertsIn(draw({ ok: false, refreshed, errors: [] }))).toHaveLength(1);
  });
});
