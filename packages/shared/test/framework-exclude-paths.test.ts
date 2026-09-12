import { describe, it, expect } from 'vitest';
import { FRAMEWORK_PATTERNS } from '../src/constants/index.js';

// Consumers anchor on a whole path segment (`rel === g || rel.startsWith(g + '/')`), and
// `computeSeedExcludeGlobs` additionally drops any entry the repo does not actually have.
// So these lists are safe to extend, and the property that matters is that a core path
// never swallows the directory the project's own code lives in.
const excludes = (fw: keyof typeof FRAMEWORK_PATTERNS): string[] =>
  FRAMEWORK_PATTERNS[fw].excludePaths.map((p) => p.replace(/\/$/, ''));

const hits = (fw: keyof typeof FRAMEWORK_PATTERNS, rel: string): boolean =>
  excludes(fw).some((g) => rel === g || rel.startsWith(`${g}/`));

describe('drupal7 exclude paths', () => {
  // On D7 the ROOT modules/themes/profiles are core; contrib and custom live under sites/.
  it('excludes the core trees at the root', () => {
    for (const p of [
      'includes',
      'misc',
      'modules/simpletest',
      'profiles/standard',
      'scripts',
      'themes/bartik',
    ]) {
      expect(hits('drupal7', p), p).toBe(true);
    }
  });

  // The whole point: `modules` must not match `sites/all/modules`.
  it('leaves contrib and custom code in scope', () => {
    for (const p of [
      'sites/all/modules',
      'sites/all/modules/activit/activit.module',
      'sites/all/themes/activit',
    ]) {
      expect(hits('drupal7', p), p).toBe(false);
    }
  });

  it('excludes vendored libraries and the files directory', () => {
    expect(hits('drupal7', 'sites/all/libraries/PhpSpreadsheet')).toBe(true);
    expect(hits('drupal7', 'sites/default/files/x.pdf')).toBe(true);
  });
});

describe('drupal 8+ exclude paths', () => {
  it('covers both the repo-root and composer-template (web/) layouts', () => {
    for (const p of [
      'core/lib',
      'modules/contrib/token',
      'sites/default/files/a.png',
      'vendor/x',
      'web/core/lib',
      'web/modules/contrib/token',
      'web/sites/default/files/a.png',
    ]) {
      expect(hits('drupal', p), p).toBe(true);
    }
  });

  it('leaves custom modules and themes in scope in either layout', () => {
    for (const p of ['modules/custom/mine', 'themes/custom/mine', 'web/modules/custom/mine']) {
      expect(hits('drupal', p), p).toBe(false);
    }
  });
});

describe('wordpress exclude paths', () => {
  it('excludes core, uploads and the generated content dirs', () => {
    for (const p of [
      'wp-admin/x.php',
      'wp-includes/x.php',
      'wp-content/uploads/2026/a.jpg',
      'wp-content/cache/x',
      'wp-content/upgrade/x',
      'wp-content/languages/x',
    ]) {
      expect(hits('wordpress', p), p).toBe(true);
    }
  });

  // A directory cannot be both this framework's customPaths and excluded from scope.
  it('does not exclude the themes directory it declares as the custom path', () => {
    expect(FRAMEWORK_PATTERNS.wordpress.customPaths).toContain('wp-content/themes/');
    expect(hits('wordpress', 'wp-content/themes/my-theme/functions.php')).toBe(false);
  });
});

describe('every framework', () => {
  it('never excludes a path it also declares as custom', () => {
    for (const [name, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
      for (const custom of pattern.customPaths) {
        const rel = custom.replace(/\/$/, '');
        const clash = pattern.excludePaths
          .map((p) => p.replace(/\/$/, ''))
          .filter((g) => rel === g || rel.startsWith(`${g}/`));
        expect(clash, `${name}: ${custom} excluded by ${clash.join()}`).toEqual([]);
      }
    }
  });
});
