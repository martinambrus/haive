import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import { namedFiles, resolveNamedFiles } from './named-files.js';

const TEMPLATE = 'sites/all/modules/custom/hr6_badges/templates/hr6-badges-product-title.tpl.php';

// The text of a live quick_bugfix (task ea88adcf) whose first write dispatch had an empty change.
const LIVE_TITLE = 'Verified products show no verified marker';
const LIVE_DESCRIPTION = [
  'The product title template of the hr6_badges module receives `$verified` but ignores it, so shoppers cannot tell verified products apart.',
  '',
  `Fix: in \`${TEMPLATE}\`, when \`$verified\` is TRUE show a small green SVG checkmark icon (about 1em tall) before the title text, announced to screen readers as "Verified product". Style it in the module's \`css/hr6_badges.css\`. Unverified products must render exactly as they do today.`,
  '',
  'The attached design notes give the colour and the size.',
].join('\n');

const SEGMENT_255 = `css/${'x'.repeat(255)}/a.css`;

describe('namedFiles', () => {
  it('reads exactly the two paths the description of a live quick_bugfix names', () => {
    expect(namedFiles(LIVE_DESCRIPTION)).toEqual([TEMPLATE, 'css/hr6_badges.css']);
    expect(namedFiles(`${LIVE_TITLE}\n\n${LIVE_DESCRIPTION}`)).toEqual([
      TEMPLATE,
      'css/hr6_badges.css',
    ]);
    expect(namedFiles(LIVE_TITLE)).toEqual([]);
  });

  it.each([
    ['a path', 'css/a.css', 'css/a.css'],
    ['backticks', '`css/a.css`', 'css/a.css'],
    ['bold', '**css/a.css**', 'css/a.css'],
    ['italics with a star', '*css/a.css*', 'css/a.css'],
    ['italics with underscores', '_css/a.css_', 'css/a.css'],
    ['parentheses', '(css/a.css)', 'css/a.css'],
    ['double quotes', '"css/a.css"', 'css/a.css'],
    ['single quotes', "'css/a.css'", 'css/a.css'],
    ['angle brackets', '<css/a.css>', 'css/a.css'],
    ['square brackets', '[css/a.css]', 'css/a.css'],
    ['a comma after it', 'css/a.css,', 'css/a.css'],
    ['a period after it', 'css/a.css.', 'css/a.css'],
    ['a semicolon after it', 'css/a.css;', 'css/a.css'],
    ['a colon after it', 'css/a.css:', 'css/a.css'],
    ['an exclamation mark after it', 'css/a.css!', 'css/a.css'],
    ['a question mark after it', 'css/a.css?', 'css/a.css'],
    ['a parenthesis then a period', '(see css/a.css).', 'css/a.css'],
    ['a line number', 'css/a.css:42', 'css/a.css'],
    ['a range of lines', 'css/a.css:42-50', 'css/a.css'],
    ['a line and a column', 'css/a.css:42:7', 'css/a.css'],
    ['an anchor to a line', 'css/a.css#L42', 'css/a.css'],
    ['an anchor to a range of lines', 'css/a.css#L42-L50', 'css/a.css'],
    ['a heading anchor', 'docs/a.md#install', 'docs/a.md'],
    ['a heading anchor on a bare name', 'a.md#install', 'a.md'],
    ['a heading anchor with dots', 'docs/a.md#v1.2-notes', 'docs/a.md'],
    ['a heading anchor then a period', 'docs/a.md#install.', 'docs/a.md'],
    ['a heading anchor after a route group', 'app/(app)/readme.md#usage', 'app/(app)/readme.md'],
    ['a heading anchor on a markdown link target', '[the guide](docs/a.md#install)', 'docs/a.md'],
    ['the sandbox working directory', `${SANDBOX_WORKDIR}/css/a.css`, 'css/a.css'],
    ['a leading ./', './css/a.css', 'css/a.css'],
    ['two leading ./', '././css/a.css', 'css/a.css'],
    ['everything at once', '**`./css/a.css:7`**', 'css/a.css'],
    ['a bare file name', 'a.css', 'a.css'],
    ['a dot file', '.eslintrc.json', '.eslintrc.json'],
    ['a path with no extension', 'docs/readme', 'docs/readme'],
    ['a double extension', 'templates/x.tpl.php', 'templates/x.tpl.php'],
    ['a scoped package path', '@scope/pkg/index.js', '@scope/pkg/index.js'],
    ['a Next.js route group', 'app/(app)/admin/page.tsx', 'app/(app)/admin/page.tsx'],
    ['a route group in parentheses', '(app/(app)/admin/page.tsx)', 'app/(app)/admin/page.tsx'],
    [
      'a route group then a parenthesis and a period',
      '(see app/(app)/page.tsx).',
      'app/(app)/page.tsx',
    ],
    ['a route group at the start', '(app)/layout.tsx', '(app)/layout.tsx'],
    ['a route group at the start, in parentheses', '((app)/layout.tsx)', '(app)/layout.tsx'],
    ['a route group at the end', 'src/app/(app)', 'src/app/(app)'],
    ['a route group at the end, in parentheses', '(src/app/(app))', 'src/app/(app)'],
    ['a route group at the end, then a comma', 'src/app/(app),', 'src/app/(app)'],
    [
      'a route group at the end of a markdown link target',
      '[the dir](src/app/(app))',
      'src/app/(app)',
    ],
    ['a sentence in parentheses', '(see foo.php)', 'foo.php'],
    ['a name in parentheses', '(foo.php)', 'foo.php'],
    ['a Remix dollar segment', 'app/routes/$id.tsx', 'app/routes/$id.tsx'],
    ['a bare name that starts with a dollar sign', '$id.tsx', '$id.tsx'],
    ['an accented directory', 'src/café/menu.php', 'src/café/menu.php'],
    ['an accented bare name', 'café.php', 'café.php'],
    ['a name in other scripts', 'docs/文档/メニュー.md', 'docs/文档/メニュー.md'],
    ['a non-ASCII digit', 'src/v٣/a.php', 'src/v٣/a.php'],
    [
      'an accent as a combining mark',
      'src/café/menu.php'.normalize('NFD'),
      'src/café/menu.php'.normalize('NFD'),
    ],
    ['a combining mark on a bare name', 'café.php'.normalize('NFD'), 'café.php'.normalize('NFD')],
    ['a Devanagari name', 'docs/हिन्दी.md', 'docs/हिन्दी.md'],
    [
      'a markdown link target',
      '[the template](sites/all/modules/custom/x/templates/a.tpl.php)',
      'sites/all/modules/custom/x/templates/a.tpl.php',
    ],
    ['a markdown link whose text is one word', '[label](css/a.css)', 'css/a.css'],
    ['a markdown link then a period', '[label](css/a.css).', 'css/a.css'],
    ['a markdown link in parentheses', '([label](css/a.css))', 'css/a.css'],
    ['a name that starts with an underscore', 'src/_helpers.ts', 'src/_helpers.ts'],
    ['a bare name that starts with an underscore', '_helpers.ts', '_helpers.ts'],
    ['a segment of exactly 255 characters', SEGMENT_255, SEGMENT_255],
    ['an extension of ten characters', 'a.abcdefghij', 'a.abcdefghij'],
  ])('reads a name written with %s', (_form, text, name) => {
    expect(namedFiles(`Look at ${text} now.`)).toEqual([name]);
  });

  it.each([
    ['an https URL', 'https://example.test/assets/theme.css'],
    ['an http URL', 'http://example.test/a.css'],
    ['an ftp URL', 'ftp://example.test/a.css'],
    ['a www URL', 'www.example.test/a.css'],
    ['a WWW URL', 'WWW.example.test/a.css'],
    ['a protocol-relative URL', '//example.test/a.css'],
    ['an absolute path', '/var/www/a.css'],
    ['an empty parenthesis group', 'a/()/b.php'],
    ['an absolute path outside the working directory', '/haive/other/a.css'],
    ['a leading ellipsis', '.../a.css'],
    ['a leading ellipsis on a bare name', '...a.inc'],
    ['a star', 'css/a*.css'],
    ['a glob', '**/*.tpl.php'],
    ['a question mark in the name', 'css/a?.css'],
    ['a character class', 'css/a[ab].css'],
    ['braces', 'css/{a,b}.css'],
    ['an exclamation mark in the name', 'css/a!.css'],
    ['a parent segment', 'css/../a.css'],
    ['an empty segment', 'css//a.css'],
    ['a dot segment', 'css/./a.css'],
    ['a trailing slash', 'css/'],
    ['an extension that starts with a digit', 'a.5'],
    ['an extension of eleven characters on a bare name', 'a.abcdefghijk'],
    ['a bare word', 'word'],
    ['a variable', '$verified'],
    ['a call', 'foo()'],
    ['a call with an argument', 'fn(a)'],
    ['a star in a route group path', 'app/(app)/*/page.tsx'],
    ['a star after a dollar sign', 'routes/$*.tsx'],
    ['braces after a dollar sign', 'src/${dir}/a.ts'],
    ['a negated group', 'src/!(a)/b.php'],
    ['a character class in an accented name', 'src/café[ab]/a.php'],
    ['a pipe in a group', 'app/(a|b)/page.tsx'],
    ['a parenthesis inside a segment', 'src/ap(p)/a.php'],
    ['text after a group', 'src/(app)x/a.php'],
    ['text before a group', 'src/x(app)/a.php'],
    ['two groups in one segment', 'src/(a)(b)/a.php'],
    ['nested groups', 'src/((a))/a.php'],
    ['an open parenthesis in the middle', 'src/(a/b.php'],
    ['a close parenthesis in the middle', 'src/a)/b.php'],
    ['a group holding a slash', 'src/(a/b)/c.php'],
    ['a call before a path', 'require(includes/a.inc'],
    ['a heading anchor on a name with no extension', 'docs/readme#install'],
    ['a slash after the anchor', 'docs/a.md#install/more'],
    ['a non-ASCII symbol', 'css/a→b.css'],
    ['an assignment', 'css/a=b.css'],
    ['a pipe', 'a|b.css'],
    ['a host and a port', 'localhost:3000/a.css'],
  ])('reads %s as no name', (_form, text) => {
    expect(namedFiles(`Look at ${text} now.`)).toEqual([]);
  });

  it('bounds a segment at 255 characters and a path at 4096, not a path at 255', () => {
    const pathOf = (length: number) =>
      `${'abcdefg/'.repeat(Math.floor((length - 5) / 8))}${'y'.repeat((length - 5) % 8)}a.css`;
    expect(pathOf(4096)).toHaveLength(4096);
    expect(namedFiles(pathOf(300))).toEqual([pathOf(300)]);
    expect(namedFiles(`Look at "${pathOf(4096)}".`)).toEqual([pathOf(4096)]);
    expect(namedFiles(pathOf(4097))).toEqual([]);
    expect(namedFiles(SEGMENT_255)).toEqual([SEGMENT_255]);
    expect(namedFiles(`css/${'x'.repeat(256)}/a.css`)).toEqual([]);
  });

  it('skips a piece longer than twice the longest path, even one whose wrapping hides a name', () => {
    expect(namedFiles(`${'('.repeat(100)}css/a.css${')'.repeat(100)}`)).toEqual(['css/a.css']);
    expect(namedFiles(`${'('.repeat(4096)}css/a.css${')'.repeat(4096)}`)).toEqual([]);
  });

  it('splits a text on white space and on backticks, keeps the order, and names a path once', () => {
    expect(namedFiles('b/two.css, `a/one.php`/`c/three.js` a/one.php\nb/two.css')).toEqual([
      'b/two.css',
      'a/one.php',
      'c/three.js',
    ]);
    expect(namedFiles('`a/one.php c/two.js`')).toEqual(['a/one.php', 'c/two.js']);
  });

  it('reads the text of a markdown link and its target as two tokens', () => {
    expect(
      namedFiles('See [css/a.css](css/b.css), [the page](app/(app)/page.tsx) and [x](c.js).'),
    ).toEqual(['css/a.css', 'css/b.css', 'app/(app)/page.tsx', 'c.js']);
  });

  it('names nothing in an empty text or in prose', () => {
    expect(namedFiles('')).toEqual([]);
    expect(namedFiles('  \n\t ')).toEqual([]);
    expect(namedFiles('Make the badge look right, then stop.')).toEqual([]);
  });

  describe('prose that looks like a path', () => {
    const NOISE = [
      'The Ai/Bi toggle shows or hides the panel, 9134/9135/9136 are order numbers and the export is application/pdf.',
      'Use show/hide, not Ai/Bi.',
      'The t_inspection.data table, input.labels.length and Z.z (that is, i.e) stay as they are.',
      'See https://example.test/assets/theme.css for the design; the admin screen lists files rules such as **/*.tpl.php.',
    ].join(' ');
    const CODE_GLOBS = [
      '**/*.php',
      '**/*.tpl.php',
      '**/*.css',
      '**/*.js',
      '**/*.ts',
      '**/*.inc',
      '**/*.module',
      '**/*.md',
      '**/*.json',
      '**/*.twig',
    ];

    it('matches no glob on a code extension, and the URL and the glob in it are no names', () => {
      const names = namedFiles(NOISE);
      expect(
        names.filter((name) => CODE_GLOBS.some((glob) => picomatch(glob, { dot: true })(name))),
      ).toEqual([]);
      expect(names.some((name) => name.includes('theme.css') || name.includes('*'))).toBe(false);
    });

    it.each([
      'and(eq(tasks.id, id), eq(tasks.userId, userId))',
      'JSON.stringify(row.facets)',
      'switch(field.type)',
      'withAuth(mod.routes)',
      'isNotNull(schema.cliInvocations.startedAt)',
      'repricedPriority(job.opts.priority, delta)',
      'markBrowserDesktopUp(handle.container)',
      'ln(N/df)',
      'floor(1725/2048)',
      'require(includes/a.inc)',
    ])('reads the call %s as no name', (code) => {
      expect(namedFiles(`Then ${code}.`)).toEqual([]);
    });

    it('reads no name in prose with parentheses, only the real path beside it', () => {
      const prose =
        'Call fn(a) or fn(a, b), see (the docs) and the (optional) flag; $verified, ($x) and get_x(a).';
      expect(namedFiles(prose)).toEqual([]);
      expect(namedFiles(`${prose} Edit (templates/node.tpl.php).`)).toEqual([
        'templates/node.tpl.php',
      ]);
    });
  });

  it('stays linear on long runs of punctuation, since the text can be agent output', () => {
    // 40,000 dots then a letter took a trailing-punctuation regex over 2 s: it is quadratic. A piece
    // past 8192 characters is skipped, so each run is cut to 8000 and repeated 25 times.
    const long = (unit: string, tail: string) =>
      Array(25)
        .fill(`${unit.repeat(Math.floor(8000 / unit.length))}${tail}`)
        .join(' ');
    const started = performance.now();
    namedFiles([long('.', 'x'), long(')', 'a'), long('*', '/a.css'), long(':1', 'y')].join(' '));
    namedFiles([long('(', 'a.php'), long('.a#', '/'), long('()', 'a.md#x')].join(' '));
    namedFiles(
      Array(25)
        .fill(`${'('.repeat(4000)}a.php${')'.repeat(4000)}`)
        .join(' '),
    );
    namedFiles(`${']('.repeat(40_000)}a`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('resolveNamedFiles', () => {
  const TREE = [
    'README.md',
    'index.php',
    'sub/index.php',
    'sites/all/modules/custom/hr6_badges/css/hr6_badges.css',
    'sites/all/modules/custom/hr6_badges/css/shared.css',
    'sites/all/modules/custom/hr6_badges/hr6_badges.module',
    TEMPLATE,
    'sites/all/modules/custom/hr6_other/css/shared.css',
  ];
  const resolve = (...names: string[]) => resolveNamedFiles(names, TREE);

  it('replaces a name by the one tracked file it ends, on a "/" boundary', () => {
    expect(resolve('css/hr6_badges.css')).toEqual([TREE[3]]);
    expect(resolve('hr6_badges.css')).toEqual([TREE[3]]);
    expect(resolve('templates/hr6-badges-product-title.tpl.php')).toEqual([TEMPLATE]);
    expect(resolve('hr6_badges/hr6_badges.module')).toEqual([TREE[5]]);
  });

  it('keeps a name that is a tracked file as it is', () => {
    expect(resolve('README.md', TEMPLATE)).toEqual(['README.md', TEMPLATE]);
  });

  it('keeps a name that ends several tracked files, since it cannot say which', () => {
    expect(resolve('css/shared.css')).toEqual(['css/shared.css']);
    expect(resolve('index.php')).toEqual(['index.php']);
  });

  it('keeps a name that ends no tracked file, which a writer may be about to create', () => {
    expect(resolve('includes/new.inc')).toEqual(['includes/new.inc']);
  });

  it('keeps a name whose end is not on a "/" boundary, and drops a bare word no file carries', () => {
    expect(resolve('ss/hr6_badges.css')).toEqual(['ss/hr6_badges.css']);
    expect(resolve('r6_badges.css')).toEqual([]);
  });

  it('drops a dotted technology name, which names no tracked file', () => {
    expect(resolveNamedFiles(namedFiles('Upgrade Node.js and migrate from Vue.js.'), TREE)).toEqual(
      [],
    );
  });

  it('keeps a directory as written and resolves each name on its own, in order', () => {
    expect(
      resolve('sites/all/modules/custom/hr6_badges', 'css/hr6_badges.css', 'nope.css'),
    ).toEqual(['sites/all/modules/custom/hr6_badges', TREE[3]]);
  });

  it('keeps every path with a "/" when nothing is tracked, and no bare word', () => {
    expect(resolveNamedFiles(['css/a.css', 'b.php'], [])).toEqual(['css/a.css']);
  });

  it('resolves a route-group name to the one tracked file, which an anchored glob then matches', () => {
    const tracked = [
      'packages/web/src/app/(app)/admin/page.tsx',
      'packages/web/src/app/(auth)/login/page.tsx',
    ];
    const [file] = resolveNamedFiles(namedFiles('Edit app/(app)/admin/page.tsx.'), tracked);
    expect(file).toBe(tracked[0]);
    expect(picomatch('packages/web/**', { dot: true })(file!)).toBe(true);
  });
});
