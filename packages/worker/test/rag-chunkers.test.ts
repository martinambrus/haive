import { describe, it, expect } from 'vitest';
import {
  assembleSections,
  extractMarkdownSections,
  extractCodeSections,
  maskNonCode,
  chunkSection,
  capChunks,
  contextHeader,
  isHeadingOnlyChunk,
  isHeadingOnlyMarkdown,
  fileBudget,
  MAX_CHUNKS_PER_FILE,
  MAX_FILE_BYTES,
  MAX_OWN_FILE_BYTES,
} from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

/** Body of roughly `size` chars carrying a unique MARK<n> token every ~100 chars,
 *  so a test can assert that every region of the source survived into some chunk
 *  — the direct check for "nothing was silently truncated". */
function markedBody(size: number, prefix = 'MARK'): string {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; len < size; i += 1) {
    const line = `${prefix}${i} ` + 'x'.repeat(90) + '\n';
    parts.push(line);
    len += line.length;
  }
  return parts.join('');
}

function marksIn(text: string, prefix = 'MARK'): Set<string> {
  return new Set(text.match(new RegExp(`${prefix}\\d+`, 'g')) ?? []);
}

describe('extractMarkdownSections', () => {
  it('carries H1 > H2 > H3 ancestry as a breadcrumb', () => {
    const md = [
      '# Deployment',
      'intro text',
      '## DDEV',
      'ddev text',
      '### Ports',
      'port text',
      '## Docker',
      'docker text',
    ].join('\n');

    const byId = new Map(extractMarkdownSections(md, 'doc.md').map((s) => [s.sectionId, s]));

    expect(byId.get('ports')?.breadcrumb).toEqual(['Deployment', 'DDEV', 'Ports']);
    // A sibling H2 must clear the deeper level rather than inherit 'Ports'.
    expect(byId.get('docker')?.breadcrumb).toEqual(['Deployment', 'Docker']);
    expect(byId.get('deployment')?.breadcrumb).toEqual(['Deployment']);
  });

  it('never emits the same section id twice for a repeated heading', () => {
    const md = ['# Doc', 'intro text', '## Same', 'first body', '## Same', 'second body'].join(
      '\n',
    );

    const ids = extractMarkdownSections(md, 'doc.md').map((s) => s.sectionId);

    expect(ids.filter((id) => id.startsWith('same')).length).toBe(2);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('heading-only sections', () => {
  it('drops a heading that carries no prose of its own', () => {
    // The global KB shape: an H1 immediately followed by an H2. The H1 section
    // would chunk to pure title text and outrank the body it introduces.
    const md = ['# Apache 2.4', '## Require all denied', 'authz merges under RequireAny'].join(
      '\n',
    );

    const ids = extractMarkdownSections(md, 'doc.md').map((s) => s.sectionId);

    expect(ids).toEqual(['require-all-denied']);
  });

  it('drops a trailing heading with nothing under it', () => {
    const md = ['# Guide', 'body text', '## Appendix'].join('\n');

    const ids = extractMarkdownSections(md, 'doc.md').map((s) => s.sectionId);

    expect(ids).toEqual(['guide']);
  });

  it('keeps the parent title reachable through the surviving breadcrumb', () => {
    const md = ['# Apache 2.4', '## Require all denied', 'authz merges'].join('\n');

    const [section] = extractMarkdownSections(md, 'doc.md');

    expect(section?.breadcrumb).toEqual(['Apache 2.4', 'Require all denied']);
  });

  it('falls back to the headings when a document is nothing but headings', () => {
    // Zero sections would index to zero chunks and make the document
    // unretrievable, which is worse than one weak chunk.
    const md = ['# Only', '## Headings'].join('\n');

    const ids = extractMarkdownSections(md, 'doc.md').map((s) => s.sectionId);

    expect(ids).toEqual(['only', 'headings']);
  });

  it('does not drop a heading whose section has prose', () => {
    const md = ['# Deployment', 'intro text', '## DDEV', 'ddev text'].join('\n');

    const ids = extractMarkdownSections(md, 'doc.md').map((s) => s.sectionId);

    expect(ids).toEqual(['deployment', 'ddev']);
  });

  it('recognises a heading-only STORED chunk through its context header', () => {
    // What the data migration matches: chunkSection prepends '[header]\n\n'.
    expect(isHeadingOnlyChunk('[Title > Heading]\n\n# Heading')).toBe(true);
    expect(isHeadingOnlyChunk('[Title > Heading]\n\n# Heading\n\nbody')).toBe(false);
    // Headerless content still works, and a first line that is not a bracketed
    // header is kept — so it reads as two lines and is never matched.
    expect(isHeadingOnlyChunk('# Heading')).toBe(true);
    expect(isHeadingOnlyChunk('not a header\n# Heading')).toBe(false);
  });

  it('treats only real markdown headings as heading-only', () => {
    expect(isHeadingOnlyMarkdown('### Deep')).toBe(true);
    expect(isHeadingOnlyMarkdown('#### Too deep')).toBe(false);
    expect(isHeadingOnlyMarkdown('#NoSpace')).toBe(false);
    expect(isHeadingOnlyMarkdown('plain line')).toBe(false);
  });
});

describe('extractCodeSections — full coverage', () => {
  it('keeps a long function whole instead of cutting it at 3000 chars', () => {
    const php = `<?php\nfunction big_one() {\n${markedBody(10_000)}\n}\n`;
    const all = extractCodeSections(php, 'mod.php')
      .map((s) => s.content)
      .join('\n');

    expect(marksIn(all)).toEqual(marksIn(php));
  });

  it('indexes the regions between matches instead of dropping them', () => {
    const php = `<?php\n${markedBody(400, 'TOP')}\nfunction only_one() {\n  return 1;\n}\n${markedBody(20_000, 'TAIL')}\n`;
    const sections = extractCodeSections(php, 'legacy.module');
    const all = sections.map((s) => s.content).join('\n');

    expect(marksIn(all, 'TOP')).toEqual(marksIn(php, 'TOP'));
    expect(marksIn(all, 'TAIL')).toEqual(marksIn(php, 'TAIL'));
    expect(sections.some((s) => s.sectionId === 'function-only_one')).toBe(true);
  });

  it('covers a file whose regexes match nothing (legacy jQuery style)', () => {
    const js = `jQuery(document).ready(function ($) {\n${markedBody(15_000)}\n});\n`;
    const sections = extractCodeSections(js, 'legacy.js');

    expect(sections.length).toBeGreaterThan(0);
    expect(marksIn(sections.map((s) => s.content).join('\n'))).toEqual(marksIn(js));
  });

  it('never emits a section id containing ":" (the stale-key separator)', () => {
    const php = `<?php\nclass Foo {\n  public function bar() {\n    return 1;\n  }\n}\n`;
    for (const s of extractCodeSections(php, 'Foo.php')) {
      expect(s.sectionId).not.toContain(':');
    }
  });

  it('never emits the same section id twice in one file', () => {
    // `${sectionId}:${chunkIndex}` is the row key. Two same-named functions used
    // to collide onto one key, so the unique index kept whichever landed last and
    // the next sync compared the OTHER one's hash — re-embedding it every run.
    const js =
      'function dup() {\n  return 1;\n}\n\n' +
      'function other() {\n  return 2;\n}\n\n' +
      'function dup() {\n  return 3;\n}\n';
    const sections = extractCodeSections(js, 'dup.js');
    const keys = sections.flatMap((s) =>
      chunkSection(s).map((c) => `${c.sectionId}:${c.chunkIndex}`),
    );

    expect(sections.filter((s) => s.sectionId.startsWith('function-dup')).length).toBe(2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names a PHP method after its enclosing class', () => {
    const php = `<?php\nclass Foo {\n  public function bar() {\n    return 1;\n  }\n}\n`;
    const method = extractCodeSections(php, 'Foo.php').find((s) =>
      s.content.includes('function bar'),
    );

    expect(method?.sectionId).toBe('method-Foo-bar');
    expect(method?.breadcrumb).toEqual(['class Foo', 'function bar']);
  });
});

describe('extractCodeSections — PHP docblock attachment', () => {
  it('gives each function behind an @file docblock its own section, docblock included', () => {
    const documented = (name: string, doc: string) =>
      `/**\n * ${doc}\n */\nfunction ${name}() {\n  return 1;\n}\n`;
    const bare = '<?php\n\nfunction a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
    expect(extractCodeSections(bare, 'm.module').map((s) => s.sectionId)).toEqual([
      'function-a',
      'function-b',
    ]);

    const php = `<?php\n/**\n * @file\n * Module summary.\n */\n\n${documented('a', 'Doc A.')}\n${documented('b', 'Doc B.')}`;
    const byId = new Map(extractCodeSections(php, 'm.module').map((s) => [s.sectionId, s.content]));

    expect([...byId.keys()]).toEqual(['file-docblock', 'function-a', 'function-b']);
    expect(byId.get('function-a')).toContain('Doc A.');
    expect(byId.get('function-b')).toContain('Doc B.');
    expect(byId.get('function-a')).not.toContain('@file');
    expect(byId.get('function-b')).not.toContain('@file');
  });

  it('keeps a lone docblock before the first function as the file docblock', () => {
    const php = '<?php\n/**\n * @file\n * Only docblock.\n */\nfunction a() {\n  return 1;\n}\n';
    const sections = extractCodeSections(php, 'm.module');

    expect(sections.map((s) => s.sectionId)).toEqual(['file-docblock', 'function-a']);
    expect(sections[1]!.content.startsWith('function a()')).toBe(true);
  });

  it('does not let an empty comment open a docblock', () => {
    const php =
      '<?php\nfunction a() {\n  /**/\n  return 1;\n}\n\n/**\n * Doc B.\n */\nfunction b() {\n  return 2;\n}\n';
    const sections = extractCodeSections(php, 'm.module');

    expect(sections.map((s) => s.sectionId)).toEqual(['function-a', 'function-b']);
    expect(sections[1]!.content).toContain('Doc B.');
  });

  it('attaches a docblock only to the construct that follows it', () => {
    const php = [
      '<?php',
      '',
      "define('A', 0);",
      '',
      '/**',
      ' * Documents a statement.',
      ' */',
      "define('X', 1);",
      '',
      'function middle() {',
      '  return X;',
      '}',
      '',
      '/**',
      ' * Doc last.',
      ' */',
      'function last() {',
      '  return 2;',
      '}',
      '',
    ].join('\n');
    const byId = new Map(extractCodeSections(php, 'm.module').map((s) => [s.sectionId, s.content]));

    expect(byId.has('function-middle')).toBe(true);
    expect(byId.get('function-last')).toContain('Doc last.');
    expect(byId.get('function-last')).not.toContain('Documents a statement.');
  });
});

describe('extractCodeSections — PHP signatures', () => {
  it.each([
    [
      'a parenthesized default',
      'function with_default($items = array(), $n = max(1, count(array(2)))) {',
      'with_default',
    ],
    ['a return type', 'function with_type($value): ?string {', 'with_type'],
    ['a union return type after a space', 'function with_union($v) : int|string {', 'with_union'],
    ['a by-ref name', 'function &by_ref() {', 'by_ref'],
    ['upper-case keywords', 'FUNCTION Shouty() {', 'Shouty'],
    [
      'a parenthesis in a string default',
      "function with_glue($glue = ')', $open = '(') {",
      'with_glue',
    ],
  ])('finds a function with %s', (_what, head, name) => {
    const [section] = extractCodeSections(`<?php\n\n${head}\n  return 1;\n}\n`, 'm.module');

    expect(section?.sectionId).toBe(`function-${name}`);
    expect(section?.content.startsWith(`<?php\n\n${head}`)).toBe(true);
  });

  it('reads abstract and final modifiers in any order and skips a method with no body', () => {
    const php = [
      '<?php',
      '',
      'abstract class Base {',
      '  abstract public function no_body($x);',
      '  final public function sealed($x): static {',
      '    return $this;',
      '  }',
      '  static protected final function stamp() {',
      '    return 1;',
      '  }',
      '  Public Static Function Shouty() {',
      '    return 2;',
      '  }',
      '}',
      '',
    ].join('\n');
    const byId = new Map(extractCodeSections(php, 'Base.php').map((s) => [s.sectionId, s.content]));

    expect([...byId.keys()].filter((id) => !id.startsWith('chunk-'))).toEqual([
      'method-Base-sealed',
      'method-Base-stamp',
      'method-Base-Shouty',
    ]);
    expect(
      byId
        .get('method-Base-sealed')!
        .startsWith(
          '<?php\n\nabstract class Base {\n  abstract public function no_body($x);\n  final public function sealed',
        ),
    ).toBe(true);
    expect(byId.get('method-Base-stamp')!.startsWith('static protected final function')).toBe(true);
    expect(byId.get('method-Base-Shouty')!.startsWith('Public Static Function Shouty')).toBe(true);
  });
});

describe('extractCodeSections — JS and TS named constructs', () => {
  // A short span before the keyword, such as an export, joins the section that follows it.
  it.each([
    [
      'a typed function with nested parentheses',
      'export function load(cb: (err: Error | null, rows: Row[]) => void, n = Math.max(1, 2)): Promise<void> {\n  return run(cb, n);\n}\n',
      'load',
      'export function load(cb:',
    ],
    [
      'generics and an indexed return type',
      'function pick<T extends Record<string, unknown>>(a: T, key: keyof T): T[keyof T] {\n  return a[key];\n}\n',
      'pick',
      'function pick<T',
    ],
    [
      'an export default function',
      'export default function main(a: number): string {\n  return String(a);\n}\n',
      'main',
      'export default function main(',
    ],
    [
      'a typed async arrow',
      'export const parse = async (raw: string): Promise<Item[]> => {\n  return read(raw);\n};\n',
      'parse',
      'export const parse = async (raw',
    ],
    [
      'a typed variable holding an arrow',
      'const handler: Handler = (req) => {\n  return respond(req);\n};\n',
      'handler',
      'const handler: Handler',
    ],
  ])('names %s', (_what, src, name, startsWith) => {
    const [section] = extractCodeSections(src, 'mod.ts');

    expect(section?.sectionId).toBe(`function-${name}`);
    expect(section?.content.startsWith(startsWith)).toBe(true);
    expect(section?.content).toMatch(/\}[;\s]*$/);
  });

  it('reads typed and untyped declarations side by side', () => {
    const ts = [
      'function plain(a, b) {',
      '  return a + b;',
      '}',
      '',
      'const arrow = (a) => {',
      '  return a;',
      '};',
      '',
      'const single = a => {',
      '  return a;',
      '};',
      '',
      'function typed(a: number): string {',
      '  return String(a);',
      '}',
      '',
      'class Box {',
      '  size = 1;',
      '}',
      '',
    ].join('\n');

    expect(extractCodeSections(ts, 'mod.ts').map((s) => s.sectionId)).toEqual([
      'function-plain',
      'function-arrow',
      'function-single',
      'function-typed',
      'class-Box',
    ]);
  });

  it('names object-literal members and leaves callbacks and control statements alone', () => {
    const js = [
      'jQuery(document).ready(function ($) {',
      "  $('.item').each(function (i, el) {",
      "    el.className = 'item-' + i;",
      '  });',
      '  if (window.ready) {',
      '    for (var i = 0; i < 3; i++) {',
      '      while (i < 0) {',
      '        break;',
      '      }',
      '    }',
      '    switch (window.mode) {',
      '      case 0:',
      '        break;',
      '    }',
      '    try {',
      '      run();',
      '    } catch (e) {',
      '      fail(e);',
      '    }',
      '  }',
      '});',
      '',
      'var api = {',
      '  fetch(url, opts) {',
      '    return run(url, opts);',
      '  },',
      '  async save(item) {',
      '    return store(item);',
      '  },',
      '  load: function (id) {',
      '    return find(id);',
      '  },',
      '  build: (spec) => {',
      '    return make(spec);',
      '  },',
      '  quick: z => {',
      '    return z;',
      '  },',
      '};',
      '',
    ].join('\n');
    const sections = extractCodeSections(js, 'api.js');

    expect(sections.map((s) => s.sectionId)).toEqual([
      'chunk-0',
      'function-fetch',
      'function-save',
      'function-load',
      'function-build',
      'function-quick',
    ]);
    expect(sections[0]!.content).toContain("$('.item').each(function (i, el) {");
    expect(sections[0]!.content).toContain('while (i < 0) {');
    expect(sections[0]!.content).toContain('switch (window.mode) {');
    expect(sections[0]!.content).toContain('} catch (e) {');
    expect(sections[2]!.content.startsWith('async save(item) {')).toBe(true);

    // Members are a JS/TS reading: Java shares jsRanges and keeps its class section.
    const java = 'public class Box {\n  public Box(int size) {\n    this.size = size;\n  }\n}\n';
    expect(extractCodeSections(java, 'Box.java').map((s) => s.sectionId)).toEqual(['class-Box']);
  });

  it('keeps a type declaration whole and names a class member under its class', () => {
    const ts = [
      'export interface Handler {',
      '  onEvent: (a: number) => { ok: boolean };',
      '  run(a: number): void;',
      '  build(a: number): { ok: boolean };',
      '  make(a: number): Promise<{ ok: boolean }>;',
      '  // padding, so that the declaration is long enough to be indexed on its own',
      '}',
      '',
      'export class Store {',
      '  constructor(private db: Db) {}',
      '  async get(id: string): Promise<Item | null> {',
      '    return this.db.find(id);',
      '  }',
      '}',
      '',
    ].join('\n');
    const sections = extractCodeSections(ts, 'store.ts');

    expect(sections.map((s) => s.sectionId)).toEqual([
      'chunk-0',
      'function-constructor',
      'function-get',
    ]);
    expect(sections[0]!.content).toContain('onEvent: (a: number) => { ok: boolean };');
    expect(sections[0]!.content).toContain('make(a: number): Promise<{ ok: boolean }>;');
    expect(sections[2]!.breadcrumb).toEqual(['class Store', 'function get']);
  });

  it('never takes a control keyword for a name', () => {
    const js = [
      '// pass the validator function',
      'for (var i = 0; i < n; i++) {',
      '  total += i;',
      '}',
      '',
      '// or a function',
      'if (total) {',
      '  report(total);',
      '}',
      '',
    ].join('\n');

    const ids = extractCodeSections(js, 'loop.js').map((s) => s.sectionId);

    expect(ids.filter((id) => !id.startsWith('chunk-'))).toEqual([]);
  });

  it('does not read the else branch of a ternary as a return type', () => {
    const js = [
      'function pick(fn) {',
      '  return fn ?',
      '    wrap(function (a) {',
      '      return a;',
      '    }) :',
      '    function (b) {',
      '      return b;',
      '    };',
      '}',
      '',
      'var api = {',
      '  go() {',
      '    return 1;',
      '  },',
      '};',
      '',
    ].join('\n');

    expect(extractCodeSections(js, 'pick.js').map((s) => s.sectionId)).toEqual([
      'function-pick',
      'function-go',
    ]);
  });

  it('reads a signature and a call past a parenthesis inside a string', () => {
    const js = [
      'function parse() {',
      '  advance("(");',
      '  while (more()) {',
      '    step();',
      '  }',
      '}',
      '',
      'var api = {',
      "  go(sep = ')') {",
      '    return sep;',
      '  },',
      '};',
      '',
    ].join('\n');

    expect(extractCodeSections(js, 'parse.js').map((s) => s.sectionId)).toEqual([
      'function-parse',
      'function-go',
    ]);
  });

  it.each([
    [
      'a double-quoted function',
      'var t = {\n  "parent": function (a, b) {\n    return a + b;\n  },\n};\n',
      'parent',
      '"parent": function (a, b) {',
    ],
    [
      'a single-quoted function',
      "var t = {\n  'child' : function () {\n    return 1;\n  },\n};\n",
      'child',
      "'child' : function () {",
    ],
    [
      'a single-quoted arrow',
      "var t = {\n  'x': (a) => {\n    return a;\n  },\n};\n",
      'x',
      "'x': (a) => {",
    ],
    [
      'a typed quoted arrow',
      'var t = {\n  "typed": async (a: number): Promise<number> => {\n    return a;\n  },\n};\n',
      'typed',
      '"typed": async (a: number): Promise<number> => {',
    ],
  ])('names a member keyed by %s', (_what, src, name, startsWith) => {
    const [section] = extractCodeSections(src, 'table.ts');

    expect(section?.sectionId).toBe(`function-${name}`);
    expect(section?.content.startsWith(`var t = {\n  ${startsWith}`)).toBe(true);
    expect(section?.content).toMatch(/\}[;\s]*$/);
  });

  it('leaves a quoted key that is no identifier in the gap', () => {
    const js = [
      'var t = {',
      '  "my-key": function (a) {',
      `    return ${'a + '.repeat(40)}a;`,
      '  },',
      '  "ok": function (b) {',
      '    return b;',
      '  },',
      '};',
      '',
    ].join('\n');
    const sections = extractCodeSections(js, 'table.js');

    expect(sections.map((s) => s.sectionId)).toEqual(['chunk-0', 'function-ok']);
    expect(sections[0]!.content).toContain('"my-key": function (a) {');
  });
});

describe('extractCodeSections — JS and TS leading comments', () => {
  const byId = (src: string, file: string) =>
    new Map(extractCodeSections(src, file).map((s) => [s.sectionId, s.content]));
  // Long enough to stay a section of its own, so only the comment join decides what a construct takes.
  const HEAD = `'use strict';\nvar banner = '${'x'.repeat(120)}';\n`;

  it.each([
    ['a // run', '// Adds two numbers.\n// Returns the sum.\n'],
    ['a block', '/* Adds two numbers. */\n'],
    ['a JSDoc block', '/**\n * Adds two numbers.\n * @returns {number}\n */\n'],
  ])('joins %s to the function it precedes', (_what, comment) => {
    const js = `${HEAD}\n${comment}function add(a, b) {\n  return a + b;\n}\n`;

    expect(byId(js, 'math.js').get('function-add')).toBe(
      `${comment}function add(a, b) {\n  return a + b;\n}`,
    );
  });

  it('joins a comment to the member, the arrow and the class it precedes', () => {
    const js = [
      'var api = {',
      `  banner: '${'x'.repeat(120)}',`,
      '  // Fetches one item.',
      '  fetch(url) {',
      '    return get(url);',
      '  },',
      '  /** Saves one item. */',
      '  save: function (item) {',
      '    return put(item);',
      '  },',
      '  // Builds a spec.',
      '  build: (spec) => {',
      '    return make(spec);',
      '  },',
      '};',
      '',
      '/** Wraps a box. */',
      'class Box {',
      '  size = 1;',
      '}',
      '',
    ].join('\n');
    const sections = byId(js, 'api.js');

    expect(sections.get('function-fetch')!.startsWith('// Fetches one item.\n  fetch(url) {')).toBe(
      true,
    );
    expect(
      sections
        .get('function-save')!
        .startsWith('/** Saves one item. */\n  save: function (item) {'),
    ).toBe(true);
    expect(
      sections.get('function-build')!.startsWith('// Builds a spec.\n  build: (spec) => {'),
    ).toBe(true);
    expect(sections.get('class-Box')!.startsWith('/** Wraps a box. */\nclass Box {')).toBe(true);
  });

  it('steps over export, default and async to reach the comment above them', () => {
    const ts = [
      HEAD,
      '/** Loads rows. */',
      'export async function load(n: number): Promise<Row[]> {',
      '  return fetchRows(n);',
      '}',
      '',
      '// The default handler.',
      'export default class Handler {',
      '  size = 1;',
      '}',
      '',
      '/** Parses one row. */',
      'export const parse = (raw: string): Row => {',
      '  return read(raw);',
      '};',
      '',
    ].join('\n');
    const sections = byId(ts, 'rows.ts');

    expect(
      sections.get('function-load')!.startsWith('/** Loads rows. */\nexport async function load('),
    ).toBe(true);
    expect(
      sections
        .get('class-Handler')!
        .startsWith('// The default handler.\nexport default class Handler {'),
    ).toBe(true);
    expect(
      sections
        .get('function-parse')!
        .startsWith('/** Parses one row. */\nexport const parse = (raw: string)'),
    ).toBe(true);
  });

  it.each([
    ['a block', `/**\n * @file Math helpers.\n * ${'x'.repeat(120)}\n */\n`],
    ['a // run', `// Math helpers.\n// ${'x'.repeat(120)}\n`],
  ])('keeps %s that opens the file out of the first function', (_what, header) => {
    const js = `${header}function first() {\n  return 1;\n}\n\n// Adds two numbers.\nfunction second() {\n  return 2;\n}\n`;
    const sections = byId(js, 'math.js');

    expect(sections.get('function-first')).toBe('function first() {\n  return 1;\n}');
    expect(sections.get('function-second')).toBe(
      '// Adds two numbers.\nfunction second() {\n  return 2;\n}',
    );
  });

  it('joins the comment of the first function when a header comment stands before it', () => {
    const js = `/* Licensed under MIT. ${'x'.repeat(120)} */\n\n/** Adds two numbers. */\nfunction add(a, b) {\n  return a + b;\n}\n`;

    expect(byId(js, 'math.js').get('function-add')).toBe(
      '/** Adds two numbers. */\nfunction add(a, b) {\n  return a + b;\n}',
    );
  });

  it('leaves a comment out when a line of code stands between it and the construct', () => {
    const js = [
      HEAD,
      '// Describes the offset.',
      'var offset = 1;',
      '// Adds two numbers.',
      'function add(a, b) {',
      '  return a + b + offset;',
      '}',
      '',
    ].join('\n');

    expect(byId(js, 'math.js').get('function-add')).toBe(
      '// Adds two numbers.\nfunction add(a, b) {\n  return a + b + offset;\n}',
    );
  });

  it('reads the comment lines directly above, across blank lines before the construct only', () => {
    const js = [
      HEAD,
      'var offset = 1; // the offset',
      '// Split from the run below by a blank line.',
      '',
      '// Adds two numbers.',
      '',
      'function add(a, b) {',
      '  return a + b + offset;',
      '}',
      'function sub(a, b) {',
      '  return a - b - offset;',
      '}',
      '',
    ].join('\n');
    const sections = byId(js, 'math.js');

    expect(sections.get('function-add')).toBe(
      '// Adds two numbers.\n\nfunction add(a, b) {\n  return a + b + offset;\n}',
    );
    expect(sections.get('function-sub')).toBe('function sub(a, b) {\n  return a - b - offset;\n}');
  });

  it('reads a // run across CRLF line ends', () => {
    const js = `${HEAD.replaceAll('\n', '\r\n')}\r\n// Adds.\r\n// Sums.\r\nfunction add(a, b) {\r\n  return a + b;\r\n}\r\n`;

    expect(byId(js, 'math.js').get('function-add')).toBe(
      '// Adds.\r\n// Sums.\r\nfunction add(a, b) {\r\n  return a + b;\r\n}',
    );
  });

  it('leaves a comment out when another section reaches into it', () => {
    const src = [
      'function tail() {}',
      '/**',
      ' * Closes with a `}` in prose.',
      ' */',
      'function escape(s) {',
      '  return s;',
      '}',
      '',
    ].join('\n');
    const sections = assembleSections(src, [
      { sectionId: 'function-tail', start: 0, end: src.indexOf('prose'), breadcrumb: [] },
      {
        sectionId: 'function-escape',
        start: src.indexOf('function escape'),
        commentStart: src.indexOf('/**'),
        end: src.lastIndexOf('}') + 1,
        breadcrumb: [],
      },
    ]);

    expect(sections.find((s) => s.sectionId === 'function-escape')?.content).toBe(
      'function escape(s) {\n  return s;\n}',
    );
  });

  it('gives a function named in a comment no section, so the comment joins the function after it', () => {
    const example = [
      HEAD,
      '/**',
      ' * @example',
      ' *   function sample() { return 1; }',
      ' */',
      'function real() {',
      '  return 2;',
      '}',
      '',
    ].join('\n');
    const sections = byId(example, 'real.js');

    expect(sections.has('function-sample')).toBe(false);
    expect(sections.get('function-real')).toBe(
      '/**\n * @example\n *   function sample() { return 1; }\n */\nfunction real() {\n  return 2;\n}',
    );
  });

  it('lets a JS class take the comment above it and a Java class not', () => {
    const box = 'class Box {\n  size = 1;\n}\n';

    expect(byId(`${HEAD}\n// A box.\n${box}`, 'Box.js').get('class-Box')).toBe(
      `// A box.\n${box.trim()}`,
    );
    const javaHead = `package x;\nimport ${'x'.repeat(120)};\n`;
    expect(byId(`${javaHead}\n// A box.\n${box}`, 'Box.java').get('class-Box')).toBe(box.trim());
  });
});

describe('extractCodeSections — short spans between sections', () => {
  const byId = (src: string, file: string) =>
    new Map(extractCodeSections(src, file).map((s) => [s.sectionId, s.content]));
  const withoutSpace = (text: string) => text.replace(/\s+/g, '');

  const store = [
    'export class Store {',
    '  private cache = new Map<string, number>();',
    '  readonly limit = 10;',
    '',
    '  get(key: string) {',
    '    return this.cache.get(key);',
    '  }',
    '',
    '  clear() {',
    '    this.cache.clear();',
    '  }',
    '}',
    '',
  ].join('\n');
  const handlers = [
    'const handlers = {',
    '  foo() { const marker = "}"; callCriticalThing(marker); },',
    '  bar() {',
    '    return 1;',
    '  },',
    '};',
    '',
  ].join('\n');
  const decorated = [
    'class Panel {',
    '  open() {',
    '    return 1;',
    '  }',
    '',
    '  @Input()',
    '  readonly size = 2;',
    '',
    '  close() {',
    '    return 2;',
    '  }',
    '}',
    '',
  ].join('\n');
  const property = [
    '<?php',
    'class Panel {',
    '  public function open() {',
    '    return 1;',
    '  }',
    '',
    '  private $a = 1;',
    '',
    '  public function close() {',
    '    return 2;',
    '  }',
    '}',
    '',
  ].join('\n');
  const head =
    '<?php\n\nnamespace App\\Lib;\n\nuse Foo\\Bar;\n\nfunction first() {\n  return 1;\n}\n\nfunction second() {\n  return 2;\n}\n';
  const tail = 'function last() {\n  return 1;\n}\n\n// Keep this note with the function above.\n';
  const python = 'def a():\n    return 1\n\n@cache\ndef b():\n    return 2\n';
  const callback = [
    'jQuery(function () {',
    '  function open() {',
    '    return 1;',
    '  }',
    '});',
    '',
    'function close() {',
    '  return 2;',
    '}',
    '',
  ].join('\n');

  it('keeps the fields before the first method and the closing brace of a class', () => {
    const sections = byId(store, 'store.ts');

    expect(sections.get('function-get')).toContain('private cache = new Map<string, number>();');
    expect(sections.get('function-get')).toContain('readonly limit = 10;');
    expect(sections.get('function-clear')).toBe('clear() {\n    this.cache.clear();\n  }\n}');
  });

  it('keeps what follows a brace inside a string with the member that holds it', () => {
    expect(byId(handlers, 'handlers.js').get('function-foo')).toContain(
      'callCriticalThing(marker)',
    );
  });

  it('puts a decorator and a field between two methods into the later method', () => {
    const sections = byId(decorated, 'panel.ts');

    expect(sections.get('function-close')!.startsWith('@Input()\n  readonly size = 2;')).toBe(true);
    expect(sections.get('function-open')).not.toContain('@Input()');
  });

  it('puts a PHP property between two methods into the later method', () => {
    const sections = byId(property, 'Panel.php');

    expect(sections.get('method-Panel-close')).toContain('private $a = 1;');
    expect(sections.get('method-Panel-open')).not.toContain('private $a = 1;');
  });

  it('puts a decorator between two Python functions into the later one', () => {
    const sections = byId(python, 'jobs.py');

    expect(sections.get('function-b')).toContain('@cache\ndef b():');
    expect(sections.get('function-a')).not.toContain('@cache');
  });

  it('puts a short PHP head into the first section', () => {
    expect(byId(head, 'm.module').get('function-first')).toBe(
      '<?php\n\nnamespace App\\Lib;\n\nuse Foo\\Bar;\n\nfunction first() {\n  return 1;\n}',
    );
  });

  it('puts a short note after the last section into that section', () => {
    expect(byId(tail, 'last.js').get('function-last')).toContain(
      '// Keep this note with the function above.',
    );
  });

  it('keeps a closing line without a word with the section it closes', () => {
    const sections = byId(callback, 'ready.js');

    expect(sections.get('function-open')).toContain('\n});');
    expect(sections.get('function-close')).toBe('function close() {\n  return 2;\n}');
  });

  it('reads letters outside ASCII as words, so a span of them leads the section after it', () => {
    const js = 'function a() {\n  return 1;\n}\n名前;\nfunction b() {\n  return 2;\n}\n';
    const sections = byId(js, 'names.js');

    expect(sections.get('function-a')).toBe('function a() {\n  return 1;\n}');
    expect(sections.get('function-b')!.startsWith('名前;\nfunction b() {')).toBe(true);
  });

  it.each([
    ['a class with fields', store, 'store.ts'],
    ['a brace inside a string', handlers, 'handlers.js'],
    ['a decorator between methods', decorated, 'panel.ts'],
    ['a PHP property between methods', property, 'Panel.php'],
    ['a PHP head', head, 'm.module'],
    ['a note after the last function', tail, 'last.js'],
    ['a Python decorator', python, 'jobs.py'],
    ['a closing line between functions', callback, 'ready.js'],
    [
      'a PHP class',
      '<?php\nclass Foo {\n  public function bar() {\n    return 1;\n  }\n}\n',
      'Foo.php',
    ],
    [
      'a typed async arrow',
      'export const parse = async (raw: string): Promise<Item[]> => {\n  return read(raw);\n};\n',
      'mod.ts',
    ],
    [
      'a double-quoted function',
      'var t = {\n  "parent": function (a, b) {\n    return a + b;\n  },\n};\n',
      'table.ts',
    ],
  ])('loses no text of %s', (_what, src, file) => {
    const sections = extractCodeSections(src, file);

    expect(sections.length).toBeGreaterThan(0);
    expect(withoutSpace(sections.map((s) => s.content).join(''))).toBe(withoutSpace(src));
  });

  it('gives a file with no construct and fewer than 120 characters no section', () => {
    const comment = (length: number) => `// ${'x'.repeat(length - 3)}\n`;

    expect(extractCodeSections(comment(119), 'note.js')).toEqual([]);
    expect(extractCodeSections(comment(120), 'note.js').map((s) => s.sectionId)).toEqual([
      'chunk-0',
    ]);
  });

  it('still numbers the spans of 120 characters or more as their own sections', () => {
    const note = `// ${'x'.repeat(117)}\n`;
    const js = `'use strict';\nfunction f() {\n  return 1;\n} // one\nfunction g() {\n  return 2;\n}\n${note}var x = 1;\nfunction h() {\n  return 3;\n}\n${note}`;

    expect(extractCodeSections(js, 'f.js').map((s) => s.sectionId)).toEqual([
      'function-f',
      'function-g',
      'chunk-0',
      'function-h',
      'chunk-1',
    ]);
  });
});

describe('maskNonCode', () => {
  const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
  const shape = (text: string) => text.replace(/[^\r\n]/g, 'x');

  it.each([
    ['php', "<?php\r\n// é𝒜 {\r\n$a = '{';\r\n?>\r\n<b>{</b>\r\n"],
    ['js', "var a = '{'; // é𝒜 }\r\nvar b = `x\r\n${y}`;\r\n/*\r\n } */\r\n"],
  ] as const)('keeps the length and the line ends of %s source', (syntax, src) => {
    const masked = maskNonCode(src, syntax);

    expect(masked).not.toBe(src);
    expect(shape(masked)).toBe(shape(src));
  });

  // Every brace below sits in a comment, a string or inline HTML; `$ok = 1;` is code after it.
  it.each([
    ['a // comment', '// {'],
    ['a # comment', '# }'],
    ['a block comment', '/* { */'],
    ['a docblock', '/** } */'],
    ['a single-quoted string', "$a = '{';"],
    ['a double-quoted string', '$a = "}";'],
    ['an escaped quote', "$a = 'it\\'s {';"],
    ['an interpolation holding quotes', String.raw`$a = "say \"{\" {$b['}']} {$c["{"]}";`],
    ['a backtick string', '$a = `echo {`;'],
    ['a heredoc', '$a = <<<EOT\n{ "}"\nEOT;'],
    ['an indented heredoc closing', '$a = <<<EOT\n  {\n  EOT;'],
    ['a nowdoc', "$a = <<<'EOT'\n{ $b }\nEOT;"],
    ['a heredoc with a body line that only starts with the label', '$a = <<<EOT\nEOTX {\n}\nEOT;'],
    ['a ${} interpolation holding quotes', '$a = "a ${b["}"]} c";'],
    ['inline HTML', '?>\n<div>{</div>\n<?php'],
    ['inline HTML around an echo tag', '?><b>{</b><?= $x ?><i>}</i><?php'],
    ['a // comment that a close tag ends', '// a ?> } <?php'],
  ])('blanks %s of a PHP file', (_what, snippet) => {
    const src = `<?php\n${snippet}\n$ok = 1;\n`;
    const masked = maskNonCode(src, 'php');

    expect(masked).not.toMatch(/[{}]/);
    expect(masked).toContain('$ok = 1;');
    expect(shape(masked)).toBe(shape(src));
  });

  it('blanks the text before the first open tag and keeps the code after a close tag', () => {
    expect(maskNonCode('#!/usr/bin/env php\n{\n<?php $ok = 1;', 'php')).toBe(
      `${blank('#!/usr/bin/env php')}\n${blank('{')}\n<?php $ok = 1;`,
    );
    expect(maskNonCode('<?php $a = 1; ?>\n{\n<?php $ok = 2;', 'php')).toBe(
      `<?php $a = 1; ?>\n${blank('{')}\n<?php $ok = 2;`,
    );
  });

  it('reads a file with no open tag as inline HTML, and a short open tag as an open tag', () => {
    expect(maskNonCode("<footer>{ 'x' }</footer>\n", 'php')).toBe(
      `${blank("<footer>{ 'x' }</footer>")}\n`,
    );
    expect(maskNonCode('<?xml version="1.0"?>\n<root>{</root>\n', 'php')).toBe(
      `${blank('<?xml version="1.0"?>')}\n${blank('<root>{</root>')}\n`,
    );
    expect(maskNonCode("<? $a = '{'; ?>\n", 'php')).toBe(`<? $a = '${blank('{')}'; ?>\n`);
  });

  it('ends a // comment at a close tag and reads the code that follows it', () => {
    expect(maskNonCode('<?php // a { ?> <b>}</b> <?php $ok = 1;', 'php')).toBe(
      `<?php //${blank(' a { ')}?>${blank(' <b>}</b> ')}<?php $ok = 1;`,
    );
  });

  it('reads the code of an echo tag, and <?php glued to a word as no tag', () => {
    expect(maskNonCode('<b>{</b><?= $x ?><i>}</i>\n<?php $ok = 1;', 'php')).toBe(
      `${blank('<b>{</b>')}<?= $x ?>${blank('<i>}</i>')}\n<?php $ok = 1;`,
    );
    expect(maskNonCode('<?phpx {\n<?php $ok = 1;', 'php')).toBe(
      `${blank('<?phpx {')}\n<?php $ok = 1;`,
    );
  });

  it('keeps delimiters, the docblock opener and an attribute', () => {
    expect(maskNonCode("<?php\n/** Doc */\n/* c */\n# d\n#[Attr('x')]\n", 'php')).toBe(
      `<?php\n/**${blank(' Doc ')}*/\n/*${blank(' c ')}*/\n#${blank(' d')}\n#[Attr('${blank('x')}')]\n`,
    );
  });

  // Every brace below sits in a comment, a string, a template or a regex literal.
  it.each([
    ['a // comment', '// {'],
    ['a block comment', '/* } */'],
    ['a single-quoted string', "var a = '{';"],
    ['a double-quoted string', 'var a = "}";'],
    ['an escaped quote', "var a = 'it\\'s {';"],
    ['a template', 'var a = `{`;'],
    ['a template holding expressions', "var a = `a ${ f({ x: '}' }) } ${ `n${'{'}` } {`;"],
    ['a regex class', 'var a = /[{}]/g;'],
    ['an escaped slash in a regex', 'var a = /\\/{/;'],
    ['a regex after return', 'return /{/.test(s);'],
    ['a regex after a parenthesis', 'f(/{/);'],
    ['a regex that starts with a bracket', 'f(/>{/);'],
    ['a slash inside a regex class', 'f(/[/]{/);'],
    ['a string on the line after a // comment', "// c\n'{';"],
    ['an escaped backtick in a template', 'var a = `a \\` { b`;'],
    ['a regex after a comma', 'f(a, /}/);'],
    ['a regex after an arrow', 'var f = () => /}/;'],
  ])('blanks %s of a JS file', (_what, snippet) => {
    const src = `${snippet}\nok();\n`;
    const masked = maskNonCode(src, 'js');

    expect(masked).not.toMatch(/[{}]/);
    expect(masked).toContain('ok();');
    expect(shape(masked)).toBe(shape(src));
  });

  it('reads a slash as division or markup, not as a regex, after an operand', () => {
    for (const src of [
      'x = a / b / c;\n',
      'x = (a + b) / 2 + y[0] / 3 + 4 / 5;\n',
      'x = 1 / 2 / 3;\nx = "k" / 2 / 3;\n',
      'var h = <p>{a}</p> <b>{b}</b>;\nvar i = <br />;\n',
      'var h = <p>{a}/{b}</p>;\nvar i = <p>/usr/bin</p>;\n',
      'x = a++ / 2;\ny = b / 3;\n',
    ]) {
      expect(maskNonCode(src, 'js')).toBe(src);
    }
  });

  it('reads a slash after a keyword used as a property name, a dot, or a literal as division', () => {
    for (const src of [
      'var a = o.in / 2 / b;\n',
      'var a = o.else / 2 / b;\n',
      'var h = <p>run ./haive upgrade</p>;\n',
      'x = 1.5 / 2 / 3;\n',
      '\u540d\u524d / 2 / 3;\n',
    ]) {
      expect(maskNonCode(src, 'js')).toBe(src);
    }
    expect(maskNonCode('x = /a/ / 2 / 3;\n', 'js')).toBe(`x = /${blank('a')}/ / 2 / 3;\n`);
    expect(maskNonCode('x = `t` / 2 / 3;\n', 'js')).toBe(`x = \`${blank('t')}\` / 2 / 3;\n`);
  });

  it('reads a regex after export default and after every keyword that takes an operand', () => {
    expect(maskNonCode('export default /{/;\n', 'js')).toBe(`export default /${blank('{')}/;\n`);
    for (const word of [
      'return',
      'typeof',
      'instanceof',
      'in',
      'of',
      'new',
      'delete',
      'void',
      'throw',
      'case',
      'do',
      'else',
      'yield',
      'await',
    ]) {
      expect(maskNonCode(`${word} /{/.test(s);\n`, 'js')).not.toMatch(/[{}]/);
    }
    expect(maskNonCode('/{/.test(s);\n', 'js')).toBe(`/${blank('{')}/.test(s);\n`);
    expect(maskNonCode('x = [.../a/.exec(s)];\n', 'js')).toBe(
      `x = [.../${blank('a')}/.exec(s)];\n`,
    );
  });

  it('reads a regex of up to 20000 characters whole, and a division no further than that', () => {
    const body = `[${'a'.repeat(1500)}\`]`;
    expect(maskNonCode(`var r = /${body}/;\nvar t = \`x\`;\n`, 'js')).toBe(
      `var r = /${blank(body)}/;\nvar t = \`${blank('x')}\`;\n`,
    );
    const far = `x = a++ / 2;${'var v = 1;'.repeat(3000)}y = b / 3;\n`;
    expect(maskNonCode(far, 'js')).toBe(far);
  });

  it('blanks a template whose expression holds braces and another template', () => {
    expect(maskNonCode('var a = `${ {x:1}.x + `inner` } tail`;', 'js')).toBe(
      `var a = \`${blank('${ {x:1}.x + `inner` } tail')}\`;`,
    );
  });

  it('keeps a string that is a bare name, as a key reads as a name', () => {
    expect(maskNonCode("var t = { 'a_b': 1, \"c\": 2, 'd e': 3 };\n", 'js')).toBe(
      `var t = { 'a_b': 1, "c": 2, '${blank('d e')}': 3 };\n`,
    );
  });

  it('reads an unterminated template as text and lexes on', () => {
    expect(maskNonCode('var a = `x {\nok();', 'js')).toBe('var a = `x {\nok();');
  });

  it('reads a quote with no closing quote on its line as text, as an apostrophe in markup is', () => {
    for (const src of [
      "var a = 'x {\nok();",
      "var h = <p>Don't {x}</p>;\n",
      'String t = """\n  { it\'s "x" }\n  """;\n',
      'a = "{',
    ]) {
      expect(maskNonCode(src, 'js')).toBe(src);
    }
    expect(maskNonCode("var s = 'a\\\r\n{ b';\r\nok();", 'js')).toBe(
      `var s = '${blank('a\\\r\n{ b')}';\r\nok();`,
    );
  });

  it('gives up on regex literals after a few slashes on a line that closed none', () => {
    const src = `x=${'/['.repeat(1_000_000)}\n`;
    const started = performance.now();

    expect(maskNonCode(src, 'js').length).toBe(src.length);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe('extractCodeSections — braces that are not code', () => {
  const NEXT = 'function next_one() {\n  return 1;\n}';
  const sectionsOf = (src: string, file: string) =>
    new Map(extractCodeSections(src, file).map((s) => [s.sectionId, s.content]));

  it.each([
    ['a // comment', '  // {'],
    ['a block comment', '  /* } */'],
    ['a block comment that ends its line on the brace', '  /*\n}\n  */'],
    ['a single-quoted string', "  var s = '{';"],
    ['a double-quoted string', '  var s = "}";'],
    ['a template literal', '  var s = `{`;'],
    ['a template literal that ends its line on the brace', '  var s = `\n}\n`;'],
    ['a regex literal', '  var s = /}/;'],
  ])('ends a JS function at its own closing brace past %s', (_what, body) => {
    const src = `function host(v) {\n${body}\n  return 'end-of-host';\n}\n\n${NEXT}\n`;
    const sections = sectionsOf(src, 'host.js');

    expect([...sections.keys()]).toEqual(['function-host', 'function-next_one']);
    expect(sections.get('function-host')).toContain("'end-of-host'");
    expect(sections.get('function-next_one')).toBe(NEXT);
  });

  it.each([
    ['a // comment', '  // {'],
    ['a # comment', '  # }'],
    ['a block comment', '  /* { */'],
    ['a block comment that ends its line on the brace', '  /*\n}\n  */'],
    ['a single-quoted string', "  $s = '{';"],
    ['a double-quoted string', '  $s = "}";'],
    ['a heredoc', '  $s = <<<EOT\n{\nEOT;'],
    ['a nowdoc', "  $s = <<<'EOT'\n}\nEOT;"],
    ['a double-quoted string over two lines', '  $s = "a\n}";'],
    ['inline HTML', '  ?>\n<b>{</b>\n<?php'],
  ])('ends a PHP function at its own closing brace past %s', (_what, body) => {
    const src = `<?php\nfunction host($v) {\n${body}\n  return 'end-of-host';\n}\n\n${NEXT}\n`;
    const sections = sectionsOf(src, 'host.module');

    expect([...sections.keys()]).toEqual(['function-host', 'function-next_one']);
    expect(sections.get('function-host')).toContain("'end-of-host'");
    expect(sections.get('function-next_one')).toBe(NEXT);
  });

  it.each([
    ['PHP', '<?php\nfunction f($a /* ) */, $b = 1) {\n  return $b;\n}\n', 'f.module', 'function-f'],
    ['JS', "function g(a /* ' ) */, b) {\n  return b;\n}\n", 'g.js', 'function-g'],
  ])('reads a %s signature past a parenthesis in a comment', (_lang, src, file, id) => {
    expect(extractCodeSections(src, file).map((s) => s.sectionId)).toEqual([id]);
  });

  it.each([
    [
      'eight regexes of 1200 characters on one line, then a quote in a regex',
      `${`var r = /[${'a'.repeat(1200)}]/;`.repeat(8)}var s = /'/;function f() {return 1;}function g() {return 2;}\n`,
      ['function-f', 'function-g'],
    ],
    [
      'a backtick in a regex of over 1000 characters',
      `const re = /[${'a'.repeat(1001)}\`]/;\nfunction one() {\n  return 1;\n}\nconst t = \`x\`;\nfunction two() {\n  return 2;\n}\n`,
      ['function-one', 'function-two'],
    ],
    [
      'export default of a regex holding a backtick',
      'export default /`/;\nfunction one() {\n  return 1;\n}\nconst t = `x`;\nfunction two() {\n  return 2;\n}\n',
      ['function-one', 'function-two'],
    ],
  ])('keeps the functions that follow %s', (_what, src, expected) => {
    const found = extractCodeSections(src, 'bundle.js').map((s) => s.sectionId);

    expect(found.filter((id) => !id.startsWith('chunk-'))).toEqual(expected);
  });

  it('ends a JSX component at its own closing brace past an apostrophe in its text', () => {
    const tsx = [
      'export function Banner({ items }) {',
      '  return (',
      '    <p>',
      "      You don't have any items. {items.length > 0 && (",
      '        <span>some</span>',
      '      )}',
      '    </p>',
      '  );',
      '}',
      '',
      'export function Other() {',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    const sections = sectionsOf(tsx, 'banner.tsx');

    expect(sections.get('function-Banner')!.endsWith('    </p>\n  );\n}')).toBe(true);
    expect(sections.get('function-Other')!.startsWith('export function Other() {')).toBe(true);
  });

  it('keeps the sections after a backtick in JSX text that never closes', () => {
    const tsx =
      'function Example() { return <p>Press the ` key</p>; }\nexport function save() { persist(); }\n';
    const sections = sectionsOf(tsx, 'example.tsx');

    expect(sections.has('function-Example')).toBe(true);
    expect(sections.get('function-save')).toBe('export function save() { persist(); }');
  });

  it('keeps the sections around a URL in JSX text', () => {
    const tsx =
      'function First(){ return <p>https://example.com</p>; }\nfunction second(){ return 1; }\n';
    const sections = sectionsOf(tsx, 'url.tsx');

    expect(sections.has('function-First')).toBe(true);
    expect(sections.has('function-second')).toBe(true);
  });

  it('keeps the sections after a regex that follows a condition and holds a slash-star', () => {
    const js = 'function first(x) { if (x) /[/*]/.test(x); }\nfunction second() { return 2; }\n';
    const sections = sectionsOf(js, 'cond.js');

    expect(sections.has('function-first')).toBe(true);
    expect(sections.has('function-second')).toBe(true);
  });

  it('ends an object-literal member at its own closing brace', () => {
    const src = [
      'var api = {',
      '  first() {',
      "    var s = '}';",
      "    return 'end-of-first';",
      '  },',
      '  second() {',
      '    return 2;',
      '  },',
      '};',
      '',
    ].join('\n');
    const sections = sectionsOf(src, 'api.js');

    expect([...sections.keys()]).toEqual(['function-first', 'function-second']);
    expect(sections.get('function-first')).toContain("'end-of-first'");
    expect(sections.get('function-second')).toBe('second() {\n    return 2;\n  },\n};');
  });

  it.each([
    ['a JS comment', '// function fake(a) {\nif (x) {\n  y();\n}\n', 'fake.js'],
    ['a JS string', "var s = 'function fake(a) {';\nif (x) {\n  y();\n}\n", 'fake.js'],
    [
      'a template literal',
      'var s = `\nfunction fake(a) {\n}\n`;\nif (x) {\n  y();\n}\n',
      'fake.js',
    ],
    ['a PHP comment', '<?php\n// function fake($a) {\nif ($x) {\n  y();\n}\n', 'fake.module'],
    [
      'PHP inline HTML',
      '<?php\n?>\n<script>function fake(a) {}</script>\n<?php\nif ($x) {\n  y();\n}\n',
      'fake.php',
    ],
    [
      'a PHP file with no open tag',
      '<html>\n<script>function fake(a) {}</script>\n</html>\n',
      'view.blade.php',
    ],
  ])('finds no function in %s', (_what, src, file) => {
    expect(extractCodeSections(src, file).map((s) => s.sectionId)).not.toContain('function-fake');
  });
});

describe('extractCodeSections — class names', () => {
  const ids = (src: string, file: string) => extractCodeSections(src, file).map((s) => s.sectionId);
  const REAL = 'class Real {\n  public function one($x) {\n    return $x;\n  }\n}\n';

  it.each([
    ['a docblock', '/**\n * Base class for export UI.\n */\n'],
    ['a // comment', '// This class is the owner.\n'],
    ['a # comment', '# a class name goes here\n'],
    ['a block comment', '/* The class is documented below. */\n'],
    ['a block comment holding a class body', '/* class Fake { */\n'],
  ])(
    'names a PHP method after the class that holds it, not after a word in %s',
    (_what, before) => {
      const sections = extractCodeSections(`<?php\n${before}${REAL}`, 'Real.php');
      const method = sections.find((s) => s.content.includes('function one'));

      expect(method?.sectionId).toBe('method-Real-one');
      expect(method?.breadcrumb).toEqual(['class Real', 'function one']);
    },
  );

  it('names a PHP function that no class holds after itself, whatever a comment before it says of a class', () => {
    const php = [
      '<?php',
      "define('X', 1);",
      '',
      '/**',
      ' * Style the .button class or leave it alone.',
      ' */',
      '',
      '/**',
      ' * Picks one.',
      ' */',
      'function pick() {',
      '  return 1;',
      '}',
      '',
    ].join('\n');

    expect(ids(php, 'pick.module')).toEqual(['function-pick']);
  });

  it('names a method after a class declared with upper-case keywords', () => {
    const php = '<?php\nCLASS Real {\n  PUBLIC FUNCTION one($x) {\n    return $x;\n  }\n}\n';

    expect(ids(php, 'Real.php')).toEqual(['method-Real-one']);
  });

  it('reads no JS class from a comment that ends with the word class', () => {
    const js = '// Skip class Foo\n{\n  run();\n}\n\nfunction real() {\n  return 1;\n}\n';

    expect(ids(js, 'skip.js')).not.toContain('class-Foo');
  });
});

describe('extractCodeSections — a keyword in a comment', () => {
  const ids = (src: string, file: string) => extractCodeSections(src, file).map((s) => s.sectionId);
  const REAL = 'function real() {\n  return 1;\n}\n';

  it.each([
    ['if', 'if ($x) {'],
    ['while', 'while ($x) {'],
    ['foreach', 'foreach ($xs as $x) {'],
    ['switch', 'switch ($x) {'],
  ])(
    'finds no PHP function named %s after a comment that ends with the word function',
    (_n, head) => {
      const php = `<?php\n// call this function\n${head}\n  y();\n}\n\n${REAL}`;

      expect(ids(php, 'call.module')).toEqual(['function-real']);
    },
  );

  it('finds no function in a Java comment that ends with the word function', () => {
    const java =
      'public class Box {\n  // the mapping function\n  Box(int x) {\n    this.x = x;\n  }\n}\n';

    expect(ids(java, 'Box.java')).toEqual(['class-Box']);
  });
});

describe('extractCodeSections — closing lines in front of a head', () => {
  const byId = (src: string, file: string) =>
    new Map(extractCodeSections(src, file).map((s) => [s.sectionId, s.content]));
  const withoutSpace = (text: string) => text.replace(/\s+/g, '');

  const members = [
    'var table = {',
    '  inner: {',
    '    last: function () {',
    '      return 1;',
    '    }',
    '  },',
    '  customize: function customize() {',
    '    return 2;',
    '  },',
    '};',
    '',
  ].join('\n');
  const classes = [
    '<?php',
    'class A {',
    '  public function last() {',
    '    return 1;',
    '  }',
    '}',
    '',
    'class B {',
    '  public function first() {',
    '    return 2;',
    '  }',
    '}',
    '',
  ].join('\n');
  const noted = [
    'var table = {',
    '  inner: {',
    '    last: function () {',
    '      return 1;',
    '    }',
    '  }',
    '};',
    '/**',
    ' * Notes the offset.',
    ' */',
    'var offset = 1;',
    'function next() {',
    '  return offset;',
    '}',
    '',
  ].join('\n');

  it('keeps the closing lines of a JS object with the member they close', () => {
    const sections = byId(members, 'table.js');

    expect(sections.get('function-last')!.endsWith('    }\n  },')).toBe(true);
    expect(
      sections.get('function-customize')!.startsWith('customize: function customize() {'),
    ).toBe(true);
  });

  it('keeps a closing bracket, parenthesis and semicolon with the member they close', () => {
    const js = [
      'register([',
      '  {',
      '    run: function () {',
      '      return 1;',
      '    }',
      '  }',
      ']);',
      'var x = 1;',
      'function after() {',
      '  return x;',
      '}',
      '',
    ].join('\n');
    const sections = byId(js, 'register.js');

    expect(sections.get('function-run')!.endsWith('  }\n]);')).toBe(true);
    expect(sections.get('function-after')!.startsWith('var x = 1;\nfunction after() {')).toBe(true);
  });

  it('keeps the closing brace of a PHP class with its last method and the next class head with its first', () => {
    const sections = byId(classes, 'AB.php');

    expect(sections.get('method-A-last')!.endsWith('  }\n}')).toBe(true);
    expect(
      sections.get('method-B-first')!.startsWith('class B {\n  public function first() {'),
    ).toBe(true);
  });

  it('does not part a comment from its body, whatever closes in front of it', () => {
    const sections = byId(noted, 'noted.js');

    expect(sections.get('function-last')!.endsWith('  }\n};')).toBe(true);
    expect(
      sections.get('function-next')!.startsWith('/**\n * Notes the offset.\n */\nvar offset = 1;'),
    ).toBe(true);
  });

  it.each([
    ['closing lines and a head', members, 'table.js'],
    ['two classes', classes, 'AB.php'],
    ['a comment behind closing lines', noted, 'noted.js'],
  ])('loses no text of %s', (_what, src, file) => {
    const sections = extractCodeSections(src, file);

    expect(withoutSpace(sections.map((s) => s.content).join(''))).toBe(withoutSpace(src));
  });
});

describe('extractCodeSections — Ruby definitions', () => {
  const byId = (src: string, file: string) =>
    new Map(extractCodeSections(src, file).map((s) => [s.sectionId, s.content]));
  const ruby = [
    'require "x"',
    '',
    'MAX = 5',
    '',
    'def a',
    '  if MAX > 1',
    '    1',
    '  end',
    'end # a',
    '',
    'FLAG = true',
    '',
    'def b',
    '  2',
    'end',
    '',
  ].join('\n');

  it('ends a Ruby method after its own end and lets the constant lead the method after it', () => {
    const sections = byId(ruby, 'jobs.rb');

    expect(sections.get('function-a')!.trimEnd().endsWith('  end\nend # a')).toBe(true);
    expect(sections.get('function-b')!.startsWith('FLAG = true\n\ndef b\n  2\nend')).toBe(true);
  });

  it('ends a Ruby class after its own end', () => {
    const rb =
      'class Box\n  def size\n    1\n  end\nend\n\nBOX = Box.new\n\ndef make\n  BOX\nend\n';
    const sections = byId(rb, 'box.rb');

    expect(sections.get('class-Box')!.trimEnd().endsWith('  end\nend')).toBe(true);
    expect(sections.get('function-make')!.startsWith('BOX = Box.new\n\ndef make')).toBe(true);
  });

  it('takes the end of its own block only, and only a line that starts with the word', () => {
    const rb = [
      'module Util',
      '  def a = 1',
      'end',
      '',
      'ending = 1',
      '',
      'def b',
      '  2',
      'end',
      '',
    ].join('\n');
    const sections = byId(rb, 'util.rb');

    expect(sections.get('function-a')!.trimEnd().endsWith('  def a = 1')).toBe(true);
    expect(sections.get('function-b')!.startsWith('end\n\nending = 1\n\ndef b')).toBe(true);
  });

  it('ends a Ruby method that has rescue, else and ensure clauses after its own end', () => {
    const rb = [
      'def a',
      '  work',
      'rescue => e',
      '  handle(e)',
      'else',
      '  ok',
      'ensure',
      '  done',
      'end',
      '',
      'def b',
      '  2',
      'end',
      '',
    ].join('\n');
    const sections = byId(rb, 'a.rb');

    expect(sections.get('function-a')!.trimEnd().endsWith('ensure\n  done\nend')).toBe(true);
    expect(sections.get('function-b')!.startsWith('def b')).toBe(true);
  });

  it('does not read a Python line that starts with rescue as part of a definition', () => {
    const sections = byId(
      'def a():\n    return 1\n\nrescue = 3\n\ndef b():\n    return 2\n',
      'a.py',
    );

    expect(sections.get('function-a')).not.toContain('rescue');
  });

  it('does not read a line that only starts with the letters end as an end', () => {
    const sections = byId('def a\n  1\nendpoint = 2\n\ndef b\n  2\nend\n', 'a.rb');

    expect(sections.get('function-a')).not.toContain('endpoint');
    expect(sections.get('function-b')!.startsWith('endpoint = 2\n\ndef b')).toBe(true);
  });

  it('does not read a Python line that starts with end as the end of a definition', () => {
    const py = 'def a():\n    return 1\n\nend = 3\n\ndef b():\n    return 2\n';
    const sections = byId(py, 'jobs.py');

    expect(sections.get('function-a')).not.toContain('end = 3');
    expect(sections.get('function-b')!.startsWith('end = 3\n\ndef b')).toBe(true);
  });

  it('loses no text of a Ruby file', () => {
    const sections = extractCodeSections(ruby, 'jobs.rb');

    expect(
      sections
        .map((s) => s.content)
        .join('')
        .replace(/\s+/g, ''),
    ).toBe(ruby.replace(/\s+/g, ''));
  });
});

describe('chunkSection', () => {
  it('splits a long section without losing any region', () => {
    const content = markedBody(10_000);
    const chunks = chunkSection({ sectionId: 's', content, breadcrumb: [] });

    expect(chunks.length).toBeGreaterThan(4);
    expect(marksIn(chunks.map((c) => c.content).join('\n'))).toEqual(marksIn(content));
    // Chunk indexes are dense and ordered — they are half of the row identity.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('prepends the header to EVERY chunk and folds it into the hash', () => {
    const content = markedBody(6000);
    const plain = chunkSection({ sectionId: 's', content, breadcrumb: [] });
    const withHeader = chunkSection(
      { sectionId: 's', content, breadcrumb: ['class Foo'] },
      { header: contextHeader('src/Foo.php', ['class Foo']) },
    );

    expect(withHeader.length).toBe(plain.length);
    for (const c of withHeader) {
      expect(c.content.startsWith('[src/Foo.php > class Foo]')).toBe(true);
    }
    // A changed header must force a re-embed, so the hash cannot ignore it.
    expect(withHeader[0]!.chunkHash).not.toBe(plain[0]!.chunkHash);
  });

  it('is byte-identical to the header-less form when no header is given', () => {
    const section = { sectionId: 's', content: markedBody(6000), breadcrumb: [] };
    expect(chunkSection(section, {})).toEqual(chunkSection(section));
  });

  it('splits a long section of single-newline lines at a line end', () => {
    const rows = Array.from(
      { length: 120 },
      (_, i) => `row ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`,
    );
    const chunks = chunkSection({ sectionId: 's', content: rows.join('\n'), breadcrumb: [] });

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.content.endsWith('\n')).toBe(true);
  });

  it('orders its split points: paragraph, then line, then sentence', () => {
    const rows = (from: number, to: number) =>
      Array.from(
        { length: to - from },
        (_, i) => `row ${String(from + i).padStart(3, '0')} ${'x'.repeat(40)}`,
      ).join('\n');
    const split = (content: string) =>
      chunkSection({ sectionId: 's', content, breadcrumb: [] })[0]!.content;

    // A blank line past half the size beats the later line end.
    expect(split(`${rows(0, 25)}\n\n${rows(25, 41)}`).endsWith('\n\n')).toBe(true);
    // A line end past half the size beats a sentence end inside the long line after it.
    const prose = 'First sentence. '.repeat(60);
    const first = split(`${rows(0, 30)}\n${prose}`);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
  });
});

describe('contextHeader', () => {
  it('joins the root with the breadcrumb', () => {
    expect(contextHeader('src/Foo.php', ['class Foo', 'function bar'])).toBe(
      'src/Foo.php > class Foo > function bar',
    );
  });

  it('collapses a repeat of the root (a KB entry whose H1 is its title)', () => {
    expect(contextHeader('ext/mysql Quick Reference', ['ext/mysql Quick Reference', 'Usage'])).toBe(
      'ext/mysql Quick Reference > Usage',
    );
  });
});

describe('capChunks', () => {
  it('keeps the budget and reports what it dropped', () => {
    const chunks = chunkSection({
      sectionId: 's',
      content: markedBody(2000 * (MAX_CHUNKS_PER_FILE + 40)),
      breadcrumb: [],
    });
    expect(chunks.length).toBeGreaterThan(MAX_CHUNKS_PER_FILE);

    const capped = capChunks(chunks);
    expect(capped.chunks.length).toBe(MAX_CHUNKS_PER_FILE);
    expect(capped.dropped).toBe(chunks.length - MAX_CHUNKS_PER_FILE);
  });

  it('reports nothing dropped when under budget', () => {
    const chunks = chunkSection({ sectionId: 's', content: 'short', breadcrumb: [] });
    expect(capChunks(chunks)).toEqual({ chunks, dropped: 0 });
  });
});

describe('fileBudget', () => {
  const own = { maxBytes: MAX_OWN_FILE_BYTES, maxChunks: Infinity };
  const other = { maxBytes: MAX_FILE_BYTES, maxChunks: MAX_CHUNKS_PER_FILE };

  it('exempts a knowledge base file whatever the own paths are', () => {
    expect(fileBudget('.haive-data/knowledge_base/a.md', 'kb', [])).toEqual(own);
  });

  it('exempts code under an own path, with or without a trailing slash', () => {
    const rel = 'sites/all/modules/activit/x.inc';
    expect(fileBudget(rel, 'code', ['sites/all/modules/activit/'])).toEqual(own);
    expect(fileBudget(rel, 'code', ['sites/all/modules/activit'])).toEqual(own);
  });

  it('exempts a single-file own path, such as a one-file WordPress plugin', () => {
    const plugin = 'wp-content/plugins/client-hooks.php';
    expect(fileBudget(plugin, 'code', [plugin])).toEqual(own);
    expect(fileBudget(`${plugin}.bak`, 'code', [plugin])).toEqual(other);
  });

  it('keeps the budgets for a sibling directory that only shares the prefix', () => {
    expect(
      fileBudget('sites/all/modules/activit2/x.inc', 'code', ['sites/all/modules/activit/']),
    ).toEqual(other);
  });

  it('keeps the budgets for other code', () => {
    expect(
      fileBudget('sites/all/modules/views/x.inc', 'code', ['sites/all/modules/activit/']),
    ).toEqual(other);
    expect(fileBudget('sites/all/modules/activit/x.inc', 'code', [])).toEqual(other);
  });
});
