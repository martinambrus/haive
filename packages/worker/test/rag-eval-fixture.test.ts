import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseQuerySet } from '../scripts/rag-eval-metrics.js';
import { readTextNoFollow } from '@haive/shared/fs-safe';
import { METRIC_VERSION, SET_KS, type EvalRun } from '../scripts/rag-eval-report.js';
import {
  fixtureFingerprint,
  hasPinnedCommit,
  makeAnchorSnapshot,
  readPinnedFiles,
  sha256,
  verifyAnchors,
  verifyFixture,
  verifySnapshot,
  warnChunkerDrift,
  type AnchorSnapshot,
  type FixtureManifest,
} from '../scripts/rag-eval-fixture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestText = (await readTextNoFollow(
  root,
  'packages/worker/test/fixtures/rag-eval/manifest.json',
))!;
const queryText = (await readTextNoFollow(
  root,
  'packages/worker/test/fixtures/rag-eval/queries.json',
))!;
const manifest = JSON.parse(manifestText) as FixtureManifest;
const queries = parseQuerySet(JSON.parse(queryText), 'fixture');
const snapshot = JSON.parse(
  (await readTextNoFollow(root, 'packages/worker/test/fixtures/rag-eval/anchors.json'))!,
) as AnchorSnapshot;
const fixture = {
  queries,
  anchors: verifySnapshot(manifest, queries, snapshot),
  corpus: new Map(Object.entries(manifest.corpus.files)),
  fingerprint: fixtureFingerprint(manifestText, queryText),
};
const haveCommit = await hasPinnedCommit(root, manifest.sourceCommit);
it.skipIf(!haveCommit)(
  `checks pinned Git objects (skipped when source commit ${manifest.sourceCommit} is unavailable; snapshot verification still runs)`,
  async () => {
    const f = await verifyFixture(root);
    expect(makeAnchorSnapshot(f.manifest, f.queries, f.corpus)).toEqual(snapshot);
  },
);
describe('committed reproducible retrieval fixture without history', () => {
  it('verifies every gold/rubric pair against the pinned source snapshot', async () => {
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
      expect(Buffer.byteLength(raw!)).toBeLessThanOrEqual(150_000);
      const run = JSON.parse(raw!) as EvalRun;
      expect(run).not.toHaveProperty('summary');
      expect(run.metricVersion).toBe(METRIC_VERSION);
      expect(run.fixture).toBe(fixture.fingerprint);
      expect(run.results.map((r) => r.id)).toEqual(fixture.queries.map((q) => q.id));
      for (const [i, row] of run.results.entries()) {
        const q = fixture.queries[i]!;
        expect(row.query).toBe(q.query);
        expect(row.kind).toBe(q.kind);
        expect(row.language).toBe(q.language);
        expect(row.split).toBe(q.split);
        expect(row.labels).toBe(
          sha256(
            JSON.stringify({
              gold: q.gold,
              expected: q.expected,
              rubric: q.rubric,
              reason: q.reason,
            }),
          ),
        );
        expect(row.dense).toBeUndefined();
        expect(row.signal?.k).toBe(8);
        expect(Number.isFinite(row.signal?.topDenseSim)).toBe(true);
        expect(typeof row.signal?.topLexical).toBe('boolean');
        for (const k of SET_KS) {
          const page = row.byK[k];
          expect(page).toBeTruthy();
          expect(page).not.toHaveProperty('ms');
          expect(page).not.toHaveProperty('hits');
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

it('invalidates fingerprints on any manifest/query byte edit', () => {
  expect(fixtureFingerprint(manifestText + ' ', queryText)).not.toBe(fixture.fingerprint);
  expect(fixtureFingerprint(manifestText, queryText + ' ')).not.toBe(fixture.fingerprint);
});
it('rejects snapshot hash, pair and context tampering', () => {
  for (const patch of [{ sha256: 'bad' }, { context: 'wrong' }, { anchor: 'changed' }]) {
    const copy = structuredClone(snapshot);
    Object.assign(copy.anchors[0]!, patch);
    expect(() => verifySnapshot(manifest, queries, copy)).toThrow();
  }
});
it('warns on HEAD chunker drift without failing the report', async () => {
  const warnings: string[] = [];
  const m = {
    ...manifest,
    chunker: {
      files: {
        'same.ts': sha256('same'),
        'changed.ts': sha256('before'),
        'missing.ts': sha256('x'),
      },
    },
  };
  await expect(
    warnChunkerDrift(
      root,
      m,
      (s) => {
        warnings.push(s);
      },
      async (p) => (p === 'same.ts' ? 'same' : p === 'changed.ts' ? 'after' : null),
    ),
  ).resolves.toBeUndefined();
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain('WARNING: HEAD chunker drift: changed.ts');
  expect(warnings[1]).toContain('missing.ts');
});
