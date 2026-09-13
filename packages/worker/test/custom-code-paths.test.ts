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

  it('never scans the D7 core roots, stamped or not', async () => {
    // Root `modules/` and `themes/` are CORE on Drupal 7 — which is what that framework's
    // excludePaths already declare — so they are not extension locations to scan. Core
    // unpacked from a release tarball carries drupal.org's `project` stamp (MEASURED on a
    // live site: all 40 core modules and all 4 core themes), but core tracked from git
    // carries none, and scanning there would then report 40 hand-written extensions.
    const mk = async (rel: string, info: string) => {
      await mkdir(path.join(repo, rel), { recursive: true });
      await writeFile(path.join(repo, rel, `${path.basename(rel)}.info`), info);
    };
    await mk('modules/node', 'name = Node\npackage = Core\n');
    await mk('themes/bartik', 'name = Bartik\n');
    await mk('sites/all/modules/activit', 'name = Activit\n');

    const paths = await detectPathsForTest(repo, 'drupal7');
    expect(paths.customCodePaths.include).toEqual(['sites/all/modules/activit/']);
  });

  it('scans every sites/ directory, not just sites/all', async () => {
    // A multisite install keeps a site's own modules under `sites/<hostname>/modules` and a
    // single-site one under `sites/default/modules`. Missing them fails in the LEAKING
    // direction: the broad `modules/` exclude matches that segment anyway, so an extension
    // nobody listed reads as vendor code and its knowledge can reach the shared KB.
    const mk = async (rel: string, info: string) => {
      await mkdir(path.join(repo, rel), { recursive: true });
      await writeFile(path.join(repo, rel, `${path.basename(rel)}.info`), info);
    };
    await mk('sites/default/modules/site_private', 'name = Site Private\n');
    await mk('sites/example.com/themes/client_theme', 'name = Client Theme\n');
    await mk('sites/all/modules/webform', 'name = Webform\nproject = "webform"\n');
    await mk('sites/all/modules/shared_helper', 'name = Shared Helper\n');

    const paths = await detectPathsForTest(repo, 'drupal7');
    expect(paths.customCodePaths.include.sort()).toEqual([
      'sites/all/modules/shared_helper/',
      'sites/default/modules/site_private/',
      'sites/example.com/themes/client_theme/',
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

  it('keeps the convention alongside an extension the stamp scan found', async () => {
    // The stamp scan sees only extensions sitting DIRECTLY under a parent, so a repo that has
    // both an unstamped module beside contrib AND a populated `modules/custom/` is one it can
    // only half answer. Treating its non-empty result as the whole answer dropped
    // `modules/custom/` entirely, leaving the repo's own code outside every include.
    await mk('modules/legacy_bridge/legacy_bridge.info.yml', info());
    await mk('modules/custom/mine/mine.info.yml', info());
    const p = await detectPathsForTest(repo, 'drupal');
    expect(p.customCodePaths.include).toEqual(['modules/legacy_bridge/', 'modules/custom/']);
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
describe('detectPaths: WordPress extensions', () => {
  const vendor = (name: string) =>
    `/*\nTheme Name: ${name}\nTheme URI: https://vendor.example/\nLicense: GPLv2 or later\n*/`;
  const child = (name: string) =>
    `/*\nTheme Name: ${name}\nTheme URI: https://vendor.example/\nLicense: GPLv2 or later\nTemplate: kalium\n*/`;
  const bespokeTheme = (name: string) => `/*\nTheme Name: ${name}\nAuthor: In House\n*/`;
  const put = async (rel: string, body: string) => {
    await mkdir(path.join(repo, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(repo, rel), body);
  };

  it('keeps a child theme even though it inherits the parent vendor URI', async () => {
    // MEASURED on a live site: `kalium-child` carries `Theme URI: laborator.co` copied from
    // the commercial parent, so the URI says nothing about who wrote it.
    await put('wp-content/themes/kalium/style.css', vendor('Kalium'));
    await put('wp-content/themes/kalium-child/style.css', child('Kalium Child'));
    const p = await detectPathsForTest(repo, 'wordpress');
    expect(p.customCodePaths.include).toEqual(['wp-content/themes/kalium-child/']);
  });

  it('keeps a bespoke plugin that ships a readme with a Stable tag', async () => {
    // The case that killed the first rule: a real custom plugin shipped `Stable tag: 1.0.0`,
    // so a readme-based test would have excluded the very code this guard protects.
    await put(
      'wp-content/plugins/acme-login/acme-login.php',
      '<?php\n/*\nPlugin Name: Acme Login\nAuthor: In House\n*/',
    );
    await put('wp-content/plugins/acme-login/readme.txt', 'Stable tag: 1.0.0\n');
    await put(
      'wp-content/plugins/contact-form-7/wp-contact-form-7.php',
      '<?php\n/*\nPlugin Name: CF7\nPlugin URI: https://contactform7.com/\nText Domain: contact-form-7\n*/',
    );
    const p = await detectPathsForTest(repo, 'wordpress');
    expect(p.customCodePaths.include).toEqual(['wp-content/plugins/acme-login/']);
  });

  it('keeps an agency plugin that points its Plugin URI at the agency', async () => {
    // A URI alone does not make an extension third-party: an agency writing for one client
    // names its own site. What a PUBLISHED extension also carries is release machinery — an
    // i18n text domain, a declared license, or the readme `Stable tag` wordpress.org requires
    // — and a one-site plugin has no use for any of it. MEASURED across 71 extensions on two
    // live sites, every one of the ~60 declaring a URI carries at least one, so demanding the
    // pair costs no correct rejection.
    await put(
      'wp-content/plugins/client-portal/client-portal.php',
      '<?php\n/*\nPlugin Name: Client Portal\nPlugin URI: https://agency.example/\nVersion: 1.0\nAuthor: Agency\n*/',
    );
    await put(
      'wp-content/plugins/wordfence/wordfence.php',
      '<?php\n/*\nPlugin Name: Wordfence\nPlugin URI: https://www.wordfence.com/\nLicense: GPLv3\n*/',
    );
    const p = await detectPathsForTest(repo, 'wordpress');
    expect(p.customCodePaths.include).toEqual(['wp-content/plugins/client-portal/']);
  });

  it('finds a plugin that is a single file, and skips the silence-is-golden stub', async () => {
    // Core itself ships `hello.php` that way. A directory-only scan leaves a bespoke
    // single-file plugin with nothing more specific than the `wp-content/plugins/` exclude,
    // so `repoOwnRef` rejects every citation to it.
    await put(
      'wp-content/plugins/client-hooks.php',
      '<?php\n/*\nPlugin Name: Client Hooks\nAuthor: In House\n*/',
    );
    await put('wp-content/plugins/index.php', '<?php\n// Silence is golden.');
    await put(
      'wp-content/plugins/hello.php',
      '<?php\n/*\nPlugin Name: Hello Dolly\nPlugin URI: http://wordpress.org/plugins/hello-dolly/\nLicense: GPLv2 or later\n*/',
    );
    const p = await detectPathsForTest(repo, 'wordpress');
    // No trailing slash: it is a file, and `pathHasPrefix` matches whole segments either way.
    expect(p.customCodePaths.include).toEqual(['wp-content/plugins/client-hooks.php']);
  });

  it('reports an empty determination rather than naming the mixed parent', async () => {
    await put('wp-content/themes/twentytwentyfive/style.css', vendor('Twenty Twenty-Five'));
    const p = await detectPathsForTest(repo, 'wordpress');
    expect(p.customCodePaths.include).toEqual([]);
  });

  it('keeps an unmarked extension, because over-including is the safe error', async () => {
    await put('wp-content/themes/beclinic/style.css', bespokeTheme('BeClinic'));
    const p = await detectPathsForTest(repo, 'wordpress');
    expect(p.customCodePaths.include).toEqual(['wp-content/themes/beclinic/']);
  });
});

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

  it('still detects a composer-managed site that downloads core at deploy', async () => {
    // The mirror of the case above: bedrock and friends track a root `wp-config.php` and
    // pull core in with composer, so no `wp-includes/` is ever committed. The two markers
    // are absent on different projects, so the config file stays as a fallback.
    await writeFile(path.join(repo, 'wp-config.php'), '<?php');
    await writeFile(path.join(repo, 'composer.json'), '{"require":{"roots/wordpress":"*"}}');
    const stack = await detectStackForTest(repo, { runtimeVersions: {} } as never);
    expect(stack.framework).toBe('wordpress');
    expect(stack.language).toBe('php');
  });

  it('does not call an arbitrary PHP project WordPress', async () => {
    await writeFile(path.join(repo, 'index.php'), '<?php');
    const stack = await detectStackForTest(repo, { runtimeVersions: {} } as never);
    expect(stack.framework).not.toBe('wordpress');
  });
});
