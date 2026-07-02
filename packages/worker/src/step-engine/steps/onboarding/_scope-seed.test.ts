import { describe, expect, it } from 'vitest';
import {
  composerExcludeDirs,
  computeSeedExcludeGlobs,
  gitignoreExcludeDirs,
} from './_scope-seed.js';

describe('composerExcludeDirs', () => {
  it('extracts built-in install dirs from installer-paths, dropping placeholders', () => {
    const composer = {
      extra: {
        'installer-paths': {
          'web/core': ['type:drupal-core'],
          'web/modules/contrib/{$name}': ['type:drupal-module'],
          'web/themes/contrib/{$name}': ['type:drupal-theme'],
          'web/libraries/{$name}': ['type:drupal-library'],
        },
      },
    };
    expect(composerExcludeDirs(composer).sort()).toEqual([
      'web/core',
      'web/libraries',
      'web/modules/contrib',
      'web/themes/contrib',
    ]);
  });

  it('keeps custom install paths in scope', () => {
    const composer = {
      extra: {
        'installer-paths': {
          'web/modules/contrib/{$name}': ['type:drupal-module'],
          'web/modules/custom/{$name}': ['type:drupal-custom-module'],
        },
      },
    };
    expect(composerExcludeDirs(composer)).toEqual(['web/modules/contrib']);
  });

  it('returns [] when there is no installer-paths block', () => {
    expect(composerExcludeDirs({ extra: {} })).toEqual([]);
    expect(composerExcludeDirs(null)).toEqual([]);
    expect(composerExcludeDirs('not an object')).toEqual([]);
  });
});

describe('gitignoreExcludeDirs', () => {
  it('extracts plain directory rules, skipping comments/negations/globs', () => {
    const gitignore = [
      '# deps + build',
      'node_modules/',
      '/vendor',
      'dist',
      '!keep-this',
      '*.log',
      'coverage/*',
      '/web/sites/default/files',
    ].join('\n');
    expect(gitignoreExcludeDirs(gitignore).sort()).toEqual([
      'dist',
      'node_modules',
      'vendor',
      'web/sites/default/files',
    ]);
  });

  it('returns [] for null/empty', () => {
    expect(gitignoreExcludeDirs(null)).toEqual([]);
    expect(gitignoreExcludeDirs('')).toEqual([]);
  });
});

describe('computeSeedExcludeGlobs', () => {
  it('seeds composer built-ins + NO_RECURSE, filtered to dirs that exist in the tree', () => {
    const composer = {
      extra: {
        'installer-paths': {
          'web/core': [],
          'web/modules/contrib/{$name}': [],
          'web/modules/custom/{$name}': [],
        },
      },
    };
    const treePaths = [
      'web',
      'web/core',
      'web/modules',
      'web/modules/contrib',
      'web/modules/custom',
      'vendor',
      'node_modules',
    ];
    const seed = computeSeedExcludeGlobs({ composer, framework: 'drupal', treePaths });
    expect(seed).toContain('web/core');
    expect(seed).toContain('web/modules/contrib');
    expect(seed).toContain('vendor');
    expect(seed).toContain('node_modules');
    expect(seed).not.toContain('web/modules/custom');
  });

  it('drops framework-pattern paths that do not match this repo layout', () => {
    // drupal FRAMEWORK_PATTERNS excludePaths are top-level (core/, modules/contrib/)
    // which do NOT exist in a web-docroot tree, so they must be filtered out.
    const treePaths = ['web', 'web/core', 'web/modules/contrib', 'vendor'];
    const seed = computeSeedExcludeGlobs({ framework: 'drupal', treePaths });
    expect(seed).not.toContain('core');
    expect(seed).not.toContain('modules/contrib');
    expect(seed).toContain('vendor'); // NO_RECURSE, present in tree
  });

  it('is ecosystem-general: seeds from .gitignore for a non-Composer (Node) repo', () => {
    const gitignore = ['node_modules/', '/dist', 'build', '.cache', '/public/assets'].join('\n');
    const treePaths = ['src', 'dist', 'build', 'public', 'public/assets', 'node_modules'];
    const seed = computeSeedExcludeGlobs({ gitignore, framework: 'nodejs', treePaths });
    expect(seed).toContain('dist'); // NO_RECURSE + gitignore
    expect(seed).toContain('build'); // NO_RECURSE + gitignore
    expect(seed).toContain('public/assets'); // gitignore-only, project-specific
    expect(seed).not.toContain('src'); // custom code stays in scope
  });
});
