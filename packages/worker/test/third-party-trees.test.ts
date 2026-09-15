import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectRepoBasenames,
  collectRepoSymbols,
} from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';
import { listFilesMatching } from '../src/step-engine/steps/onboarding/_helpers.js';
import { detectThirdPartyTrees } from '../src/step-engine/steps/onboarding/_third-party-trees.js';

// The scrub's collectors read a repository's OWN vocabulary. Before third-party trees were
// excluded, the file cap kept 0 files of a Drupal 7 site's own theme, 0 of a Drupal 10 site's
// custom modules and 0 of a WordPress child theme — the files a sorted walk reaches first were
// core, contrib and plugins — while a library's public API counted as repository-private.
async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'third-party-'));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body, 'utf8');
  }
  return dir;
}

async function treesOf(dir: string): Promise<string[]> {
  return detectThirdPartyTrees(dir, await listFilesMatching(dir, (_rel, isDir) => !isDir, 10));
}

const PACKAGED_INFO = [
  'name = Views',
  'core = 7.x',
  '',
  '; Information added by Drupal.org packaging script on 2019-05-01',
  'version = "7.x-3.23"',
  'project = "views"',
].join('\n');

const DRUPAL7: Record<string, string> = {
  'includes/bootstrap.inc': '<?php\nfunction drupal_bootstrap_phase() {}\n',
  'modules/node/node.module': '<?php\nfunction node_load_multiple() {}\n',
  'sites/all/modules/views/views.info': PACKAGED_INFO,
  'sites/all/modules/views/views.module': '<?php\nfunction views_embed_view() {}\n',
  'sites/all/modules/acme_portal/acme_portal.info': 'name = Acme portal\ncore = 7.x\n',
  'sites/all/modules/acme_portal/acme_portal.module':
    '<?php\nfunction acme_portal_build_menu() {}\n',
  'sites/all/themes/acme/template.php': '<?php\nfunction acme_preprocess_page(&$variables) {}\n',
  'sites/all/libraries/mpdf/src/Mpdf.php': '<?php\nclass MpdfDocumentWriter {}\n',
};

const DRUPAL10: Record<string, string> = {
  'composer.json': JSON.stringify({
    extra: {
      'installer-paths': {
        'web/core': ['type:drupal-core'],
        'web/modules/contrib/{$name}': ['type:drupal-module'],
        'web/modules/custom/{$name}': ['type:drupal-custom-module'],
      },
    },
  }),
  'composer.lock': JSON.stringify({
    packages: [
      { name: 'drupal/core', type: 'drupal-core' },
      { name: 'drupal/webform', type: 'drupal-module' },
      { name: 'drupal/gin', type: 'drupal-theme' },
      { name: 'acme/bookings', type: 'drupal-custom-module' },
    ],
  }),
  'web/core/lib/Drupal.php': '<?php\nclass DrupalKernelBoot {}\n',
  'web/modules/contrib/webform/src/WebformSubmissionForm.php':
    '<?php\nclass WebformSubmissionForm {}\n',
  'themes/gin/gin.theme': '<?php\nfunction gin_preprocess_html(&$variables) {}\n',
  'web/modules/custom/bookings/src/BookingCalendar.php': '<?php\nclass BookingCalendar {}\n',
};

const WORDPRESS: Record<string, string> = {
  'wp-includes/version.php': "<?php\n$wp_version = '6.6.2';\nfunction wp_version_banner() {}\n",
  'wp-admin/admin.php': '<?php\nfunction wp_admin_boot_screen() {}\n',
  'wp-content/plugins/akismet/readme.txt': '=== Akismet Anti-spam ===\nStable tag: 5.3.3\n',
  'wp-content/plugins/akismet/akismet.php': '<?php\nfunction akismet_http_post() {}\n',
  'wp-content/plugins/acme-bookings/acme-bookings.php':
    '<?php\nfunction acme_bookings_render_form() {}\n',
  'wp-content/themes/kalium-child/functions.php':
    '<?php\nfunction kalium_child_enqueue_assets() {}\n',
};

describe('detectThirdPartyTrees', () => {
  it('finds Drupal 7 core, packaged contrib and the Libraries API home, not the site own code', async () => {
    expect(await treesOf(await repoWith(DRUPAL7))).toEqual([
      'includes',
      'modules',
      'sites/all/libraries',
      'sites/all/modules/views',
    ]);
  });

  it('follows composer installer-paths and defaults, and never a custom module', async () => {
    expect(await treesOf(await repoWith(DRUPAL10))).toEqual([
      'themes/gin',
      'web/core',
      'web/modules/contrib/webform',
    ]);
  });

  it('finds WordPress core and wordpress.org-listed plugins, not an unlisted plugin or a child theme', async () => {
    expect(await treesOf(await repoWith(WORDPRESS))).toEqual([
      'wp-admin',
      'wp-content/plugins/akismet',
      'wp-includes',
    ]);
  });

  it('treats a packaging note at the repository root as the repository itself', async () => {
    const dir = await repoWith({
      'views.info': PACKAGED_INFO,
      'views.module': '<?php\nfunction views_embed_view() {}\n',
    });
    expect(await treesOf(dir)).toEqual([]);
    expect((await collectRepoSymbols(dir, null)).has('views_embed_view')).toBe(true);
  });
});

describe('the scrub collectors skip third-party trees', () => {
  it('reads the foreign names when nothing marks them third-party (control)', async () => {
    const unmarked = { ...DRUPAL7 };
    delete unmarked['includes/bootstrap.inc'];
    unmarked['sites/all/modules/views/views.info'] = 'name = Views\ncore = 7.x\n';
    const symbols = await collectRepoSymbols(await repoWith(unmarked), null);
    for (const name of ['views_embed_view', 'node_load_multiple', 'MpdfDocumentWriter']) {
      expect(symbols.has(name)).toBe(true);
    }
  });

  it('keeps a Drupal 7 site own names and drops core, contrib and library ones', async () => {
    const dir = await repoWith(DRUPAL7);
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('acme_portal_build_menu')).toBe(true);
    expect(symbols.has('acme_preprocess_page')).toBe(true);
    for (const name of ['views_embed_view', 'node_load_multiple', 'MpdfDocumentWriter']) {
      expect(symbols.has(name)).toBe(false);
    }
    const basenames = await collectRepoBasenames(dir);
    expect(basenames.has('acme_portal.module')).toBe(true);
    expect(basenames.has('views.module')).toBe(false);
  });

  it('keeps a Drupal 10 custom module and drops composer-installed code', async () => {
    const symbols = await collectRepoSymbols(await repoWith(DRUPAL10), null);
    expect(symbols.has('BookingCalendar')).toBe(true);
    for (const name of ['WebformSubmissionForm', 'gin_preprocess_html', 'DrupalKernelBoot']) {
      expect(symbols.has(name)).toBe(false);
    }
  });

  it('keeps a WordPress child theme and an unlisted plugin, and drops core and a listed plugin', async () => {
    const dir = await repoWith(WORDPRESS);
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('kalium_child_enqueue_assets')).toBe(true);
    expect(symbols.has('acme_bookings_render_form')).toBe(true);
    for (const name of ['akismet_http_post', 'wp_admin_boot_screen', 'wp_version_banner']) {
      expect(symbols.has(name)).toBe(false);
    }
    const basenames = await collectRepoBasenames(dir);
    expect(basenames.has('functions.php')).toBe(true);
    expect(basenames.has('akismet.php')).toBe(false);
  });
});
