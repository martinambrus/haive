import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectCodeFiles } from '../src/step-engine/steps/workflow/_rag-index.js';
import { ownPathList } from '../src/step-engine/steps/onboarding/_rag-collect.js';

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

    expect(await collectCodeFiles(repo)).toEqual(['src/a.js']);
  });

  it('skips the ignored dirs and the repo scope deny list', async () => {
    await seed([
      'src/a.js',
      'node_modules/pkg/index.js',
      '.haive/worktrees/w/src/a.js',
      '.haive-data/knowledge_base/note.js',
      'docs/x.js',
    ]);

    expect(await collectCodeFiles(repo, { exclude: ['docs'] })).toEqual(['src/a.js']);
  });

  it('excludes a trailing-slash deny entry, as FRAMEWORK_PATTERNS writes them', async () => {
    // 01-env-detect contributes FRAMEWORK_PATTERNS.excludePaths verbatim, and
    // every one of those is written 'core/' / 'vendor/' / 'wp-admin/'.
    await seed(['src/a.js', 'core/lib.js', 'vendor-ui/w.js']);

    expect(await collectCodeFiles(repo, { exclude: ['core/'] })).toEqual([
      'src/a.js',
      'vendor-ui/w.js',
    ]);
  });

  it('honors 09_7 extension and folder picks so the orphan sweep cannot delete them', async () => {
    // The workflow steps reconcile against whatever this collects: an extension
    // onboarding indexed but this call misses is swept out of RAG, not skipped.
    await seed(['app/a.php', 'app/tpl.phtml', 'app/a.js', 'other/b.php']);

    expect(await collectCodeFiles(repo, { extensionSet: ['.php', '.phtml'] })).toEqual([
      'app/a.php',
      'app/tpl.phtml',
      'other/b.php',
    ]);
    expect(await collectCodeFiles(repo, { selectedDirs: ['app'] })).toEqual([
      'app/a.js',
      'app/a.php',
    ]);
  });
  describe('own paths under a broader heuristic exclude', () => {
    const heuristicExclude = ['wp-content/plugins/'];
    const ownPaths = ['wp-content/plugins/acme/', 'wp-content/plugins/hooks.php'];
    const tree = [
      'wp-content/plugins/acme/acme.php',
      'wp-content/plugins/acme/inc/more.php',
      'wp-content/plugins/hooks.php',
      'wp-content/plugins/hooks.php.bak/x.php',
      'wp-content/plugins/contact-form-7/x.php',
      'wp-content/themes/t/functions.php',
    ];

    it('collects own plugin directories and files, and nothing else under the excluded parent', async () => {
      await seed(tree);

      expect(await collectCodeFiles(repo, { heuristicExclude, ownPaths })).toEqual([
        'wp-content/plugins/acme/acme.php',
        'wp-content/plugins/acme/inc/more.php',
        'wp-content/plugins/hooks.php',
        'wp-content/themes/t/functions.php',
      ]);
    });

    it('still excludes the heuristic path when no own path is given', async () => {
      await seed(tree);

      expect(await collectCodeFiles(repo, { heuristicExclude })).toEqual([
        'wp-content/themes/t/functions.php',
      ]);
    });

    it('lets the user scope win over an own path', async () => {
      await seed(tree);

      expect(
        await collectCodeFiles(repo, {
          exclude: ['wp-content/plugins/acme/'],
          heuristicExclude,
          ownPaths,
        }),
      ).toEqual(['wp-content/plugins/hooks.php', 'wp-content/themes/t/functions.php']);
    });
  });
});

describe('ownPathList', () => {
  it('keeps only the string entries of an array, and nothing else', () => {
    expect(ownPathList(['a/', null, 7, 'b.php'])).toEqual(['a/', 'b.php']);
    expect(ownPathList('a/')).toEqual([]);
    expect(ownPathList(undefined)).toEqual([]);
  });
});
