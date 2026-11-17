import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readTextNoFollow } from '@haive/shared/fs-safe';
import { METRIC_VERSION, SET_KS, type EvalRun } from '../scripts/rag-eval-report.js';
import { readPinnedFiles, verifyAnchors, verifyFixture } from '../scripts/rag-eval-fixture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
describe('committed reproducible retrieval fixture', () => {
  let fixture: Awaited<ReturnType<typeof verifyFixture>>;
  beforeAll(async () => {
    fixture = await verifyFixture(root);
  });
  it('verifies every corpus hash and all gold/rubric anchors in the pinned commit', async () => {
    const f = fixture;
    expect(f.queries).toHaveLength(180);
    expect(f.anchors).toBe(204);
    expect(f.corpus.size).toBe(262);
    expect(f.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const kind of ['identifier', 'paraphrase', 'overview', 'no-answer']) {
      for (const language of ['en', 'fr', 'sk']) {
        for (const split of ['tuning', 'held-out'])
          expect(
            f.queries.some((q) => q.kind === kind && q.language === language && q.split === split),
          ).toBe(true);
      }
    }
    const splits = new Map<string, string>();
    for (const q of f.queries) {
      expect(q.id).toBeTruthy();
      expect(q.topic).toBeTruthy();
      if (splits.has(q.topic!)) expect(q.split).toBe(splits.get(q.topic!));
      splits.set(q.topic!, q.split!);
    }
  });
  it('retains both measured arms with every original query and every page', async () => {
    for (const mode of ['hybrid', 'lexical']) {
      const raw = await readTextNoFollow(
        root,
        `packages/worker/test/fixtures/rag-eval/baseline-${mode}.json`,
      );
      const run = JSON.parse(raw!) as EvalRun;
      expect(run.metricVersion).toBe(METRIC_VERSION);
      expect(run.fixture).toBe(fixture.fingerprint);
      expect(run.results.map((r) => r.id)).toEqual(fixture.queries.map((q) => q.id));
      for (const [i, row] of run.results.entries()) {
        const q = fixture.queries[i]!;
        expect(row.query).toBe(q.query);
        expect(row.kind).toBe(q.kind);
        expect(row.language).toBe(q.language);
        expect(row.split).toBe(q.split);
        for (const k of SET_KS) {
          const page = row.byK[k];
          expect(page).toBeTruthy();
          if (q.kind === 'no-answer') expect(page!.noAnswer).not.toBeNull();
          else if (q.kind === 'overview') expect(page!.overview).not.toBeNull();
          else expect(page!.score).not.toBeNull();
        }
      }
    }
  });

  it('fails on absent anchors, excluded paths, and cross-split evidence leakage', async () => {
    const q = {
      query: 'q',
      kind: 'identifier',
      split: 'tuning',
      gold: [{ path: 'a', anchor: 'answer' }],
    };
    expect(() => verifyAnchors([q], new Map([['a', 'wrong']]))).toThrow('missing pinned anchor');
    expect(() => verifyAnchors([q], new Map())).toThrow('missing pinned anchor');
    expect(() =>
      verifyAnchors([q, { ...q, split: 'held-out' }], new Map([['a', 'answer']])),
    ).toThrow('leaks across splits');
    await expect(readPinnedFiles(root, 'HEAD', ['a'])).rejects.toThrow('full source commit');
  });
});
