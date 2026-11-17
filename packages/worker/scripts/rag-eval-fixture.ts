/** Verify the pinned git objects and every source anchor; optionally materialize
 * the exact allowlist into an operator-created empty directory. No network. */
import { createHash } from 'node:crypto';
import { gitRun } from '../src/repo/git-exec.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ensureDirNoFollow,
  readTextNoFollow,
  readdirNoFollow,
  toSafeRel,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { parseQuerySet, type SetQuery } from './rag-eval-metrics.js';

export const FIXTURE_DIR = 'packages/worker/test/fixtures/rag-eval';
export interface FixtureManifest {
  version: number;
  sourceCommit: string;
  corpus: { files: Record<string, string> };
  chunker: { files: Record<string, string> };
}
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export async function readPinnedFiles(
  root: string,
  commit: string,
  paths: string[],
): Promise<Map<string, string>> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('fixture must pin a full source commit');
  for (const p of paths)
    if (toSafeRel(p) !== p || p.includes('\n') || p.includes(':'))
      throw new Error('invalid fixture path');
  const result = await gitRun(
    root,
    ['-c', 'core.useReplaceRefs=false', 'cat-file', '--batch'],
    { GIT_NO_REPLACE_OBJECTS: '1' },
    {
      input: Buffer.from(paths.map((p) => `${commit}:${p}\n`).join('')),
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.code !== 0) throw new Error(`cannot read pinned tree: ${result.stderr}`);
  const bytes = Buffer.from(result.stdout);
  const out = new Map<string, string>();
  let offset = 0;
  for (const p of paths) {
    const end = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, end).toString();
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) throw new Error(`missing pinned blob ${p}: ${header}`);
    const size = Number(match[1]);
    out.set(p, bytes.subarray(end + 1, end + 1 + size).toString('utf8'));
    offset = end + 1 + size + 1;
  }
  return out;
}

export function verifyAnchors(queries: SetQuery[], files: ReadonlyMap<string, string>): number {
  let n = 0;
  const splits = new Map<string, string>();
  for (const q of queries) {
    const labels = [...(q.gold ?? []), ...(q.rubric ?? []).flatMap((r) => r.evidence)];
    for (const g of labels) {
      if (!g.anchor || !files.get(g.path)?.includes(g.anchor))
        throw new Error(`${q.id}: missing pinned anchor ${g.path}: ${g.anchor}`);
      const key = JSON.stringify(g);
      if (splits.has(key) && splits.get(key) !== q.split)
        throw new Error(`${q.id}: evidence leaks across splits`);
      if (q.split) splits.set(key, q.split);
      n++;
    }
  }
  return n;
}

export async function verifyFixture(root: string) {
  const manifestText = await readTextNoFollow(root, `${FIXTURE_DIR}/manifest.json`);
  const queryText = await readTextNoFollow(root, `${FIXTURE_DIR}/queries.json`);
  if (!manifestText || !queryText) throw new Error('fixture missing');
  const manifest = JSON.parse(manifestText) as FixtureManifest;
  const queries = parseQuerySet(JSON.parse(queryText), 'fixture');
  const hashes = { ...manifest.corpus.files, ...manifest.chunker.files };
  const files = await readPinnedFiles(root, manifest.sourceCommit, Object.keys(hashes));
  for (const [p, hash] of Object.entries(hashes))
    if (sha256(files.get(p)!) !== hash) throw new Error(`pinned hash mismatch: ${p}`);
  const corpus = new Map(Object.keys(manifest.corpus.files).map((p) => [p, files.get(p)!]));
  const anchors = verifyAnchors(queries, corpus);
  const fingerprint = sha256(manifestText + '\n' + queryText);
  return { manifest, queries, corpus, anchors, fingerprint };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const fixture = await verifyFixture(root);
  const destination = process.argv[2];
  if (destination) {
    const tree = path.resolve(destination);
    if ((await readdirNoFollow(tree, '.'))?.length !== 0)
      throw new Error('materialize destination must be empty');
    for (const [p, text] of fixture.corpus) {
      await ensureDirNoFollow(tree, path.posix.dirname(p));
      await writeFileNoFollow(tree, p, text, { mode: 'create-exclusive' });
    }
  }
  process.stdout.write(
    JSON.stringify({
      sourceCommit: fixture.manifest.sourceCommit,
      queries: fixture.queries.length,
      anchors: fixture.anchors,
      files: fixture.corpus.size,
      fingerprint: fixture.fingerprint,
    }) + '\n',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
