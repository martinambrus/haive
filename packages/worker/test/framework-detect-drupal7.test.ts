import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectFramework } from '../src/repo/framework-detect.js';
import { detectStackForTest } from '../src/step-engine/steps/onboarding/01-env-detect.js';

// A Drupal 7 site was classified `general` by env-detect and `drupal` by the clone-time
// detector — two different wrong answers, from two independent causes. MEASURED on a
// live 9,245-file repo: the scope pickers were then seeded with 3 excludes instead of 6,
// leaving 1,941 files of core and vendored libraries (108 MB) offered as custom code and
// as RAG sources.

const containerWith = (frameworkHint: string | null) => ({
  type: 'ddev' as const,
  configFile: '.ddev/config.yaml',
  projectName: 'p',
  frameworkHint,
  databaseType: null,
  databaseVersion: null,
  webserver: null,
  docroot: null,
  runtimeVersions: {},
});

describe('detectFramework — the general/specific tie', () => {
  // Both patterns score 3 on this tree. Before the ratio tie-break the winner was
  // whichever came first in FRAMEWORK_PATTERNS, which is `drupal`.
  const d7Tree = [
    'includes/bootstrap.inc',
    'modules/system/system.info',
    'themes/bartik/bartik.info',
    'sites/all/modules/custom/activit/activit.module',
    'sites/all/themes/custom/t/t.info',
    'sites/default/settings.php',
  ];

  it('reads a Drupal 7 tree as drupal7, not as drupal', () => {
    expect(detectFramework(d7Tree)).toBe('drupal7');
  });

  // The tie-break must never outrank a higher score: D8+ matches all four `drupal`
  // indicators and zero `drupal7` ones (no `sites/all/`, no root bootstrap.inc).
  it('still reads a Drupal 8+ tree as drupal', () => {
    expect(
      detectFramework([
        'core/lib/Drupal.php',
        'modules/contrib/token/token.module',
        'themes/custom/t/t.info.yml',
        'sites/default/settings.php',
        'composer.json',
      ]),
    ).toBe('drupal');
  });

  it('claims nothing from a tree that matches one indicator', () => {
    expect(detectFramework(['modules/foo.txt'])).toBeNull();
  });
});

describe('detectStack — frameworks with no manifest to be named in', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-fwdetect-'));
    for (const name of ['d7', 'd7-composer', 'hint-only', 'hint-unmodelled', 'empty']) {
      await mkdir(path.join(dir, name), { recursive: true });
    }
    for (const name of ['d7', 'd7-composer']) {
      await mkdir(path.join(dir, name, 'includes'), { recursive: true });
      await writeFile(path.join(dir, name, 'includes', 'bootstrap.inc'), '<?php\n');
    }
    // D7 predates composer-managed cores, but plenty of D7 sites carry a composer.json
    // for libraries alone — it names no `drupal/*`, so the manifest route writes
    // `general` and the marker must still be reached.
    await writeFile(
      path.join(dir, 'd7-composer', 'composer.json'),
      JSON.stringify({ require: { 'mpdf/mpdf': '^8.0' } }),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names Drupal 7 from its own bootstrap, with no manifest at all', async () => {
    const stack = await detectStackForTest(path.join(dir, 'd7'), containerWith(null));
    expect(stack.framework).toBe('drupal7');
    expect(stack.language).toBe('php');
  });

  it('names it past a composer.json that recognised nothing', async () => {
    const stack = await detectStackForTest(path.join(dir, 'd7-composer'), containerWith(null));
    expect(stack.framework).toBe('drupal7');
  });

  it("falls back to DDEV's own type: when nothing on disk says", async () => {
    const stack = await detectStackForTest(path.join(dir, 'hint-only'), containerWith('wordpress'));
    expect(stack.framework).toBe('wordpress');
  });

  // DDEV's vocabulary is its own. `php` is its generic type and `typo3` is a framework
  // with no pattern here; neither may become a claim.
  it('ignores a hint naming something this build does not model', async () => {
    for (const hint of ['php', 'typo3', 'magento2', 'backdrop']) {
      const stack = await detectStackForTest(
        path.join(dir, 'hint-unmodelled'),
        containerWith(hint),
      );
      expect(stack.framework).toBe('general');
    }
  });

  it('is still general when neither disk nor container says anything', async () => {
    const stack = await detectStackForTest(path.join(dir, 'empty'), containerWith(null));
    expect(stack.framework).toBe('general');
  });
});
