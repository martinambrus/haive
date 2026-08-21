import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectCodeFiles } from '../src/step-engine/steps/workflow/_rag-index.js';

let repo: string;

async function seed(files: string[]): Promise<void> {
  for (const rel of files) {
    const abs = path.join(repo, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, 'function x() { return 1; }\n', 'utf8');
  }
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-rag-collect-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('collectCodeFiles', () => {
  it('skips the minified bundles the onboarding collector already excluded', async () => {
    await seed([
      'src/a.js',
      'src/a.min.js',
      'yui/menu/menu-min.js',
      'assets/app.bundle.js',
      'assets/site.min.css',
    ]);

    expect(await collectCodeFiles(repo, [])).toEqual(['src/a.js']);
  });

  it('skips the ignored dirs and the repo scope deny list', async () => {
    await seed([
      'src/a.js',
      'node_modules/pkg/index.js',
      '.haive/worktrees/w/src/a.js',
      '.haive-data/knowledge_base/note.js',
      'docs/x.js',
    ]);

    expect(await collectCodeFiles(repo, ['docs'])).toEqual(['src/a.js']);
  });
});
