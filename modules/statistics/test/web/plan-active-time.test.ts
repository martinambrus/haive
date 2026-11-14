import { describe, expect, it } from 'vitest';
import { PlanActiveTimeTile } from '../../src/web/components/plan-active-time-tile.js';
import { StatTile } from '../../src/web/components/stat-tile.js';
import type { ReactElement, ReactNode } from 'react';

function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (typeof node !== 'object') return String(node);
  return text((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe('Plan page time tile', () => {
  it.each([
    { activeMs: 90_000, expected: '1m 30s' },
    { activeMs: null, expected: '—' },
    { activeMs: 0, expected: '0s' },
  ])('renders $activeMs as $expected', ({ activeMs, expected }) => {
    const tile = PlanActiveTimeTile({ activeMs });
    expect(tile.type).toBe(StatTile);
    const rendered = StatTile(tile.props);
    const copy = text(rendered);
    expect(copy).toContain('Plan page');
    expect(copy).toContain(expected);
    if (activeMs === null) expect(copy).not.toContain('0s');
    expect(copy).toContain('Activity window');
    expect(copy).toContain('all providers');
  });
});
