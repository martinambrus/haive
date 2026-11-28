import { describe, expect, it } from 'vitest';
import {
  buildFilesRead,
  FILES_READ_STEP_LIMIT,
  type FilesReadGroupRow,
  type FilesReadPathRow,
  type FilesReadRollup,
} from './files-read.js';

function group(over: Partial<FilesReadGroupRow> = {}): FilesReadGroupRow {
  return {
    stepId: '05-implement',
    provider: 'claude-code',
    runs: 0,
    inFlight: 0,
    recorded: 0,
    observable: 0,
    partial: 0,
    weighted: 0,
    fileReads: 0,
    fileChars: 0,
    weightedChars: 0,
    overflowOmitted: 0,
    overflowRuns: 0,
    overflowReads: 0,
    overflowChars: 0,
    overflowWeightedChars: 0,
    multiFileRuns: 0,
    multiFileReads: 0,
    multiFileChars: 0,
    multiFileWeightedChars: 0,
    shareRuns: 0,
    shareWeightedChars: 0,
    shareInputTokens: 0,
    shareOutputTokens: 0,
    shareCacheReadTokens: 0,
    shareCacheCreationTokens: 0,
    ...over,
  };
}

function row(path: string, over: Partial<FilesReadPathRow> = {}): FilesReadPathRow {
  return {
    path,
    reads: 1,
    chars: 100,
    weightedChars: 100,
    weightedRuns: 1,
    runs: 1,
    tasks: 1,
    ...over,
  };
}

function rollup(rows: FilesReadPathRow[], groups: FilesReadGroupRow[], count = rows.length) {
  return { paths: { rows, count }, groups } satisfies FilesReadRollup;
}

const weightedGroup = (w: number, over: Partial<FilesReadGroupRow> = {}) =>
  group({
    runs: w,
    recorded: w,
    observable: w,
    weighted: w,
    fileReads: 10,
    fileChars: 1000,
    weightedChars: 800,
    ...over,
  });

describe('buildFilesRead files ranking', () => {
  const rows = [
    row('b.ts', { weightedChars: null, chars: 500 }),
    row('a.ts', { weightedChars: 0, chars: 10 }),
    row('d.ts', { weightedChars: 300, chars: 50 }),
    row('c.ts', { weightedChars: 300, chars: 50 }),
    row('e.ts', { weightedChars: 300, chars: 90 }),
    row('Z.ts', { weightedChars: null, chars: 500 }),
  ];
  const groups = [weightedGroup(5)];

  it('ranks by weight with null last, then chars, then code-point path', () => {
    const out = buildFilesRead(rollup(rows, groups));
    expect(out.files.rows.map((r) => r.path)).toEqual([
      'e.ts',
      'c.ts',
      'd.ts',
      'a.ts',
      'Z.ts',
      'b.ts',
    ]);
  });

  it('does not depend on input order and does not mutate the input', () => {
    const input = rollup(rows, groups);
    const before = JSON.stringify(input);
    const a = buildFilesRead(input);
    expect(JSON.stringify(input)).toBe(before);
    const b = buildFilesRead(rollup([...rows].reverse(), [...groups].reverse()));
    expect(b).toEqual(a);
  });

  it('keeps a known zero weight ahead of an unknown one', () => {
    const out = buildFilesRead(rollup(rows, groups));
    const a = out.files.rows.find((r) => r.path === 'a.ts');
    const unknown = out.files.rows.find((r) => r.path === 'b.ts');
    expect(a?.estimatedTokens).toBe(0);
    expect(unknown?.estimatedTokens).toBeNull();
  });
});

describe('buildFilesRead estimates and shares', () => {
  const input = rollup(
    [
      row('a', { weightedChars: 400, chars: 400 }),
      row('b', { weightedChars: 240, chars: 300 }),
      row('c', { weightedChars: 160, chars: 200 }),
    ],
    [weightedGroup(6, { fileChars: 900, weightedChars: 800 })],
  );

  it('estimates tokens as weighted / 4 and shares as weighted / total weighted', () => {
    const out = buildFilesRead(input);
    expect(out.files.rows.map((r) => r.estimatedTokens)).toEqual([100, 60, 40]);
    expect(out.files.rows.map((r) => r.share.ratio)).toEqual([0.5, 0.3, 0.2]);
    expect(out.files.rows.every((r) => r.share.n === 6)).toBe(true);
    expect(out.totals.estimatedTokens).toBe(200);
  });

  it('reports count and truncation from the rollup count', () => {
    const out = buildFilesRead({ ...input, paths: { ...input.paths, count: 7 } });
    expect(out.files.count).toBe(7);
    expect(out.files.truncated).toBe(true);
    expect(buildFilesRead(input).files.truncated).toBe(false);
  });
});

describe('buildFilesRead unknown weight', () => {
  it('gives dashes, not zeros, when no run has a known weight', () => {
    const g = group({
      runs: 3,
      recorded: 3,
      observable: 3,
      partial: 3,
      weighted: 0,
      fileReads: 12,
      fileChars: 3400,
      overflowReads: 2,
      overflowChars: 20,
      multiFileReads: 1,
      multiFileChars: 10,
    });
    const out = buildFilesRead(rollup([row('a', { weightedChars: null, chars: 500 })], [g]));
    expect(out.totals).toEqual({ fileReads: 12, fileChars: 3400, estimatedTokens: null });
    expect(out.files.rows[0]?.estimatedTokens).toBeNull();
    expect(out.files.rows[0]?.share.ratio).toBeNull();
    for (const b of [out.otherPaths, out.overflow, out.multiFile]) {
      expect(b.estimatedTokens).toBeNull();
      expect(b.share.ratio).toBeNull();
    }
    expect(out.overflow.reads).toBe(2);
    expect(out.overflow.chars).toBe(20);
    expect(out.otherPaths.reads).toBe(12 - 1 - 2 - 1);
  });

  it('keeps a weighted run that read zero files as a known zero', () => {
    const g = group({ runs: 5, recorded: 5, observable: 5, weighted: 5 });
    const out = buildFilesRead(rollup([], [g]));
    expect(out.coverage.weighted).toBe(5);
    expect(out.totals.estimatedTokens).toBe(0);
    expect(out.totals.estimatedTokens).not.toBeNull();
    expect(out.overflow.estimatedTokens).toBe(0);
  });
});

describe('buildFilesRead sample counts', () => {
  const make = (w: number) =>
    buildFilesRead(rollup([row('a')], [weightedGroup(w, { weightedChars: 100 })]));

  it('is not sufficient at n = 4 on rows and buckets', () => {
    const out = make(4);
    for (const s of [
      out.files.rows[0]?.share,
      out.otherPaths.share,
      out.overflow.share,
      out.multiFile.share,
    ]) {
      expect(s?.n).toBe(4);
      expect(s?.sufficient).toBe(false);
    }
  });

  it('is sufficient at n = 5 on rows and buckets', () => {
    const out = make(5);
    for (const s of [
      out.files.rows[0]?.share,
      out.otherPaths.share,
      out.overflow.share,
      out.multiFile.share,
    ]) {
      expect(s?.n).toBe(5);
      expect(s?.sufficient).toBe(true);
    }
  });
});

describe('buildFilesRead share population', () => {
  it('counts only the weighted runs as n, not every observable run', () => {
    const out = buildFilesRead(
      rollup([row('a')], [weightedGroup(4, { runs: 9, recorded: 9, observable: 9, partial: 5 })]),
    );
    expect(out.coverage.observable).toBe(9);
    expect(out.files.rows[0]?.share).toMatchObject({ n: 4, sufficient: false });
    expect(out.overflow.share).toMatchObject({ n: 4, sufficient: false });
  });
});

describe('buildFilesRead buckets', () => {
  const input = rollup(
    [
      row('a', { reads: 30, chars: 300, weightedChars: 200 }),
      row('b', { reads: 20, chars: 200, weightedChars: 100 }),
      row('n', { reads: 4, chars: 40, weightedChars: null }),
    ],
    [
      weightedGroup(5, {
        stepId: 's1',
        fileReads: 60,
        fileChars: 600,
        weightedChars: 500,
        overflowOmitted: 4,
        overflowRuns: 2,
        overflowReads: 6,
        overflowChars: 60,
        overflowWeightedChars: 50,
        multiFileRuns: 1,
        multiFileReads: 3,
        multiFileChars: 30,
        multiFileWeightedChars: 20,
      }),
      weightedGroup(3, {
        stepId: 's2',
        provider: 'codex',
        fileReads: 40,
        fileChars: 400,
        weightedChars: 300,
        overflowOmitted: 1,
        overflowRuns: 1,
        overflowReads: 4,
        overflowChars: 40,
        overflowWeightedChars: 30,
        multiFileRuns: 2,
        multiFileReads: 2,
        multiFileChars: 20,
        multiFileWeightedChars: 10,
      }),
    ],
    9,
  );

  it('sums overflow and multi-file over groups', () => {
    const out = buildFilesRead(input);
    expect(out.overflow).toMatchObject({
      reads: 10,
      chars: 100,
      omitted: 5,
      runs: 3,
      estimatedTokens: 20,
    });
    expect(out.multiFile).toMatchObject({ reads: 5, chars: 50, runs: 3, estimatedTokens: 7.5 });
    expect(out.multiFile).not.toHaveProperty('omitted');
  });

  it('computes the other-paths remainder and partitions reads, chars and weighted chars', () => {
    const out = buildFilesRead(input);
    expect(out.otherPaths.paths).toBe(6);
    expect(out.otherPaths.reads).toBe(100 - 54 - 10 - 5);
    expect(out.otherPaths.chars).toBe(1000 - 540 - 100 - 50);
    expect(out.otherPaths.estimatedTokens).toBe((800 - 300 - 80 - 30) / 4);
    expect(out.otherPaths.share.ratio).toBeCloseTo((800 - 300 - 80 - 30) / 800);

    const sum = (f: (r: FilesReadPathRow) => number) =>
      out.files.rows.reduce((a, r) => a + f(r), 0);
    expect(
      sum((r) => r.reads) + out.otherPaths.reads + out.overflow.reads + out.multiFile.reads,
    ).toBe(out.totals.fileReads);
    expect(
      sum((r) => r.chars) + out.otherPaths.chars + out.overflow.chars + out.multiFile.chars,
    ).toBe(out.totals.fileChars);
    const w =
      sum((r) => r.weightedChars ?? 0) +
      (out.otherPaths.estimatedTokens ?? 0) * 4 +
      (out.overflow.estimatedTokens ?? 0) * 4 +
      (out.multiFile.estimatedTokens ?? 0) * 4;
    expect(w).toBe(800);
  });

  it('floors the remainder at zero and reports no extra paths when nothing is cut', () => {
    const out = buildFilesRead(
      rollup(
        [row('a', { reads: 50, chars: 500, weightedChars: 500 })],
        [weightedGroup(5, { fileReads: 10, fileChars: 100, weightedChars: 100 })],
      ),
    );
    expect(out.otherPaths).toMatchObject({ paths: 0, reads: 0, chars: 0, estimatedTokens: 0 });
  });
});

describe('buildFilesRead steps', () => {
  const step = (over: Partial<FilesReadGroupRow>) => weightedGroup(5, over);

  it('feeds only share runs and sums runs across providers', () => {
    const out = buildFilesRead(
      rollup(
        [],
        [
          step({
            stepId: 's',
            runs: 7,
            shareRuns: 5,
            shareWeightedChars: 400,
            shareInputTokens: 500,
            shareOutputTokens: 9,
            shareCacheReadTokens: 400,
            shareCacheCreationTokens: 100,
          }),
          step({
            stepId: 's',
            provider: null,
            runs: 4,
            shareRuns: 4,
            shareWeightedChars: 99999,
            shareInputTokens: 99999,
          }),
          step({ stepId: 's', provider: 'gemini', runs: 2, shareRuns: 0, shareWeightedChars: 77 }),
        ],
      ),
    );
    const s = out.steps.rows[0];
    expect(s?.runs).toBe(13);
    expect(s?.estimatedTokens).toBe(100);
    expect(s?.promptTokens).toBe(1000);
    expect(s?.share).toEqual({ ratio: 0.1, n: 5, sufficient: true });
    expect(s?.exceedsPrompt).toBe(false);
  });

  it('normalises a codex group: input includes cache reads', () => {
    const out = buildFilesRead(
      rollup(
        [],
        [
          step({
            provider: 'codex',
            shareRuns: 5,
            shareWeightedChars: 400,
            shareInputTokens: 1000,
            shareCacheReadTokens: 600,
            shareCacheCreationTokens: 50,
          }),
        ],
      ),
    );
    expect(out.steps.rows[0]?.promptTokens).toBe(1050);
  });

  it('shows a null step when no run feeds the share', () => {
    const out = buildFilesRead(
      rollup([], [step({ provider: null, runs: 3, shareRuns: 3, shareWeightedChars: 40 })]),
    );
    expect(out.steps.rows[0]).toEqual({
      stepId: '05-implement',
      runs: 3,
      estimatedTokens: null,
      promptTokens: null,
      share: { ratio: null, n: 0, sufficient: false },
      exceedsPrompt: false,
    });
  });

  it('flags a ratio above 1 and does not clamp it', () => {
    const out = buildFilesRead(
      rollup([], [step({ shareRuns: 5, shareWeightedChars: 4000, shareInputTokens: 500 })]),
    );
    expect(out.steps.rows[0]?.share.ratio).toBe(2);
    expect(out.steps.rows[0]?.exceedsPrompt).toBe(true);
  });

  it('gives a null ratio when the prompt side is zero', () => {
    const out = buildFilesRead(
      rollup([], [step({ shareRuns: 5, shareWeightedChars: 40, shareInputTokens: 0 })]),
    );
    expect(out.steps.rows[0]?.share).toEqual({ ratio: null, n: 5, sufficient: true });
    expect(out.steps.rows[0]?.exceedsPrompt).toBe(false);
  });

  it('orders by estimate (null last), runs, then step id, and caps with truncated', () => {
    const mk = (stepId: string, runs: number, chars: number) =>
      step({
        stepId,
        runs,
        shareRuns: chars > 0 ? 5 : 0,
        shareWeightedChars: chars,
        shareInputTokens: 10000,
      });
    const out = buildFilesRead(
      rollup(
        [],
        [mk('d', 1, 0), mk('c', 2, 400), mk('b', 2, 400), mk('a', 1, 400), mk('e', 9, 800)],
      ),
    );
    expect(out.steps.rows.map((r) => r.stepId)).toEqual(['e', 'b', 'c', 'a', 'd']);

    const many = Array.from({ length: FILES_READ_STEP_LIMIT + 3 }, (_, i) =>
      mk(`s${String(i).padStart(3, '0')}`, 1, 400),
    );
    const capped = buildFilesRead(rollup([], many));
    expect(capped.steps.rows).toHaveLength(FILES_READ_STEP_LIMIT);
    expect(capped.steps.count).toBe(FILES_READ_STEP_LIMIT + 3);
    expect(capped.steps.truncated).toBe(true);
    expect(out.steps.truncated).toBe(false);
  });
});

describe('buildFilesRead coverage', () => {
  it('reconciles the groups and orders providers by total, then name, null last', () => {
    const out = buildFilesRead(
      rollup(
        [],
        [
          group({
            provider: 'codex',
            runs: 10,
            inFlight: 1,
            recorded: 7,
            observable: 5,
            partial: 2,
            weighted: 3,
          }),
          group({
            stepId: 'x',
            provider: 'codex',
            runs: 2,
            recorded: 2,
            observable: 2,
            weighted: 2,
          }),
          group({ provider: null, runs: 12, recorded: 12, observable: 0 }),
          group({ provider: 'claude-code', runs: 12, recorded: 12, observable: 12, weighted: 12 }),
          group({ provider: 'amp', runs: 12, recorded: 4, observable: 0 }),
        ],
      ),
    );
    expect(out.coverage).toMatchObject({
      total: 48,
      recorded: 37,
      observable: 19,
      partial: 2,
      unobservable: 18,
      unrecorded: 48 - 37 - 1,
      inFlight: 1,
      weighted: 17,
    });
    expect(out.coverage.byProvider.map((p) => p.provider)).toEqual([
      'amp',
      'claude-code',
      'codex',
      null,
    ]);
    const codex = out.coverage.byProvider.find((p) => p.provider === 'codex');
    expect(codex).toMatchObject({
      total: 12,
      recorded: 9,
      unrecorded: 2,
      inFlight: 1,
      weighted: 5,
    });
    const sumTotal = out.coverage.byProvider.reduce((a, p) => a + p.total, 0);
    expect(sumTotal).toBe(out.coverage.total);
  });
});

describe('buildFilesRead empty rollup', () => {
  it('gives zeros, empty arrays and null ratios without NaN', () => {
    const out = buildFilesRead(rollup([], []));
    expect(out.coverage).toEqual({
      total: 0,
      recorded: 0,
      observable: 0,
      partial: 0,
      unobservable: 0,
      unrecorded: 0,
      inFlight: 0,
      weighted: 0,
      byProvider: [],
    });
    expect(out.totals).toEqual({ fileReads: 0, fileChars: 0, estimatedTokens: null });
    expect(out.files).toEqual({ rows: [], count: 0, truncated: false });
    expect(out.steps).toEqual({ rows: [], count: 0, truncated: false });
    expect(out.otherPaths.paths).toBe(0);
    expect(out.otherPaths.share).toEqual({ ratio: null, n: 0, sufficient: false });
    const json = JSON.stringify(out);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
    expect(json).not.toMatch(/"(reads|chars|runs|omitted|paths|count|total)":null/);
  });
});
