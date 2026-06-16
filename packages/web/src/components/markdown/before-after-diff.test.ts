import { describe, it, expect } from 'vitest';
import { buildDiffRows } from './before-after-diff';

describe('buildDiffRows', () => {
  it('keeps unchanged lines aligned on both sides', () => {
    const rows = buildDiffRows('a\nb\nc', 'a\nb\nc');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.left.kind === 'equal' && r.right.kind === 'equal')).toBe(true);
    expect(rows[1]?.left).toMatchObject({ kind: 'equal', num: 2, text: 'b' });
  });

  it('shows a modified line as remove (left) + add (right) on one row', () => {
    const rows = buildDiffRows('a\nb\nc', 'a\nB\nc');
    const changed = rows.find((r) => r.left.kind === 'remove');
    expect(changed).toBeDefined();
    expect(changed!.left).toMatchObject({ kind: 'remove', text: 'b' });
    expect(changed!.right).toMatchObject({ kind: 'add', text: 'B' });
  });

  it('pads the left with an empty cell for a pure addition', () => {
    const rows = buildDiffRows('a\nc', 'a\nb\nc');
    const added = rows.find((r) => r.right.kind === 'add');
    expect(added).toBeDefined();
    expect(added!.left.kind).toBe('empty');
    expect(added!.right).toMatchObject({ kind: 'add', text: 'b' });
  });

  it('pads the shorter side of an uneven modification', () => {
    // 1 line removed, 2 added -> 2 rows; the extra added line is padded on the left.
    const rows = buildDiffRows('x\n', 'y\nz\n');
    expect(rows.filter((r) => r.left.kind === 'remove')).toHaveLength(1);
    expect(rows.filter((r) => r.right.kind === 'add')).toHaveLength(2);
    expect(rows.some((r) => r.left.kind === 'empty' && r.right.kind === 'add')).toBe(true);
  });
});
