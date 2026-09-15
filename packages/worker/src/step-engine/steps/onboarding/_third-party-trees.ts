import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Appended by the drupal.org packaging script to every `.info` / `.info.yml` it ships. */
const DRUPAL_PACKAGING_NOTE = 'Information added by Drupal.org packaging script';

/** Drupal 7 keeps its core beside `includes/`, at the docroot. */
const DRUPAL7_CORE_DIRS = ['includes', 'misc', 'modules', 'profiles', 'scripts', 'themes'];

/** composer/installers v2 default install paths for the package types that bring OTHER people's
 *  code. `drupal-custom-*` is absent on purpose: those types install the project's own modules. */
const COMPOSER_DEFAULT_PATHS: Readonly<Record<string, string>> = {
  'drupal-core': 'core',
  'drupal-module': 'modules/{$name}',
  'drupal-theme': 'themes/{$name}',
  'drupal-library': 'libraries/{$name}',
  'drupal-profile': 'profiles/{$name}',
  'drupal-drush': 'drush/{$name}',
  'drupal-recipe': 'recipes/{$name}',
  'wordpress-plugin': 'wp-content/plugins/{$name}',
  'wordpress-theme': 'wp-content/themes/{$name}',
  'wordpress-muplugin': 'wp-content/mu-plugins/{$name}',
};

interface ComposerPackage {
  name?: string;
  type?: string;
  dist?: { type?: string };
}

/** Repo-relative directories a package manager or a CMS distribution installed, found from markers
 *  those ecosystems stamp themselves rather than from directory-name conventions: Drupal's and
 *  WordPress's core marker files, the drupal.org packaging note, a wordpress.org `Stable tag`, and
 *  composer's lock file. `files` is the caller's own walk, so a marker is found wherever the docroot
 *  sits.
 *
 *  The scrub's collectors read a repository's OWN vocabulary, and on a CMS repo the files a sorted,
 *  capped walk reaches first are third-party. MEASURED before this existed: the cap kept 0 of a
 *  Drupal 7 site's own theme files, 0 of a Drupal 10 site's custom modules and 0 of a WordPress
 *  child theme's, while a library's public API counted as repository-private — which deletes a
 *  legitimate article. Directory conventions could not have found them: the Drupal 7 site keeps
 *  contrib flat in `sites/all/modules/`, and the Drupal 10 site installs `modules/webform` flat.
 *
 *  Best effort: an unreadable marker or a manifest that does not parse contributes nothing, which
 *  is the old behaviour. A marker at the repository ROOT is ignored — the repository then IS that
 *  package, and its code is its own. */
export async function detectThirdPartyTrees(
  repoPath: string,
  files: readonly string[],
): Promise<string[]> {
  const trees = new Set<string>();
  const read = (rel: string): Promise<string | null> =>
    readFile(path.join(repoPath, rel), 'utf8').catch(() => null);
  const hasFilesUnder = (dir: string): boolean => files.some((f) => f.startsWith(`${dir}/`));
  // The docroot a marker sits in, with a trailing slash, or null when `rel` is not that marker.
  const docrootOf = (rel: string, marker: string): string | null => {
    if (rel === marker) return '';
    return rel.endsWith(`/${marker}`) ? rel.slice(0, rel.length - marker.length) : null;
  };

  for (const rel of files) {
    const drupal = docrootOf(rel, 'core/lib/Drupal.php');
    if (drupal !== null) trees.add(`${drupal}core`);
    // Drupal 8+ also ships `core/includes/bootstrap.inc`, so only one outside `core/` is Drupal 7.
    const drupal7 = docrootOf(rel, 'includes/bootstrap.inc');
    if (drupal7 !== null && !drupal7.split('/').includes('core')) {
      for (const dir of DRUPAL7_CORE_DIRS) {
        if (hasFilesUnder(`${drupal7}${dir}`)) trees.add(`${drupal7}${dir}`);
      }
      // The Libraries API's home for external code (PhpSpreadsheet, mPDF), one per site directory.
      const sites = `${drupal7}sites/`;
      for (const f of files) {
        const site = f.startsWith(sites)
          ? /^([^/]+)\/libraries\//.exec(f.slice(sites.length))
          : null;
        if (site) trees.add(`${sites}${site[1]}/libraries`);
      }
    }
    const wordpress = docrootOf(rel, 'wp-includes/version.php');
    if (wordpress !== null) {
      for (const dir of ['wp-admin', 'wp-includes']) {
        if (hasFilesUnder(`${wordpress}${dir}`)) trees.add(`${wordpress}${dir}`);
      }
    }
  }

  for (const rel of files) {
    const dir = path.posix.dirname(rel);
    if (dir === '.') continue;
    if (/\.info(?:\.yml)?$/.test(rel)) {
      if ((await read(rel))?.includes(DRUPAL_PACKAGING_NOTE)) trees.add(dir);
    } else if (/(?:^|\/)wp-content\/(?:plugins|themes)\/[^/]+\/readme\.txt$/i.test(rel)) {
      if (/^Stable tag:/im.test((await read(rel)) ?? '')) trees.add(dir);
    }
  }

  if (files.includes('composer.json') && files.includes('composer.lock')) {
    const [manifest, lock] = await Promise.all([read('composer.json'), read('composer.lock')]);
    try {
      const installerPaths = Object.entries(
        (
          JSON.parse(manifest ?? '{}') as {
            extra?: { 'installer-paths'?: Record<string, unknown> };
          }
        ).extra?.['installer-paths'] ?? {},
      );
      const locked = JSON.parse(lock ?? '{}') as {
        packages?: ComposerPackage[];
        'packages-dev'?: ComposerPackage[];
      };
      for (const pkg of [...(locked.packages ?? []), ...(locked['packages-dev'] ?? [])]) {
        // A path repository is local code, and a custom type installs the project's own module.
        if (!pkg.name || !pkg.type || pkg.type.startsWith('drupal-custom-')) continue;
        if (pkg.dist?.type === 'path') continue;
        const [vendor = '', name = ''] = pkg.name.split('/');
        // composer/installers takes the FIRST installer-paths entry naming the package, its type or
        // its vendor, and falls back to its own default location.
        const rule = installerPaths.find(
          ([, match]) =>
            Array.isArray(match) &&
            (match.includes(pkg.name) ||
              match.includes(`type:${pkg.type}`) ||
              match.includes(`vendor:${vendor}`)),
        );
        const target = rule ? rule[0] : COMPOSER_DEFAULT_PATHS[pkg.type];
        if (target) {
          trees.add(
            target.replace('{$name}', name).replace('{$vendor}', vendor).replace(/\/+$/, ''),
          );
        }
      }
    } catch {
      // a manifest or lock that does not parse contributes nothing
    }
  }

  return [...trees].sort();
}

/** A membership test over `trees` costing one Set lookup per path segment rather than a scan of
 *  every tree per file — a Drupal site lists 26,000 files against 168 trees. */
export function insideAnyTree(trees: readonly string[]): (rel: string) => boolean {
  const set = new Set(trees);
  return (rel) => {
    for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
      if (set.has(rel.slice(0, i))) return true;
    }
    return false;
  };
}
