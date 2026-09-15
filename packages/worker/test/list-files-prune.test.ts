import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listFilesMatching } from '../src/step-engine/steps/onboarding/_helpers.js';

// `walk` prunes only node_modules/.git/vendor, so a caller that merely FILTERS ignored
// directories out of its results still pays to enumerate them in full. Anchored KB enrichment
// runs two such walks back to back over the same tree.
describe('listFilesMatching prune', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'haive-prune-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.ts'), 'x');
    // A deep, populated tree of the kind `.venv` / `target` / `Pods` really are.
    await mkdir(path.join(root, '.venv', 'lib', 'site-packages', 'pkg'), { recursive: true });
    for (const f of ['a.py', 'b.py', 'c.py']) {
      await writeFile(path.join(root, '.venv', 'lib', 'site-packages', 'pkg', f), 'x');
    }
    await writeFile(path.join(root, '.venv', 'pyvenv.cfg'), 'x');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = async (prune?: (name: string) => boolean) => {
    const seen: string[] = [];
    const files = await listFilesMatching(
      root,
      (rel, isDir) => {
        seen.push(rel);
        return !isDir && !rel.split('/').some((p) => p === '.venv');
      },
      10,
      prune,
    );
    return { files, seen };
  };

  it('returns exactly what filtering alone returned', async () => {
    const plain = await run();
    const pruned = await run((name) => name === '.venv');
    expect(pruned.files).toEqual(plain.files);
    expect(pruned.files).toEqual(['src/app.ts']);
  });

  // The proof that it PRUNES rather than filters: the predicate never sees the subtree at all.
  it('does not descend into a pruned directory', async () => {
    const plain = await run();
    const pruned = await run((name) => name === '.venv');
    expect(plain.seen).toContain('.venv/lib/site-packages/pkg/a.py');
    expect(pruned.seen.filter((r) => r.startsWith('.venv/'))).toEqual([]);
    // The directory ITSELF is still visited, so a caller listing directories is unaffected.
    expect(pruned.seen).toContain('.venv');
    expect(pruned.seen.length).toBeLessThan(plain.seen.length);
  });
});
