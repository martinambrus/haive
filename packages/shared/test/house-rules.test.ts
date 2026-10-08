import { describe, expect, it } from 'vitest';
import {
  HOUSE_RULES_ALWAYS_CAP_BYTES,
  enforcementState,
  houseRuleApprovalHash,
  houseRuleBytes,
  houseRuleContentToken,
  houseRuleShortIds,
  parseEnforceSpec,
  refusedHouseRuleText,
  renderHouseRuleEntry,
  validateHouseRuleGlobs,
  type EnforceSpec,
} from '../src/global-kb/house-rules.js';

type Content = Parameters<typeof houseRuleContentToken>[0];
type StateRow = Parameters<typeof enforcementState>[0];

const FIXTURE: Content = {
  title: 'No inline SVGs',
  category: 'anti_pattern',
  description:
    'Reference SVG files from templates and stylesheets; never paste <svg> markup inline.',
  body: '# No inline SVGs\n\nUse an <img> or a CSS background — never inline <svg> markup.\n',
  facets: {
    tags: ['svg', 'frontend'],
    framework: ['drupal'],
    language: ['php'],
    packages: ['symfony/yaml', 'drupal/core'],
  },
};
const FILES: EnforceSpec = { mode: 'files', globs: ['**/*.twig', '**/*.css'] };
const ALWAYS: EnforceSpec = { mode: 'always' };

const GOLDEN = {
  token: 'hr1:4af95f21b1f6edf74f846da4afd0b019745f9a4275623d3a8191353540556633',
  files: 'hr1:6cfe840531eb09fef45d3dacb0c2a299a4b3bae5fb53e5fbb8df8e8fba10b5c9',
  always: 'hr1:c4b81530e8ba72a5d1d8993a6fb6990efb497964087ec686e5d95c23e18672b9',
};

const withFacets = (facets: Content['facets']): Content => ({ ...FIXTURE, facets });

describe('the content token and the approval hash', () => {
  it('reproduce the golden values for the fixture', () => {
    expect(houseRuleContentToken(FIXTURE)).toBe(GOLDEN.token);
    expect(houseRuleApprovalHash(FIXTURE, FILES)).toBe(GOLDEN.files);
    expect(houseRuleApprovalHash(FIXTURE, ALWAYS)).toBe(GOLDEN.always);
  });

  it('are versioned, hex, and never equal to each other for one entry', () => {
    for (const value of Object.values(GOLDEN)) expect(value).toMatch(/^hr1:[0-9a-f]{64}$/);
    expect(new Set(Object.values(GOLDEN)).size).toBe(3);
  });

  describe.each<[string, Content]>([
    [
      'the order of the facet keys',
      withFacets(Object.fromEntries(Object.entries(FIXTURE.facets).reverse())),
    ],
    [
      'the order of the values in a dimension',
      withFacets({ ...FIXTURE.facets, packages: ['drupal/core', 'symfony/yaml'] }),
    ],
    ['other tags', withFacets({ ...FIXTURE.facets, tags: ['x'] })],
    ['no tags', withFacets({ ...FIXTURE.facets, tags: undefined })],
    [
      'a legacy padded, mixed-case, duplicated value',
      withFacets({ ...FIXTURE.facets, framework: [' Drupal ', 'drupal'] }),
    ],
    ['an empty dimension', withFacets({ ...FIXTURE.facets, database: [] })],
    ['an orphan major', withFacets({ ...FIXTURE.facets, dbMajor: ['10'] })],
  ])('are unchanged by %s', (_name, row) => {
    it('in all three values', () => {
      expect(houseRuleContentToken(row)).toBe(GOLDEN.token);
      expect(houseRuleApprovalHash(row, FILES)).toBe(GOLDEN.files);
      expect(houseRuleApprovalHash(row, ALWAYS)).toBe(GOLDEN.always);
    });
  });

  it('are unchanged by the order of the globs and by a repeated glob', () => {
    expect(
      houseRuleApprovalHash(FIXTURE, {
        mode: 'files',
        globs: ['**/*.css', '**/*.twig', '**/*.css'],
      }),
    ).toBe(GOLDEN.files);
  });

  it('are unchanged by the extra keys a stored value may carry', () => {
    const stored = parseEnforceSpec({ mode: 'always', globs: ['x'], note: 'y' });
    expect(houseRuleApprovalHash(FIXTURE, stored!)).toBe(GOLDEN.always);
  });

  describe.each<[string, Content]>([
    ['one more character in the title', { ...FIXTURE, title: `${FIXTURE.title}x` }],
    ['a trailing space in the title', { ...FIXTURE, title: `${FIXTURE.title} ` }],
    ['the category', { ...FIXTURE, category: 'best_practice' }],
    ['the description', { ...FIXTURE, description: `${FIXTURE.description} Really.` }],
    ['no description', { ...FIXTURE, description: null }],
    ['a trailing newline in the body', { ...FIXTURE, body: `${FIXTURE.body}\n` }],
    ['CRLF line breaks in the body', { ...FIXTURE, body: FIXTURE.body.replaceAll('\n', '\r\n') }],
    ['another language', withFacets({ ...FIXTURE.facets, language: ['javascript'] })],
    ['a PHP major', withFacets({ ...FIXTURE.facets, phpMajor: ['8'] })],
    ['a Node major', withFacets({ ...FIXTURE.facets, nodeMajor: ['22'] })],
    ['a package', withFacets({ ...FIXTURE.facets, packages: ['drupal/core'] })],
  ])('both change with %s', (_name, row) => {
    it('and stay apart from the golden values', () => {
      expect(houseRuleContentToken(row)).not.toBe(GOLDEN.token);
      expect(houseRuleApprovalHash(row, FILES)).not.toBe(GOLDEN.files);
      expect(houseRuleApprovalHash(row, ALWAYS)).not.toBe(GOLDEN.always);
    });
  });

  it('the approval hash changes with the mode and with the globs', () => {
    const hashes = [
      FILES,
      ALWAYS,
      { mode: 'files', globs: ['**/*.twig'] },
      { mode: 'files', globs: ['**/*.twig', '**/*.css', '**/*.js'] },
      { mode: 'files', globs: ['**/*.twig', '**/*.scss'] },
    ].map((spec) => houseRuleApprovalHash(FIXTURE, spec as EnforceSpec));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('keep two different entries apart even when their fields would run together', () => {
    const a = houseRuleContentToken({ ...FIXTURE, title: 'ab', category: 'general' });
    const b = houseRuleContentToken({ ...FIXTURE, title: 'a', category: 'bgeneral' as never });
    expect(a).not.toBe(b);
  });
});

describe('refusedHouseRuleText', () => {
  const HIDDEN: Array<[string, number]> = [
    ['NUL', 0x0000],
    ['CR', 0x000d],
    ['VT', 0x000b],
    ['FF', 0x000c],
    ['ESC', 0x001b],
    ['DEL', 0x007f],
    ['NEL', 0x0085],
    ['CSI', 0x009b],
    ['zero-width space', 0x200b],
    ['zero-width non-joiner', 0x200c],
    ['zero-width joiner', 0x200d],
    ['LRM', 0x200e],
    ['RLM', 0x200f],
    ['LRE', 0x202a],
    ['RLO', 0x202e],
    ['LRI', 0x2066],
    ['PDI', 0x2069],
    ['word joiner', 0x2060],
    ['BOM', 0xfeff],
    ['soft hyphen', 0x00ad],
    ['Arabic letter mark', 0x061c],
    ['line separator', 0x2028],
    ['paragraph separator', 0x2029],
    ['TAG LATIN A', 0xe0041],
    ['variation selector 16', 0xfe0f],
    ['variation selector 17', 0xe0100],
    ['combining grapheme joiner', 0x034f],
    ['Hangul filler', 0x3164],
    ['Arabic number sign, a format character only Cf names', 0x0600],
    ['interlinear annotation anchor, likewise', 0xfff9],
  ];

  it.each(HIDDEN)('refuses %s and names its code point', (_name, codePoint) => {
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    const reason = refusedHouseRuleText(`before${String.fromCodePoint(codePoint)}after`);
    expect(reason).toContain(label);
    expect(reason).toContain('line 1');
  });

  it('refuses a lone surrogate and names it', () => {
    expect(refusedHouseRuleText('a\ud800b')).toContain('U+D800');
    expect(refusedHouseRuleText('a\udc00b')).toContain('U+DC00');
    expect(refusedHouseRuleText('one\ntwo\ud800')).toContain('line 2');
    expect(refusedHouseRuleText('a\u{1f600}b')).toBeNull();
  });

  it('says which line holds the character', () => {
    expect(refusedHouseRuleText('one\ntwo\n\u{202E}three')).toContain('line 3');
  });

  it.each([
    ['a tab', 'a\tb'],
    ['a line feed', 'a\nb'],
    ['an em dash', 'a — b'],
    ['an arrow', 'a → b'],
    ['a no-break space', 'a\u{A0}b'],
    ['a plus-minus sign', '±1'],
    ['an astral character', 'a \u{1f600} b'],
    ['a realistic body', FIXTURE.body],
    ['a word that begins like the product', 'Haive is great'],
    ['an empty string', ''],
  ])('allows %s', (_name, text) => {
    expect(refusedHouseRuleText(text)).toBeNull();
  });

  describe('the delimiters Haive prompts use', () => {
    const MARKERS = [
      '<haive_agent_rules>',
      '</haive_agent_rules>',
      '<haive_global_kb_index>',
      '</haive_global_kb_index>',
      '<haive_model_capability_boundary>',
      '</haive_model_capability_boundary>',
      '<haive_ddev_generated_boundary>',
      '</haive_ddev_generated_boundary>',
      '<haive_worktree_git_boundary>',
      '</haive_worktree_git_boundary>',
      '<haive_app_reach>',
      '</haive_app_reach>',
      '<haive_mcp_surface>',
      '</haive_mcp_surface>',
      '[[HAIVE_AGENT_DEFINITION:id]]',
      '[[HAIVE_AGENT_DEFINITION_END]]',
      '[[HAIVE_PASTED_PERSONA:',
      '===== BEGIN UNTRUSTED AGENT TEXT =====',
      '===== END UNTRUSTED AGENT TEXT =====',
      '<!-- haive:cli-rules -->',
      '<!-- /haive:cli-rules -->',
      '<!-- haive:project-info -->',
      '<!-- /haive:project-info -->',
      '<!-- haive:rtk-ref -->',
      '<!-- /haive:rtk-ref -->',
    ];

    it.each(MARKERS)('refuses %s, alone and quoted on a later line', (marker) => {
      expect(refusedHouseRuleText(marker)).not.toBeNull();
      expect(refusedHouseRuleText(`# Rule\n\nNever write ${marker} here.`)).toContain('line 3');
    });

    it.each(MARKERS)('refuses %s in any letter case', (marker) => {
      expect(refusedHouseRuleText(marker.toUpperCase())).not.toBeNull();
      expect(refusedHouseRuleText(marker.toLowerCase())).not.toBeNull();
    });

    it('names the delimiter it found', () => {
      expect(refusedHouseRuleText('x\nuse <haive_agent_rules> here')).toContain(
        '<haive_agent_rules>',
      );
    });

    it('tells a person who underlined a heading to use a # heading', () => {
      expect(refusedHouseRuleText('Title\n=====\n')).toContain('#');
    });

    it('refuses four equals signs and allows three', () => {
      expect(refusedHouseRuleText('a ==== b')).not.toBeNull();
      expect(refusedHouseRuleText('a === b')).toBeNull();
    });

    it.each([
      ['an unrelated tag', '<haiku>'],
      ['the product name in prose', 'Haive is great'],
      ['a comparison', 'a === b'],
      ['svg markup', '<svg viewBox="0 0 1 1"></svg>'],
      ['an identifier', 'use haive_foo()'],
      ['a dashed divider', '--- divider ---'],
      ['a setext second-level heading', 'Heading\n---\n'],
    ])('allows %s', (_name, text) => {
      expect(refusedHouseRuleText(text)).toBeNull();
    });
  });
});

describe('validateHouseRuleGlobs', () => {
  const BRACE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.';
  const bracedChars = (count: number): string => `{${[...BRACE_CHARS].slice(0, count).join(',')}}`;

  it.each([
    ['a glob that matches by extension', ['**/*.twig']],
    ['brace alternatives that name something', ['**/*.{css,scss}']],
    ['a directory', ['web/themes/**']],
    ['one file', ['composer.json']],
    ['a root-level wildcard', ['*.md']],
    ['an alternative before the wildcard', ['{src,lib}/**']],
    ['an empty alternative', ['file{,.bak}']],
    ['an optional directory prefix in a brace group', ['{src/,}*.tpl.php']],
    ['a brace alternative that holds a nested path', ['{src,lib/x}/**']],
    ['whitespace inside a brace alternative', ['{My Docs,lib}/**']],
    ['whitespace outside any brace group', ['docs/My File.md']],
    ['a comma outside any brace group', ['a, b/**']],
    ['an extension group after a globstar', ['**/*.{twig,css}']],
    ['several brace groups that each name something', ['{src,lib}/**/*.{php,inc}']],
    ['a nested brace group', ['src/{a,{b,c}}/**']],
    ['an empty alternative whose directory names something', ['src/{a,{b,}}*']],
    ['a nested wildcard alternative inside a named directory', ['src/{a,{b,*}}']],
    ['a wildcard alternative in a later group, after named directories', ['{a,b}/{c,*}']],
    ['sixty-four brace expansions', ['{a,b}'.repeat(6)]],
    ['a group of sixty-four alternatives', [bracedChars(64)]],
    ['seven nested groups with eight distinct expansions', ['{a,{b,{c,{d,{e,{f,{g,h}}}}}}}']],
    ['two globs', ['**/*.twig', '**/*.css']],
    ['the same glob twice', ['**/*.twig', '**/*.twig']],
    ['twenty globs', Array.from({ length: 20 }, (_, i) => `dir${i}/**`)],
    ['two hundred characters', [`${'a'.repeat(197)}/**`]],
  ])('accepts %s', (_name, globs) => {
    expect(validateHouseRuleGlobs(globs)).toBeNull();
  });

  const REFUSED: Array<[string, string, string]> = [
    ['an empty glob', '', 'is empty'],
    ['a leading space', ' **/*.twig', 'whitespace'],
    ['a trailing space', '**/*.twig ', 'whitespace'],
    ['a leading no-break space', '\u{A0}**/*.twig', 'whitespace'],
    ['a space after a comma in a brace group', '{src, lib}/**', 'has the brace alternative'],
    ['a space before a comma in a brace group', '{src ,lib}/**', 'has the brace alternative'],
    ['a space after the opening brace', '{ src,lib}/**', 'has the brace alternative'],
    ['a space in a nested brace group', 'src/{a,{b, c}}/x', 'has the brace alternative'],
    ['a no-break space in a brace alternative', '{a,\u{A0}b}/x', 'has the brace alternative'],
    ['an absolute path', '/src/**', 'path segment'],
    ['a ./ prefix', './src/**', 'path segment'],
    ['a trailing slash', 'src/', 'path segment'],
    ['a doubled slash', 'a//b', 'path segment'],
    ['a parent segment', '../x', 'path segment'],
    ['a parent segment inside', 'a/../b', 'path segment'],
    ['an absolute path as a brace alternative', '{,src}/README.md', 'path segment'],
    ['a ./ prefix as a brace alternative', '{.,src}/README.md', 'path segment'],
    ['a doubled slash from an empty brace alternative', 'src/{a,}/x', 'path segment'],
    ['a trailing slash inside a brace alternative', 'src/{a/,b}', 'path segment'],
    ['an absolute path in a nested brace group', '{a,{b,/c}}/x', 'path segment'],
    ['a backslash', 'src\\*.ts', 'backslash'],
    ['a leading negation', '!src/**', 'negation'],
    ['an extglob negation', '!(*.md)', 'negation'],
    ['an extglob negation inside a path', '**/!(*.md)', 'negation'],
    ['a negation inside a brace', '{!(a),b}/**', 'negation'],
    ['every path', '**', 'every file'],
    ['every file', '**/*', 'every file'],
    ['every root-level file', '*', 'every file'],
    ['a wildcard-only brace alternative', '{**,x}', 'every file'],
    ['a wildcard-only alternative once a nested group is resolved', '{{a,b},*}', 'every file'],
    ['a bracket class standing for any letter', '[a-z]*', 'every file'],
    ['a bracket class after a globstar', '**/[a-z]*', 'every file'],
    ['an empty alternative beside a literal one', '**/{foo,}*', 'every file'],
    ['an alternative that expands to a bare globstar', '{src/**,**}', 'every file'],
    ['a wildcard alternative beside a literal one', '**/{*,x}', 'every file'],
    ['an empty leading alternative', '{,src/}**', 'every file'],
    ['an empty alternative in a nested group', '{a,{b,}}*', 'every file'],
    ['an empty alternative in each of two groups', '{a,}{b,}*', 'every file'],
    ['an extglob around a wildcard', '@(*)', 'every file'],
    ['an extglob alternative that is a wildcard', '**/@(fixed|*)', 'extglob'],
    ['a one-or-more extglob', 'src/+(a|*)', 'extglob'],
    ['a zero-or-more extglob', 'src/*(a|*)', 'extglob'],
    ['a zero-or-one extglob', 'src/?(a|*)/x', 'extglob'],
    ['an extglob in a brace alternative', '{a,b@(c|*)}/x', 'extglob'],
    ['an alternation bar outside any group', '**/*|b', 'uses "|"'],
    ['a group holding a wildcard alternative', '**/(a|*)', 'uses "("'],
    ['a plain group of characters', 'src/(a)/**', 'uses "("'],
    ['a closing parenthesis alone', 'src/a)/**', 'uses ")"'],
    ['a brace range', '**/{a..z}*', 'brace range'],
    ['a brace range beside a comma', '**/{a..z,b}*', 'brace range'],
    ['a double quote after a wildcard', '**/*"', 'double quote'],
    ['a quoted name before a globstar', '"a"**', 'double quote'],
    ['a zero-width space', 'src/\u{200B}**', 'U+200B'],
    ['a marker', '<haive_x>/**', '<haive_x>'],
    ['a tab', 'a\tb/**', 'tab or line break'],
    ['a line break', 'a\nb/**', 'tab or line break'],
  ];

  it.each(REFUSED)('refuses %s and names the glob', (_name, glob, fragment) => {
    const reason = validateHouseRuleGlobs([glob]);
    expect(reason).toContain(fragment);
    if (glob !== '' && !/[\t\n]/.test(glob)) expect(reason).toContain(JSON.stringify(glob));
  });

  it('names the brace expansion that has the bad path segment', () => {
    expect(validateHouseRuleGlobs(['{,src}/README.md'])).toContain('expands to "/README.md"');
    expect(validateHouseRuleGlobs(['{.,src}/README.md'])).toContain('expands to "./README.md"');
  });

  it('names the brace alternative that starts or ends with whitespace', () => {
    expect(validateHouseRuleGlobs(['{src, lib}/**'])).toContain(
      'has the brace alternative " lib",',
    );
  });

  it('refuses a glob of more than 200 characters', () => {
    expect(validateHouseRuleGlobs([`${'a'.repeat(198)}/**`])).toContain('200');
    expect(validateHouseRuleGlobs(['a'.repeat(201)])).toContain('200');
  });

  it('refuses a glob with more than 64 brace expansions, naming it and without expanding it', () => {
    const glob = '{a,b}'.repeat(40);
    expect(glob).toHaveLength(200);
    const reason = validateHouseRuleGlobs([glob]);
    expect(reason).toContain('64');
    expect(reason).toContain(JSON.stringify(glob));
    expect(reason).not.toContain('every file');
    expect(validateHouseRuleGlobs(['{a,b}'.repeat(7)])).toContain('64');
    expect(validateHouseRuleGlobs([bracedChars(65)])).toContain('64');
  });

  it('refuses no globs and more than twenty', () => {
    expect(validateHouseRuleGlobs([])).toContain('at least one');
    expect(validateHouseRuleGlobs(Array.from({ length: 21 }, (_, i) => `dir${i}/**`))).toContain(
      '20',
    );
  });

  it('reports the first glob that fails, not a later one', () => {
    const reason = validateHouseRuleGlobs(['**/*.twig', 'a//b', '**']);
    expect(reason).toContain('"a//b"');
  });
});

describe('parseEnforceSpec', () => {
  it('reads the two shapes', () => {
    expect(parseEnforceSpec({ mode: 'always' })).toEqual({ mode: 'always' });
    expect(parseEnforceSpec({ mode: 'files', globs: ['**/*.twig'] })).toEqual({
      mode: 'files',
      globs: ['**/*.twig'],
    });
  });

  it('keeps only what the mode names', () => {
    expect(parseEnforceSpec({ mode: 'always', globs: ['x'], by: 'y' })).toStrictEqual({
      mode: 'always',
    });
  });

  it('returns a copy of the globs', () => {
    const globs = ['**/*.twig'];
    const spec = parseEnforceSpec({ mode: 'files', globs });
    globs.push('**/*.css');
    expect(spec).toEqual({ mode: 'files', globs: ['**/*.twig'] });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'always'],
    ['a number', 1],
    ['an array', [{ mode: 'always' }]],
    ['an empty object', {}],
    ['an unknown mode', { mode: 'sometimes' }],
    ['a mode of another case', { mode: 'ALWAYS' }],
    ['files without globs', { mode: 'files' }],
    ['files with no globs', { mode: 'files', globs: [] }],
    ['files with a string for globs', { mode: 'files', globs: '**/*.twig' }],
    ['files with a non-string glob', { mode: 'files', globs: ['**/*.twig', 1] }],
  ])('returns null for %s', (_name, value) => {
    expect(parseEnforceSpec(value)).toBeNull();
  });
});

describe('enforcementState', () => {
  const ctx = { namespace: 'default', houseRulesEnabled: true };
  const row = (over: Partial<StateRow> = {}): StateRow => ({
    ...FIXTURE,
    namespace: 'default',
    status: 'active',
    supersededAt: null,
    enforce: FILES,
    enforcedHash: houseRuleApprovalHash(FIXTURE, FILES),
    ...over,
  });
  const stateOf = (over: Partial<StateRow> = {}, context = ctx) =>
    enforcementState(row(over), context);

  describe('one case per state', () => {
    it('none: it was never enforced', () => {
      expect(stateOf({ enforce: null, enforcedHash: null })).toEqual({ state: 'none' });
    });

    it('none: what is stored as its settings is not a spec', () => {
      expect(stateOf({ enforce: 'always' }).state).toBe('none');
      expect(stateOf({ enforce: { mode: 'files', globs: [] } }).state).toBe('none');
    });

    it('other_namespace: the entry belongs to another corpus', () => {
      expect(stateOf({ namespace: 'other' }).state).toBe('other_namespace');
    });

    it('superseded: it was archived because another entry replaced it', () => {
      expect(stateOf({ status: 'archived', supersededAt: new Date() }).state).toBe('superseded');
    });

    it('cleared: the approval is gone and the settings stay', () => {
      expect(stateOf({ enforcedHash: null }).state).toBe('cleared');
    });

    it('not_active: a hash on an entry that is not active', () => {
      expect(stateOf({ status: 'draft' }).state).toBe('not_active');
      expect(stateOf({ status: 'archived' }).state).toBe('not_active');
    });

    it('edited: the text or the settings moved since the approval', () => {
      expect(stateOf({ body: `${FIXTURE.body}x` }).state).toBe('edited');
      expect(stateOf({ title: 'Renamed' }).state).toBe('edited');
      expect(stateOf({ facets: { ...FIXTURE.facets, language: ['go'] } }).state).toBe('edited');
      expect(stateOf({ enforce: { mode: 'files', globs: ['**/*.js'] } }).state).toBe('edited');
      expect(stateOf({ enforce: ALWAYS }).state).toBe('edited');
    });

    it('switched_off: the instance switch is off', () => {
      expect(stateOf({}, { ...ctx, houseRulesEnabled: false }).state).toBe('switched_off');
    });

    it('enforced: a files rule carries its mode and globs', () => {
      expect(stateOf()).toEqual({ state: 'enforced', mode: 'files', globs: FILES.globs });
    });

    it('enforced: an always rule carries its mode', () => {
      expect(
        stateOf({ enforce: ALWAYS, enforcedHash: houseRuleApprovalHash(FIXTURE, ALWAYS) }),
      ).toStrictEqual({ state: 'enforced', mode: 'always' });
    });

    it('enforced: a tag or key-order change is not an edit', () => {
      const same = {
        facets: { ...FIXTURE.facets, tags: ['other'], packages: ['drupal/core', 'symfony/yaml'] },
      };
      expect(stateOf(same).state).toBe('enforced');
    });
  });

  it('carries no mode or globs on any state but enforced', () => {
    const lapsed = [
      stateOf({ namespace: 'other' }),
      stateOf({ status: 'archived', supersededAt: new Date() }),
      stateOf({ enforcedHash: null }),
      stateOf({ status: 'draft' }),
      stateOf({ body: 'x' }),
      stateOf({}, { ...ctx, houseRulesEnabled: false }),
      stateOf({ enforce: null }),
    ];
    for (const result of lapsed) expect(Object.keys(result)).toEqual(['state']);
  });

  describe('precedence', () => {
    it('none beats every other reason', () => {
      expect(
        stateOf({ enforce: null, namespace: 'other', status: 'archived', supersededAt: new Date() })
          .state,
      ).toBe('none');
    });

    it('superseded beats other_namespace', () => {
      expect(
        stateOf({ namespace: 'other', status: 'archived', supersededAt: new Date() }).state,
      ).toBe('superseded');
    });

    it('cleared beats other_namespace, since no approval is left to resume', () => {
      expect(stateOf({ namespace: 'other', enforcedHash: null }).state).toBe('cleared');
    });

    it('not_active beats other_namespace', () => {
      expect(stateOf({ namespace: 'other', status: 'draft' }).state).toBe('not_active');
    });

    it('edited beats other_namespace, since the text is no longer the approved one', () => {
      expect(stateOf({ namespace: 'other', body: 'x' }).state).toBe('edited');
    });

    it('other_namespace reads an approval that is otherwise valid', () => {
      expect(stateOf({ namespace: 'other' }).state).toBe('other_namespace');
    });

    it('other_namespace beats switched_off', () => {
      const off = { ...ctx, houseRulesEnabled: false };
      expect(stateOf({ namespace: 'other' }, off).state).toBe('other_namespace');
    });

    it('superseded beats cleared, though the archive that superseded it cleared the hash', () => {
      expect(
        stateOf({ status: 'archived', supersededAt: new Date(), enforcedHash: null }).state,
      ).toBe('superseded');
    });

    it('an archive that nothing replaced is cleared, not superseded', () => {
      expect(stateOf({ status: 'archived', enforcedHash: null }).state).toBe('cleared');
    });

    it('an active row is not superseded whatever its supersededAt says', () => {
      expect(stateOf({ supersededAt: new Date() }).state).toBe('enforced');
    });

    it('cleared beats not_active', () => {
      expect(stateOf({ status: 'draft', enforcedHash: null }).state).toBe('cleared');
    });

    it('not_active beats edited', () => {
      expect(stateOf({ status: 'draft', body: 'x' }).state).toBe('not_active');
    });

    it('edited beats switched_off', () => {
      expect(stateOf({ body: 'x' }, { ...ctx, houseRulesEnabled: false }).state).toBe('edited');
    });
  });
});

describe('renderHouseRuleEntry and houseRuleBytes', () => {
  const entry = {
    title: 'Use  X\n',
    category: 'best_practice' as const,
    description: 'Why   it\nmatters',
    body: '# Use X\n\nBody.',
  };
  const always: { enforce: EnforceSpec; shortId: string } = {
    enforce: { mode: 'always' },
    shortId: '42ac658a',
  };
  const files: { enforce: EnforceSpec; shortId: string } = {
    enforce: { mode: 'files', globs: ['**/*.twig', '**/*.css'] },
    shortId: '42ac658a',
  };
  const NBSP = String.fromCharCode(0xa0);
  const END = '</haive_house_rules>';

  it('puts the rule heading, the category, the collapsed description, the scope, a blank line and the body', () => {
    expect(renderHouseRuleEntry(entry, always)).toBe(
      '### Rule 42ac658a: Use X\nCategory: Best practice\nWhy it matters\nApplies to every change.\n\n# Use X\n\nBody.',
    );
  });

  it('names the globs of a files rule, each once and in sorted order', () => {
    expect(renderHouseRuleEntry(entry, files)).toBe(
      '### Rule 42ac658a: Use X\nCategory: Best practice\nWhy it matters\nApplies to files matching: **/*.css, **/*.twig\n\n# Use X\n\nBody.',
    );
    const repeated: EnforceSpec = { mode: 'files', globs: ['b/**', 'a/**', 'b/**'] };
    expect(renderHouseRuleEntry(entry, { ...files, enforce: repeated })).toContain(
      '\nApplies to files matching: a/**, b/**\n',
    );
  });

  it.each([
    ['general', 'General'],
    ['tech_pattern', 'Tech pattern'],
    ['anti_pattern', 'Anti-pattern'],
    ['best_practice', 'Best practice'],
    ['quick_reference', 'Quick reference'],
  ] as const)(
    'gives a %s entry the line "Category: %s" and leaves its title as it is',
    (category, label) => {
      const lines = renderHouseRuleEntry({ ...entry, category }, always).split('\n');
      expect(lines.slice(0, 2)).toEqual(['### Rule 42ac658a: Use X', `Category: ${label}`]);
    },
  );

  it('prints a category it does not know as stored, on one line', () => {
    const unknown = { ...entry, category: 'run\nbook' as never };
    expect(renderHouseRuleEntry(unknown, always).split('\n')[1]).toBe('Category: run book');
  });

  it.each([
    [
      'an indented code block',
      '    indented();\n    code();',
      '### Rule 42ac658a: Use X\nCategory: Best practice\nWhy it matters\nApplies to every change.\n\n    indented();\n    code();',
      117,
    ],
    [
      'leading blank lines',
      '\n\n# Use X',
      '### Rule 42ac658a: Use X\nCategory: Best practice\nWhy it matters\nApplies to every change.\n\n\n\n# Use X',
      99,
    ],
    [
      'trailing whitespace',
      'Body.  \n \t\n',
      '### Rule 42ac658a: Use X\nCategory: Best practice\nWhy it matters\nApplies to every change.\n\nBody.  \n \t\n',
      101,
    ],
    [
      'a no-break space at either end',
      `${NBSP}Body.${NBSP}`,
      `### Rule 42ac658a: Use X\nCategory: Best practice\nWhy it matters\nApplies to every change.\n\n${NBSP}Body.${NBSP}`,
      99,
    ],
  ])(
    'renders a body with %s byte for byte, and houseRuleBytes counts it',
    (_name, body, text, bytes) => {
      const row = { ...entry, body };
      expect(renderHouseRuleEntry(row, always)).toBe(text);
      expect(houseRuleBytes(row, always)).toBe(bytes);
      expect(houseRuleBytes(row, always)).toBe(
        Buffer.byteLength(renderHouseRuleEntry(row, always), 'utf8'),
      );
    },
  );

  it('leaves the description line out when there is none', () => {
    const bare =
      '### Rule 42ac658a: Use X\nCategory: Best practice\nApplies to every change.\n\n# Use X\n\nBody.';
    expect(renderHouseRuleEntry({ ...entry, description: null }, always)).toBe(bare);
    expect(renderHouseRuleEntry({ ...entry, description: ' \n ' }, always)).toBe(bare);
  });

  it.each<Content['category']>([
    'general',
    'tech_pattern',
    'anti_pattern',
    'best_practice',
    'quick_reference',
  ])(
    'heads an entry of category %s with its collapsed title alone, the category on its own line',
    (category) => {
      const [heading, categoryLine] = renderHouseRuleEntry({ ...entry, category }, always).split(
        '\n',
      );

      expect(heading).toBe('### Rule 42ac658a: Use X');
      expect(categoryLine).toMatch(/^Category: \S/);
    },
  );

  it('does not turn a title worded as a prohibition into its opposite', () => {
    const row = { ...entry, title: 'no inline svgs', category: 'anti_pattern' as const };

    expect(renderHouseRuleEntry(row, always).split('\n').slice(0, 2)).toEqual([
      '### Rule 42ac658a: no inline svgs',
      'Category: Anti-pattern',
    ]);
  });

  it('cannot be turned into more lines by a title, a description or a glob', () => {
    const lines = renderHouseRuleEntry(
      { ...entry, title: 'a\n### injected', description: 'b\n\n### injected' },
      { ...files, enforce: { mode: 'files', globs: ['c\n### injected'] } },
    ).split('\n');
    expect(lines.slice(0, 5)).toEqual([
      '### Rule 42ac658a: a ### injected',
      'Category: Best practice',
      'b ### injected',
      'Applies to files matching: c ### injected',
      '',
    ]);
  });

  it('neutralises the closing marker of the block wherever a field holds it', () => {
    const text = renderHouseRuleEntry(
      {
        title: `a ${END} b`,
        category: 'best_practice',
        description: `c ${END}`,
        body: `before ${END} after\n${END}`,
      },
      { ...files, enforce: { mode: 'files', globs: [`src/${END}/**`] } },
    );
    expect(text).toBe(
      '### Rule 42ac658a: a <\\/haive_house_rules> b\nCategory: Best practice\nc <\\/haive_house_rules>\nApplies to files matching: src/<\\/haive_house_rules>/**\n\nbefore <\\/haive_house_rules> after\n<\\/haive_house_rules>',
    );
    expect(text).not.toContain(END);
  });

  it('leaves an opening marker as it is, since only a close can end a block early', () => {
    const body = '<haive_house_rules>\nquoted';
    expect(renderHouseRuleEntry({ ...entry, body }, always).endsWith(`\n\n${body}`)).toBe(true);
  });

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    const accented = { title: 'é', category: 'general' as const, description: null, body: 'b' };
    expect(renderHouseRuleEntry(accented, always)).toBe(
      '### Rule 42ac658a: é\nCategory: General\nApplies to every change.\n\nb',
    );
    expect(renderHouseRuleEntry(accented, always).length).toBe(66);
    expect(houseRuleBytes(accented, always)).toBe(67);
    expect(houseRuleBytes({ ...accented, title: '\u{1f600}' }, always)).toBe(69);
  });

  it('is the length of exactly what renderHouseRuleEntry returns, whatever the scope', () => {
    for (const opts of [always, files]) {
      expect(houseRuleBytes(entry, opts)).toBe(
        Buffer.byteLength(renderHouseRuleEntry(entry, opts), 'utf8'),
      );
    }
  });

  it('counts the byte the escape adds, and the digits of a longer short id', () => {
    const quoted = { ...entry, body: `x ${END} y` };
    const sameLength = { ...entry, body: `x ${'#'.repeat(END.length)} y` };
    expect(houseRuleBytes(quoted, always)).toBe(houseRuleBytes(sameLength, always) + 1);
    expect(houseRuleBytes(entry, { ...always, shortId: '42ac658a1' })).toBe(
      houseRuleBytes(entry, always) + 1,
    );
  });

  it('has an always-cap of 8000 bytes', () => {
    expect(HOUSE_RULES_ALWAYS_CAP_BYTES).toBe(8000);
  });
});

describe('houseRuleShortIds', () => {
  const A = '42ac658a-1111-4111-8111-111111111111';
  const A2 = '42ac658a-1111-4111-8111-111111111112';
  const D = '42ac658a-2222-4222-8222-222222222222';
  const B = '9f3e0b7c-3333-4333-8333-333333333333';
  const hex = (id: string): string => id.replaceAll('-', '');

  it('is the first 8 hex digits of each uuid when no two ids share them', () => {
    expect(houseRuleShortIds([A, B])).toEqual(
      new Map([
        [A, '42ac658a'],
        [B, '9f3e0b7c'],
      ]),
    );
    expect(houseRuleShortIds([A])).toEqual(new Map([[A, '42ac658a']]));
  });

  it('widens only the ids that collide, by the digits that tell them apart', () => {
    const ids = houseRuleShortIds([A, D, B]);
    expect(ids.get(A)).toBe('42ac658a1');
    expect(ids.get(D)).toBe('42ac658a2');
    expect(ids.get(B)).toBe('9f3e0b7c');
  });

  it('widens two ids that differ only in the last digit to all 32', () => {
    const ids = houseRuleShortIds([A, A2, B]);
    expect(ids.get(A)).toBe(hex(A));
    expect(ids.get(A2)).toBe(hex(A2));
    expect(ids.get(B)).toBe('9f3e0b7c');
  });

  it('depends on the set it is given, not on every id there is', () => {
    expect(houseRuleShortIds([A, B]).get(A)).toBe('42ac658a');
    expect(houseRuleShortIds([A, D]).get(A)).toBe('42ac658a1');
  });

  it('gives one id given twice its 8 digits, and answers every id it was given', () => {
    const ids = houseRuleShortIds([A, A, B]);
    expect([...ids.keys()]).toEqual([A, B]);
    expect(ids.get(A)).toBe('42ac658a');
  });
});
