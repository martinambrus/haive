import { describe, expect, it } from 'vitest';
import { buildChangeMarkers, buildDiffRows, inlineMarkerRows } from './commit-diff.js';

describe('commit diff text highlights', () => {
  it('highlights an uncommented setting and its updated value on both sides', () => {
    const before = "// $settings['config_sync_directory'] = '/some/other/path';\n";
    const after = "$settings['config_sync_directory'] = '../config/sync';\n";
    const { inlineRows, splitRows } = buildDiffRows(before, after);
    expect(inlineRows.map((r) => r.kind)).toEqual(['remove', 'add']);
    for (const row of inlineRows) {
      expect(row.cell.spans?.map((s) => s.text).join('')).toBe(row.cell.text);
      expect(
        row.cell.spans
          ?.filter((s) => !s.changed)
          .map((s) => s.text)
          .join(''),
      ).toContain("$settings['config_sync_directory'] = '");
    }
    expect(
      splitRows[0]?.left?.spans
        ?.filter((s) => s.changed)
        .map((s) => s.text)
        .join(''),
    ).toContain('//');
    expect(
      splitRows[0]?.right?.spans
        ?.filter((s) => s.changed)
        .map((s) => s.text)
        .join(''),
    ).toContain('config');
    expect(
      splitRows[0]?.right?.spans
        ?.filter((s) => s.changed)
        .map((s) => s.text)
        .join(''),
    ).toContain('sync');
  });

  it('keeps matching text when a comment is inserted before a modified line', () => {
    const { inlineRows } = buildDiffRows(
      'const value = 1;\n',
      '// explanation\nconst value = 2;\n',
    );
    const added = inlineRows.filter((r) => r.kind === 'add');
    expect(added.map((r) => r.cell.spans?.map((s) => s.text).join(''))).toEqual([
      '// explanation',
      'const value = 2;',
    ]);
    expect(
      added[1]?.cell.spans
        ?.filter((s) => s.changed)
        .map((s) => s.text)
        .join(''),
    ).toBe('2');
  });

  it('preserves whitespace, blank lines, CRLF, Unicode and a missing final newline', () => {
    const before = 'unchanged\r\n\tconst label = "Žltý 🌻";\r\n\r\nlast';
    const after = 'unchanged\r\n  const label = "Modrý 🌻";\r\n\r\nlast';
    const { inlineRows } = buildDiffRows(before, after);
    for (const side of ['oldNo', 'newNo'] as const) {
      const cells = inlineRows.filter((r) => r[side] !== null).map((r) => r.cell);
      expect(cells.map((c) => c.no)).toEqual([1, 2, 3, 4]);
      expect(cells.map((c) => c.spans?.map((s) => s.text).join('') ?? c.text).join('\n')).toBe(
        side === 'oldNo' ? before : after,
      );
    }
  });

  it('handles added, deleted, empty and identical files without inventing lines', () => {
    expect(buildDiffRows('', '').inlineRows).toEqual([]);
    expect(buildDiffRows('same\n', 'same\n').inlineRows.map((r) => r.kind)).toEqual(['context']);
    expect(buildDiffRows('', '\nnew\n').splitRows.map((r) => [r.left, r.right?.text])).toEqual([
      [null, ''],
      [null, 'new'],
    ]);
    expect(buildDiffRows('old\n\n', '').inlineRows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['remove', 1, null],
      ['remove', 2, null],
    ]);
  });

  it('falls back to line colours for oversized replacements', () => {
    const { inlineRows } = buildDiffRows('a'.repeat(60_000), 'b'.repeat(60_000));
    expect(inlineRows.map((r) => r.kind)).toEqual(['remove', 'add']);
    expect(inlineRows.every((r) => r.cell.spans === undefined)).toBe(true);
  });
});

describe('commit diff change map', () => {
  it('groups adjacent changed lines and retains both colours for replacements', () => {
    const { inlineRows, splitRows } = buildDiffRows(
      'same\none\ntwo\nstable\nremoved\n',
      'same\nthree\nfour\nstable\n',
    );
    expect(buildChangeMarkers(splitRows)).toEqual([
      { kind: 'remove', start: 1, end: 2, firstLine: 2, lastLine: 3 },
      { kind: 'remove', start: 4, end: 4, firstLine: 5, lastLine: 5 },
      { kind: 'add', start: 1, end: 2, firstLine: 2, lastLine: 3 },
    ]);
    expect(buildChangeMarkers(inlineMarkerRows(inlineRows))).toEqual([
      { kind: 'remove', start: 1, end: 2, firstLine: 2, lastLine: 3 },
      { kind: 'remove', start: 6, end: 6, firstLine: 5, lastLine: 5 },
      { kind: 'add', start: 3, end: 4, firstLine: 2, lastLine: 3 },
    ]);
  });
});
