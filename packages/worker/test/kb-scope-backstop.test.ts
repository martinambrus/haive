import { describe, expect, it } from 'vitest';
import {
  bodyUsesRepoSymbol,
  defaultGlobalFacets,
  extractCitedPaths,
  hasInstalledVersionAnchor,
  isLikelyRepoOwnPath,
  isRepoOwnPath,
} from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';
// techAnchorFacets moved out of 08 into _repo-stack so the workflow learning step
// (11) can reuse it; 08 now imports it from there rather than re-exporting it.
import { techAnchorFacets } from '../src/step-engine/steps/_repo-stack.js';

// Drupal layout (from FRAMEWORK_PATTERNS) — note: prefixes carry no `web/` docroot.
const DRUPAL_INCLUDE = ['modules/custom/', 'themes/custom/'];
const DRUPAL_EXCLUDE = ['core/', 'modules/contrib/', 'themes/contrib/', 'vendor/'];

describe('extractCitedPaths', () => {
  it('pulls a repo path from a code span and strips the line range', () => {
    expect(extractCitedPaths('see `web/modules/custom/foo/foo.module:13-41` for the hook')).toEqual(
      ['web/modules/custom/foo/foo.module'],
    );
  });

  it('pulls a path from plain prose and strips a leading ./', () => {
    expect(extractCitedPaths('edit ./src/auth/login.ts then rebuild')).toEqual([
      'src/auth/login.ts',
    ]);
  });

  it('ignores non-code slash-less files (manifests) and extension-less tokens; dedupes', () => {
    expect(
      extractCitedPaths('composer.json and the src/utils folder; src/a.ts, src/a.ts again'),
    ).toEqual(['src/a.ts']);
  });

  it('extracts a bare root-level source file citation (no slash)', () => {
    expect(extractCitedPaths('the helper `core_functions.php:115-161` parses input')).toContain(
      'core_functions.php',
    );
  });
});

describe('isRepoOwnPath', () => {
  it('is true for custom code under a web/ docroot', () => {
    expect(isRepoOwnPath('web/modules/custom/foo/foo.module', DRUPAL_INCLUDE, DRUPAL_EXCLUDE)).toBe(
      true,
    );
    expect(isRepoOwnPath('web/themes/custom/mytheme/x.twig', DRUPAL_INCLUDE, DRUPAL_EXCLUDE)).toBe(
      true,
    );
  });

  it('is false for contrib modules and vendored code (public, global-eligible)', () => {
    expect(
      isRepoOwnPath('web/modules/contrib/paragraphs/src/X.php', DRUPAL_INCLUDE, DRUPAL_EXCLUDE),
    ).toBe(false);
    expect(isRepoOwnPath('vendor/drupal/core/lib/Drupal.php', DRUPAL_INCLUDE, DRUPAL_EXCLUDE)).toBe(
      false,
    );
  });

  it('lets an exclude prefix win over an include prefix in nested dependency paths', () => {
    expect(isRepoOwnPath('node_modules/pkg/src/index.js', ['src/'], ['node_modules/'])).toBe(false);
  });

  it('is false when no custom prefixes are known', () => {
    expect(isRepoOwnPath('src/a.ts', [], ['vendor/'])).toBe(false);
  });
});

describe('hasInstalledVersionAnchor', () => {
  const detected = {
    packages: ['drupal/paragraphs@8', 'drupal/core@11'],
    frameworkMajor: '11',
    phpMajor: '8',
    nodeMajor: null,
    dbMajor: '10',
  };

  it('accepts a module entry whose package@major is installed', () => {
    expect(hasInstalledVersionAnchor({ packages: ['drupal/paragraphs@8'] }, detected)).toBe(true);
  });

  it('rejects a module entry whose package@major is not installed', () => {
    expect(hasInstalledVersionAnchor({ packages: ['drupal/webform@6'] }, detected)).toBe(false);
  });

  it('accepts a framework-general entry whose major matches detection', () => {
    expect(hasInstalledVersionAnchor({ frameworkMajor: ['11'] }, detected)).toBe(true);
  });

  it('accepts a PHP entry whose major matches detection; rejects a mismatch', () => {
    expect(hasInstalledVersionAnchor({ phpMajor: ['8'] }, detected)).toBe(true);
    expect(hasInstalledVersionAnchor({ phpMajor: ['7'] }, detected)).toBe(false);
  });

  it('accepts a datastore entry whose major matches detection; rejects a mismatch', () => {
    expect(hasInstalledVersionAnchor({ dbMajor: ['10'] }, detected)).toBe(true);
    expect(hasInstalledVersionAnchor({ dbMajor: ['11'] }, detected)).toBe(false);
  });

  it('rejects an entry with no version anchor at all', () => {
    expect(hasInstalledVersionAnchor({ framework: ['drupal'] }, detected)).toBe(false);
  });
});

describe('defaultGlobalFacets', () => {
  const detected = {
    framework: 'drupal',
    frameworkMajor: '11',
    language: 'php',
    projectName: 'x',
    phpMajor: '8',
    nodeMajor: null,
    database: 'mariadb',
    dbMajor: '10',
    packages: ['drupal/paragraphs@8'],
    customCode: { include: [], exclude: [] },
  } as unknown as Parameters<typeof defaultGlobalFacets>[1];

  const entry = (facets?: Record<string, string[]>) =>
    ({
      id: 'e',
      title: 'E',
      sections: [{ heading: 'H', body: 'b' }],
      facets,
    }) as unknown as Parameters<typeof defaultGlobalFacets>[0];

  it('auto-fills framework/frameworkMajor/language for a bare (framework-general) entry', () => {
    expect(defaultGlobalFacets(entry(), detected)).toEqual({
      framework: ['drupal'],
      frameworkMajor: ['11'],
      language: ['php'],
    });
  });

  it('leaves a module-scoped entry (packages present) scoped to its package only', () => {
    expect(defaultGlobalFacets(entry({ packages: ['drupal/paragraphs@8'] }), detected)).toEqual({
      packages: ['drupal/paragraphs@8'],
    });
  });

  it('stamps phpMajor on a pure-PHP entry without widening it to the framework', () => {
    expect(defaultGlobalFacets(entry({ language: ['php'] }), detected)).toEqual({
      language: ['php'],
      phpMajor: ['8'],
    });
  });

  it('stamps dbMajor on a pure-datastore entry without widening it to the framework', () => {
    expect(defaultGlobalFacets(entry({ database: ['mariadb'] }), detected)).toEqual({
      database: ['mariadb'],
      dbMajor: ['10'],
    });
  });
});

describe('techAnchorFacets', () => {
  const det = (over: Record<string, unknown>) =>
    ({
      framework: 'general',
      frameworkMajor: null,
      language: 'php',
      projectName: 'x',
      phpMajor: '8',
      nodeMajor: null,
      database: 'mariadb',
      dbMajor: '10',
      packages: ['drupal/paragraphs@8'],
      customCode: { include: [], exclude: [] },
      ...over,
    }) as unknown as Parameters<typeof techAnchorFacets>[2];

  it('anchors a PHP entry on language + the detected phpMajor', () => {
    expect(techAnchorFacets('php', {}, det({}))).toEqual({
      language: ['php'],
      phpMajor: ['8'],
    });
  });

  it('anchors a datastore entry on the installed engine + dbMajor', () => {
    expect(techAnchorFacets('mariadb', {}, det({}))).toEqual({
      database: ['mariadb'],
      dbMajor: ['10'],
    });
  });

  it('includes both engines for a mysql-tagged entry on a mariadb project', () => {
    const f = techAnchorFacets('mysql', {}, det({}));
    expect(f.dbMajor).toEqual(['10']);
    expect(new Set(f.database)).toEqual(new Set(['mariadb', 'mysql']));
  });

  it('anchors on a detected package when the tech slug matches', () => {
    expect(techAnchorFacets('paragraphs', {}, det({}))).toEqual({
      packages: ['drupal/paragraphs@8'],
    });
  });

  it('leaves an unversioned third-party tech unanchored (stays local)', () => {
    expect(techAnchorFacets('jquery', {}, det({}))).toEqual({});
  });

  it('does not anchor PHP when no php major is detected', () => {
    expect(techAnchorFacets('php', {}, det({ phpMajor: null }))).toEqual({});
  });
});

describe('isLikelyRepoOwnPath (general-project fallback)', () => {
  it('treats a root-level source file as repo-own', () => {
    expect(isLikelyRepoOwnPath('core_functions.php', [])).toBe(true);
  });

  it('excludes dependency dirs and shared manifests', () => {
    expect(isLikelyRepoOwnPath('vendor/foo/bar.php', [])).toBe(false);
    expect(isLikelyRepoOwnPath('node_modules/x/y.js', [])).toBe(false);
    expect(isLikelyRepoOwnPath('composer.json', [])).toBe(false);
  });

  it('honors framework exclude prefixes (e.g. drupal core)', () => {
    expect(isLikelyRepoOwnPath('web/core/lib/Drupal.php', ['core/'])).toBe(false);
  });
});

describe('bodyUsesRepoSymbol', () => {
  const symbols = new Set(['GetPHPVariables', 'SanitizeInput', 'MyHelperClass']);

  it('flags a call to a repo-defined function', () => {
    expect(
      bodyUsesRepoSymbol("list($u, $p) = GetPHPVariables('user', false, 'POST');", symbols),
    ).toBe('GetPHPVariables');
  });

  it('flags a new/:: reference to a repo-defined class', () => {
    expect(bodyUsesRepoSymbol('$x = new MyHelperClass();', symbols)).toBe('MyHelperClass');
  });

  it('ignores calls to non-repo (built-in) functions', () => {
    expect(bodyUsesRepoSymbol('$y = array_map($fn, $arr); isset($z);', symbols)).toBeNull();
  });

  it('returns null for an empty symbol set', () => {
    expect(bodyUsesRepoSymbol('GetPHPVariables()', new Set())).toBeNull();
  });
});
