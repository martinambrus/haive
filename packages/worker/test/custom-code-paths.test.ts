import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectPathsForTest,
  detectStackForTest,
} from '../src/step-engine/steps/onboarding/01-env-detect.js';
import { repoOwnRef } from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

// MEASURED across nine onboarding runs of one Drupal 7 repo — identical on claude-code,
// codex sol, codex astra, grok, glm and muse, because this value never reaches a model:
// `customCodePaths.include` came back as the framework CONVENTION
// (`sites/all/modules/custom/`) while the repo's own module sat at
// `sites/all/modules/activit/`. Downstream, a non-empty include is authoritative, so no
// file matched it, `repoOwnRef` never fired, and a repo-specific page reached the SHARED
// global KB.
let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-custompaths-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe('detectPaths: customCodePaths are checked against the tree', () => {
  it('drops a convention directory this repo does not have', async () => {
    await mkdir(path.join(repo, 'sites/all/modules/activit'), { recursive: true });
    const paths = await detectPathsForTest(repo, 'drupal7');
    expect(paths.customCodePaths.include).toEqual([]);
    // The exclude list is a different thing: those ARE real Drupal core dirs and the
    // fallback predicate depends on them, so it is reported whether present or not.
    expect(paths.customCodePaths.exclude).toContain('includes/');
  });

  it('keeps the convention directory when the repo actually uses it', async () => {
    await mkdir(path.join(repo, 'sites/all/modules/custom'), { recursive: true });
    const paths = await detectPathsForTest(repo, 'drupal7');
    expect(paths.customCodePaths.include).toEqual(['sites/all/modules/custom/']);
  });
});

describe('repoOwnRef: an include that matches nothing is no include at all', () => {
  const detect = (include: string[]) =>
    ({ customCode: { include, exclude: ['includes/', 'modules/'] } }) as never;

  it('falls back to the heuristic when the stored include exists nowhere', async () => {
    // The persisted-payload case: a detect output written before the filter existed still
    // names a directory this repo has never had. With nothing usable left, the heuristic
    // decides — and here it can, because no exclude prefix matches.
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src/app.php'), 'x');
    const ref = await repoOwnRef(
      'see `src/app.php` for the entry point',
      undefined,
      detect(['lib/']),
      repo,
    );
    expect(ref).toBe('src/app.php');
  });

  it('still honours an include that does describe the repo', async () => {
    await mkdir(path.join(repo, 'sites/all/modules/custom/mine'), { recursive: true });
    await writeFile(path.join(repo, 'sites/all/modules/custom/mine/a.module'), 'x');
    await mkdir(path.join(repo, 'modules/contrib'), { recursive: true });
    await writeFile(path.join(repo, 'modules/contrib/b.module'), 'x');
    const inc = detect(['sites/all/modules/custom/']);
    expect(await repoOwnRef('`sites/all/modules/custom/mine/a.module`', undefined, inc, repo)).toBe(
      'sites/all/modules/custom/mine/a.module',
    );
    // A vendor path must not become repo-own just because the include is usable.
    expect(await repoOwnRef('`modules/contrib/b.module`', undefined, inc, repo)).toBeNull();
  });
});

describe('detectPaths: a Drupal site that ignores the custom/ convention', () => {
  // MEASURED on a live Drupal 7 site: 40 modules carry a `.info` and exactly one lacks
  // `project`, which drupal.org's packaging script stamps into every contrib release.
  it('finds the hand-written extension and leaves contrib alone', async () => {
    const mk = async (rel: string, info: string) => {
      await mkdir(path.join(repo, rel), { recursive: true });
      await writeFile(path.join(repo, rel, `${path.basename(rel)}.info`), info);
    };
    await mk('sites/all/modules/activit', 'name = Activit\nversion = 1.0\n');
    await mk('sites/all/modules/webform', 'name = Webform\nproject = "webform"\ndatestamp = "1"\n');
    await mk('sites/all/themes/activit', 'name = Activit theme\n');
    // A grouping dir with no info file must not be claimed.
    await mkdir(path.join(repo, 'sites/all/modules/contrib'), { recursive: true });

    const paths = await detectPathsForTest(repo, 'drupal7');
    expect(paths.customCodePaths.include).toEqual([
      'sites/all/modules/activit/',
      'sites/all/themes/activit/',
    ]);
  });

  it('and that include then beats the bare modules/ exclude', async () => {
    // The whole point: `modules/` matches anywhere, so before the specificity rule the
    // site's own module could never be repo-own.
    await mkdir(path.join(repo, 'sites/all/modules/activit'), { recursive: true });
    await writeFile(path.join(repo, 'sites/all/modules/activit/activit.module'), 'x');
    const ref = await repoOwnRef(
      'see `sites/all/modules/activit/activit.module`',
      undefined,
      {
        customCode: {
          include: ['sites/all/modules/activit/'],
          exclude: ['includes/', 'modules/', 'themes/'],
        },
      } as never,
      repo,
    );
    expect(ref).toBe('sites/all/modules/activit/activit.module');
  });
});

// A framework's customPaths are written relative to the DOCROOT. Composer templates nest it
// under `web/` and Acquia under `docroot/`, so stat-ing the bare convention at the repo root
// reports "not present" for a layout where it is present one level down.
describe('detectPaths: docroot and composer installer-path variants', () => {
  const info = (extra = '') => `name: X\ntype: module\n${extra}`;
  const mk = async (rel: string, body: string) => {
    await mkdir(path.join(repo, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(repo, rel), body);
  };

  it('finds the convention at the repo root when there is no docroot', async () => {
    await mk('modules/custom/mine/mine.info.yml', info());
    await mk('modules/contrib/token/token.info.yml', info("project: 'token'\n"));
    const p = await detectPathsForTest(repo, 'drupal');
    expect(p.customCodePaths.include).toEqual(['modules/custom/']);
  });

  it('finds the same convention nested under a web/ docroot', async () => {
    await mk('web/modules/custom/mine/mine.info.yml', info());
    const p = await detectPathsForTest(repo, 'drupal');
    expect(p.customCodePaths.include).toEqual(['web/modules/custom/']);
  });

  it('falls to the packaging-stamp scan when composer drops custom beside contrib', async () => {
    // installer-paths `modules/{$name}`: no `custom/` dir to lean on, so the `.info.yml`
    // stamps are the only thing separating the site's own module from contrib.
    await mk('modules/mymod/mymod.info.yml', info());
    await mk('modules/token/token.info.yml', info("project: 'token'\n"));
    const p = await detectPathsForTest(repo, 'drupal');
    expect(p.customCodePaths.include).toEqual(['modules/mymod/']);
  });
});

// `wp-content/themes/` is WordPress's declared custom path but, unlike Drupal's
// `modules/custom/`, it is a MIXED directory — core ships its Twenty* themes into it.
// MEASURED on a real WordPress site: naming the parent told the knowledge miner that three
// bundled core themes were the project's own code.
describe('detectPaths: WordPress themes', () => {
  const distributed = 'Stable tag: 1.5\nRequires at least: 6.0\n';
  const mkTheme = async (name: string, readme?: string) => {
    await mkdir(path.join(repo, 'wp-content/themes', name), { recursive: true });
    await writeFile(path.join(repo, 'wp-content/themes', name, 'style.css'), '/* x */');
    if (readme) await writeFile(path.join(repo, 'wp-content/themes', name, 'readme.txt'), readme);
  };

  it('drops the bundled themes and keeps a hand-written one', async () => {
    await mkTheme('twentytwentyfive', distributed);
    await mkTheme('twentytwentyfour', distributed);
    await mkTheme('dogacars-child'); // no readme.txt — nobody writes one for a child theme
    const paths = await detectPathsForTest(repo, 'wordpress');
    expect(paths.customCodePaths.include).toEqual(['wp-content/themes/dogacars-child/']);
  });

  it('reports nothing rather than the parent when every theme is distributed', async () => {
    // The real site measured: three bundled themes and no custom code at all. Saying
    // nothing is honest; naming `wp-content/themes/` claims core code as the project's.
    await mkTheme('twentytwentyfive', distributed);
    await mkTheme('twentytwentythree', distributed);
    const paths = await detectPathsForTest(repo, 'wordpress');
    expect(paths.customCodePaths.include).toEqual([]);
  });

  it('beats the wp-content/plugins exclude for a theme nested under a docroot', async () => {
    await mkdir(path.join(repo, 'web/wp-content/themes/mine'), { recursive: true });
    await writeFile(path.join(repo, 'web/wp-content/themes/mine/style.css'), '/* x */');
    const paths = await detectPathsForTest(repo, 'wordpress');
    expect(paths.customCodePaths.include).toEqual(['web/wp-content/themes/mine/']);
  });
});

// MEASURED on two live WordPress sites: one commits `wp-config.php` and one does not, and
// the one that does not was classified `general` once its LLM pass failed — losing the
// framework's exclude list and custom-path handling entirely. `06a-db-migrate` had already
// settled on the shipped marker for this same reason.
describe('detectStack: WordPress is found by a file WordPress ships', () => {
  it('detects a site that gitignores wp-config.php', async () => {
    await mkdir(path.join(repo, 'wp-includes'), { recursive: true });
    await writeFile(path.join(repo, 'wp-includes/version.php'), "<?php $wp_version = '6.8';");
    await writeFile(path.join(repo, 'wp-config-sample.php'), '<?php');
    const stack = await detectStackForTest(repo, { runtimeVersions: {} } as never);
    expect(stack.framework).toBe('wordpress');
    expect(stack.language).toBe('php');
  });

  it('detects it behind a docroot', async () => {
    await mkdir(path.join(repo, 'web/wp-includes'), { recursive: true });
    await writeFile(path.join(repo, 'web/wp-includes/version.php'), '<?php');
    const stack = await detectStackForTest(repo, { runtimeVersions: {} } as never);
    expect(stack.framework).toBe('wordpress');
  });

  it('does not call an arbitrary PHP project WordPress', async () => {
    await writeFile(path.join(repo, 'index.php'), '<?php');
    const stack = await detectStackForTest(repo, { runtimeVersions: {} } as never);
    expect(stack.framework).not.toBe('wordpress');
  });
});
