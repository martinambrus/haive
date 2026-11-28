import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  FilesReadSection,
  displayPath,
  estimateText,
  filesReadMessage,
  filesReadNotes,
  fileRowFigures,
} from '../../src/web/components/files-read-section.js';
import { InlineBar } from '../../src/web/components/ranked-bars.js';
import type { StatsFilesRead } from '../../src/web/api.js';

type Report = Extract<StatsFilesRead, { available: true }>;
type El = ReactElement<{ children?: ReactNode; body?: string; href?: string }>;

const MarkdownView = (() => null) as unknown as Parameters<
  typeof FilesReadSection
>[0]['MarkdownView'];

function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (typeof node !== 'object') return String(node);
  return text((node as El).props.children);
}

function find(node: ReactNode, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) find(n, pred, out);
    return out;
  }
  const el = node as El;
  if (pred(el)) out.push(el);
  find(el.props?.children, pred, out);
  return out;
}

const ratio = (r: number | null, n: number, sufficient: boolean) => ({ ratio: r, n, sufficient });
const bucket = (over: Partial<Report['otherPaths']> = {}) => ({
  reads: 0,
  chars: 0,
  estimatedTokens: null,
  share: ratio(null, 0, false),
  ...over,
});

function report(over: Partial<Report> = {}): Report {
  return {
    range: { from: 'a', to: 'b', timeZone: 'UTC' },
    scope: { repositoryId: 'r1', cliProviderId: null, taskClass: null, allUsers: false },
    available: true,
    coverage: {
      total: 12,
      recorded: 10,
      observable: 8,
      partial: 0,
      unobservable: 2,
      unrecorded: 2,
      inFlight: 0,
      weighted: 8,
      byProvider: [
        {
          provider: 'claude',
          total: 12,
          recorded: 10,
          observable: 8,
          partial: 0,
          unobservable: 2,
          unrecorded: 2,
          inFlight: 0,
          weighted: 8,
        },
        {
          provider: null,
          total: 0,
          recorded: 0,
          observable: 0,
          partial: 0,
          unobservable: 0,
          unrecorded: 0,
          inFlight: 0,
          weighted: 0,
        },
      ],
    },
    totals: { fileReads: 40, fileChars: 4800, estimatedTokens: 1200 },
    files: {
      rows: [
        {
          path: 'src/a.ts',
          reads: 5,
          chars: 800,
          weightedChars: 4000,
          weightedRuns: 8,
          runs: 8,
          tasks: 3,
          estimatedTokens: 1000,
          share: ratio(0.5, 8, true),
        },
        {
          path: 'src/unknown.ts',
          reads: 2,
          chars: 100,
          weightedChars: null,
          weightedRuns: 0,
          runs: 2,
          tasks: 1,
          estimatedTokens: null,
          share: ratio(null, 8, true),
        },
      ],
      count: 2,
      truncated: false,
    },
    otherPaths: { paths: 0, ...bucket() },
    overflow: { omitted: 0, runs: 0, ...bucket() },
    multiFile: { runs: 0, ...bucket() },
    steps: { rows: [], count: 0, truncated: false },
    ...over,
  };
}

const render = (r: StatsFilesRead | null, over: { failed?: boolean; repo?: string } = {}) =>
  FilesReadSection({
    repositoryId: over.repo ?? 'r1',
    report: r,
    failed: over.failed ?? false,
    MarkdownView,
  });

describe('Files read: messages', () => {
  it('asks for a repository, also when the route says repository-required', () => {
    expect(text(render(null, { repo: '' }))).toContain(
      'Select a repository above to rank the files its agents read; paths of different repositories are not comparable.',
    );
    const unavailable: StatsFilesRead = {
      range: { from: 'a', to: 'b', timeZone: 'UTC' },
      scope: { repositoryId: null, cliProviderId: null, taskClass: null, allUsers: false },
      available: false,
      reason: 'repository-required',
    };
    expect(text(render(unavailable))).toContain('Select a repository above');
  });

  it('says loading, failed, no runs and no countable runs', () => {
    expect(text(render(null))).toContain('Loading');
    expect(text(render(null, { failed: true }))).toContain(
      'The file-read report could not be loaded.',
    );
    const none = report();
    none.coverage = { ...none.coverage, total: 0, recorded: 0, observable: 0, unobservable: 0 };
    expect(text(render(none))).toContain('No agent run in this window');
    const unobservable = report();
    unobservable.coverage = {
      ...unobservable.coverage,
      total: 9,
      observable: 0,
      unobservable: 4,
      unrecorded: 3,
      inFlight: 2,
    };
    const msg = filesReadMessage({ repositoryId: 'r1', report: unobservable, failed: false });
    expect(msg).toContain('9 runs');
    expect(msg).toContain('4');
    expect(msg).toContain('3');
    expect(msg).toContain('2');
  });
});

describe('Files read: populated report', () => {
  it('renders an unknown estimate as a dash and never as ~0', () => {
    expect(estimateText(null)).toBe('—');
    expect(estimateText(0)).toBe('≈0');
    expect(estimateText(1234)).toBe('≈1.2k');
    const copy = text(render(report()));
    expect(copy).toContain('src/unknown.ts');
    const unknownRow = find(
      render(report()),
      (e) => e.type === 'li' && text(e).includes('src/unknown.ts'),
    )[0];
    expect(unknownRow).toBeDefined();
    expect(text(unknownRow)).not.toContain('≈0');
    expect(find(unknownRow, (e) => e.type === InlineBar)).toEqual([]);
    const knownRow = find(
      render(report()),
      (e) => e.type === 'li' && text(e).includes('src/a.ts'),
    )[0];
    expect(knownRow).toBeDefined();
    expect(find(knownRow, (e) => e.type === InlineBar)).toHaveLength(1);
    expect(copy).toContain('≈1.0k');
    const figures = fileRowFigures(report().files.rows[1]!);
    expect(figures).toBe(
      '2 reads · 2 runs · 1 tasks · — of file-read tokens · weight known in 0 of 2 runs',
    );
  });

  it('shows n= under 5 runs and a percent at 5', () => {
    const low = report();
    low.files.rows[0]!.share = ratio(0.5, 3, false);
    expect(fileRowFigures(low.files.rows[0]!)).toContain('n=3 of file-read tokens');
    const ok = report();
    ok.files.rows[0]!.share = ratio(0.5, 5, true);
    expect(fileRowFigures(ok.files.rows[0]!)).toContain('50.0% of file-read tokens');
    expect(fileRowFigures(ok.files.rows[0]!)).not.toContain('weight known');
  });

  it('says so when no file path was recorded', () => {
    const empty = report({ files: { rows: [], count: 0, truncated: false } });
    expect(text(render(empty))).toContain('No file path was recorded in these runs.');
    expect(text(render(report()))).not.toContain('No file path was recorded');
  });

  it('shows the floors figure and the provider table', () => {
    expect(text(render(report()))).not.toContain('counts are floors');
    const partial = report();
    partial.coverage = { ...partial.coverage, partial: 2 };
    expect(text(render(partial))).toContain('counts are floors');
    const copy = text(render(report()));
    expect(copy).toContain('claude');
    expect(copy).toContain('no provider');
  });

  it('lists the buckets only when non-empty', () => {
    const base = text(render(report()));
    expect(base).not.toContain('more paths');
    expect(base).not.toContain('left off');
    expect(base).not.toContain('several files');
    const full = report({
      files: { ...report().files, count: 60, truncated: true },
      otherPaths: { paths: 10, ...bucket({ reads: 7, chars: 70, estimatedTokens: 17.5 }) },
      overflow: { omitted: 4, runs: 2, ...bucket({ reads: 3, chars: 30 }) },
      multiFile: { runs: 1, ...bucket({ reads: 2, chars: 20, estimatedTokens: 5 }) },
    });
    const copy = text(render(full));
    expect(copy).toContain('+10 more paths');
    expect(copy).toContain('60');
    expect(copy).toContain('left off');
    expect(copy).toContain('4');
    expect(copy).toContain('several files');
  });

  it('flags a step whose estimate exceeds the exact prompt tokens and states truncation', () => {
    const r = report({
      steps: {
        rows: [
          {
            stepId: '08-implement',
            runs: 6,
            estimatedTokens: 3000,
            promptTokens: 2000,
            share: ratio(1.5, 6, true),
            exceedsPrompt: true,
          },
          {
            stepId: '03-plan',
            runs: 2,
            estimatedTokens: null,
            promptTokens: null,
            share: ratio(null, 0, false),
            exceedsPrompt: false,
          },
        ],
        count: 70,
        truncated: true,
      },
    });
    const tree = render(r);
    const copy = text(tree);
    expect(copy).toContain('08-implement');
    expect(copy).toContain('exceeds');
    expect(copy).toContain('unclamped');
    expect(copy).toContain('No run was measurable');
    expect(copy).toContain('70');
    const flagged = find(tree, (e) => text(e).includes('unclamped')).pop();
    expect(flagged).toBeDefined();
    const stepLi = (id: string) =>
      find(tree, (e) => e.type === 'li' && text(e).includes(id) && !text(e).includes('src/'))[0];
    expect(find(stepLi('08-implement'), (e) => e.type === InlineBar)).toHaveLength(1);
    expect(stepLi('03-plan')).toBeDefined();
    expect(find(stepLi('03-plan'), (e) => e.type === InlineBar)).toEqual([]);
  });

  it('builds the notes from the report', () => {
    const plain = filesReadNotes(report());
    expect(plain).toContain('not billed tokens');
    expect(plain).not.toContain('floors');
    const partial = report();
    partial.coverage = { ...partial.coverage, partial: 1 };
    expect(filesReadNotes(partial)).toContain('floors');
    const bodies = find(render(report()), (e) => e.type === MarkdownView).map((e) => e.props.body);
    expect(bodies).toEqual([plain]);
  });
});

describe('Files read: hostile paths are inert text', () => {
  const hostile = [
    '<img src=x onerror=alert(1)>.ts',
    'a_b*c.ts',
    '[click](https://evil.example/x).md',
  ];

  it('renders every path verbatim as a span child, with no anchor and no markdown body', () => {
    const r = report();
    r.files.rows = hostile.map((path, i) => ({
      ...r.files.rows[0]!,
      path,
      reads: i + 1,
    }));
    r.files.count = 3;
    const tree = render(r);
    for (const path of hostile) {
      const spans = find(
        tree,
        (e) =>
          e.type === 'span' &&
          Array.isArray([e.props.children].flat()) &&
          [e.props.children].flat().includes(path as unknown as ReactNode),
      );
      expect(spans.length).toBeGreaterThan(0);
    }
    expect(find(tree, (e) => e.type === 'a')).toEqual([]);
    expect(find(tree, (e) => 'href' in (e.props ?? {}))).toEqual([]);
    expect(find(tree, (e) => 'dangerouslySetInnerHTML' in (e.props ?? {}))).toEqual([]);
    const bodies = find(tree, (e) => e.type === MarkdownView).map((e) => e.props.body ?? '');
    for (const path of hostile) for (const b of bodies) expect(b).not.toContain(path);
  });
});

describe('Files read: control and format characters in a path', () => {
  it('shows them as escapes and leaves printable text alone', () => {
    expect(displayPath('a\u202Egnp.exe')).toBe('a\\u{202e}gnp.exe');
    expect(displayPath('x\ny\t.ts')).toBe('x\\u{a}y\\u{9}.ts');
    expect(displayPath('z\u200Bw\uFEFF')).toBe('z\\u{200b}w\\u{feff}');
    expect(displayPath('src/\u00FC/\u65E5\u672C.ts')).toBe('src/\u00FC/\u65E5\u672C.ts');
  });

  it('renders the escaped path, never the raw character', () => {
    const r = report();
    r.files.rows[0]!.path = 'src/a\u202Egnp.ts';
    const tree = render(r);
    const spans = find(
      tree,
      (e) => e.type === 'span' && [e.props.children].flat().includes('src/a\\u{202e}gnp.ts'),
    );
    expect(spans).toHaveLength(1);
    expect(text(tree)).not.toContain('\u202E');
  });
});

describe('Files read: hook-free', () => {
  it('is callable directly with props alone', () => {
    expect(() => render(report())).not.toThrow();
    expect(() => render(null)).not.toThrow();
  });
});
