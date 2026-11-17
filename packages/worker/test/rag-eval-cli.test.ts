import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { fixtureFingerprint } from '../scripts/rag-eval-fixture.js';
import { compareRuns, type EvalRun } from '../scripts/rag-eval-report.js';

vi.mock('@haive/database', () => ({ createDatabase: vi.fn(() => ({})) }));
vi.mock('../scripts/rag-build-store.js', () => ({
  readBuildMeta: vi.fn(async () => null),
  decideBuildMeta: vi.fn(() => ({ action: 'resume' })),
}));
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  openExistingRagDatabase: vi.fn(async () => ({
    pg: { unsafe: vi.fn(async () => [{ present: 1 }]) },
    close: vi.fn(async () => {}),
    embeddingDimensions: 2,
  })),
  embedQueryOrNull: vi.fn(async () => [1, 0]),
  ragHybridSearch: vi.fn(async () => []),
}));

let dir: string;
const queryText = JSON.stringify([{ query: 'standalone', expected: 'a.ts' }]);
const manifestText = '{"version":1}';
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rag-eval-cli-'));
  await writeFile(path.join(dir, 'queries.json'), queryText);
  await writeFile(path.join(dir, 'fixture.json'), manifestText);
  await symlink(path.join(dir, 'queries.json'), path.join(dir, 'linked-queries.json'));
  await symlink(path.join(dir, 'fixture.json'), path.join(dir, 'linked-manifest.json'));
  await mkdir(path.join(dir, 'fixture-set'));
  await writeFile(path.join(dir, 'fixture-set/queries.json'), queryText);
  await writeFile(path.join(dir, 'fixture-set/manifest.json'), manifestText);
  await symlink(path.join(dir, 'fixture-set'), path.join(dir, 'linked-parent'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function evaluate(queryFile = 'queries.json', manifest?: string) {
  vi.resetModules();
  const out = path.join(dir, 'out.json');
  for (const [key, value] of Object.entries({
    DATABASE_URL: 'postgres://unused',
    RAG_QUERY: '',
    RAG_QUERY_SET: path.join(dir, queryFile),
    RAG_MANIFEST: manifest ? path.join(dir, manifest) : '',
    RAG_OUT: out,
    RAG_COMPACT: '1',
    RAG_MODEL: 'observed-test-model',
    RAG_DIMS: '2',
    RAG_LEXICAL_ONLY: '0',
    RAG_IDENTIFIER_SEARCH: '0',
    RAG_RUNBOOK_BOOST: '2',
    RAG_REPOSITORY_ID: '',
    RAG_DENSE_CHECK: '0',
    RAG_MODE: 'internal',
  }))
    vi.stubEnv(key, value);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const completed = new Promise<number>((resolve) => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      resolve(Number(code));
      return undefined as never;
    });
  });
  await import('../scripts/rag-eval.js');
  const code = await completed;
  return {
    code,
    errors: errors.mock.calls.map((args) => args.join(' ')).join('\n'),
    run: code === 0 ? (JSON.parse(await readFile(out, 'utf8')) as EvalRun) : null,
  };
}

it('runs a standalone query set without a manifest and marks it non-comparable', async () => {
  const result = await evaluate();
  expect(result.code, result.errors).toBe(0);
  expect(result.run!.fixture).toBeFalsy();
  expect(result.run!.results).toHaveLength(1);
  expect(() => compareRuns(result.run!, result.run!)).toThrow(
    'not comparable: no fixture manifest',
  );
});
it('fingerprints an explicit manifest and retains actual model, dimensions, pages, arm and knobs', async () => {
  const result = await evaluate('queries.json', 'fixture.json');
  expect(result.code, result.errors).toBe(0);
  expect(result.run!.fixture).toBe(fixtureFingerprint(manifestText, queryText));
  expect(result.run!.settings).toMatchObject({
    embeddingModel: 'observed-test-model',
    embeddingDimensions: 2,
    ks: [5, 8, 12, 20, 50],
    repositoryScoped: false,
    search: { lexicalOnly: false, identifierSearch: false, runbookBoost: 2 },
  });
});
it('does not silently ignore a missing explicit manifest', async () => {
  expect((await evaluate('queries.json', 'absent.json')).code).toBe(1);
});
it('automatically fingerprints the manifest adjacent to the query set', async () => {
  const result = await evaluate('fixture-set/queries.json');
  expect(result.code, result.errors).toBe(0);
  expect(result.run!.fixture).toBe(fixtureFingerprint(manifestText, queryText));
});
it.each([
  ['linked-queries.json', 'fixture.json'],
  ['queries.json', 'linked-manifest.json'],
  ['linked-parent/queries.json', 'fixture.json'],
])('refuses symlink input: %s / %s', async (queryFile, manifest) => {
  expect((await evaluate(queryFile, manifest)).code).toBe(1);
});
