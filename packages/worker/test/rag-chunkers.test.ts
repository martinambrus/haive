import { describe, it, expect } from 'vitest';
import {
  extractMarkdownSections,
  extractCodeSections,
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
    expect(section?.content.startsWith(head)).toBe(true);
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
    expect(byId.get('method-Base-sealed')!.startsWith('final public function sealed')).toBe(true);
    expect(byId.get('method-Base-stamp')!.startsWith('static protected final function')).toBe(true);
    expect(byId.get('method-Base-Shouty')!.startsWith('Public Static Function Shouty')).toBe(true);
  });
});

describe('extractCodeSections — JS and TS named constructs', () => {
  // A section starts at the keyword, not at an export or async before it: that text is outside it.
  it.each([
    [
      'a typed function with nested parentheses',
      'export function load(cb: (err: Error | null, rows: Row[]) => void, n = Math.max(1, 2)): Promise<void> {\n  return run(cb, n);\n}\n',
      'load',
      'function load(cb:',
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
      'function main(',
    ],
    [
      'a typed async arrow',
      'export const parse = async (raw: string): Promise<Item[]> => {\n  return read(raw);\n};\n',
      'parse',
      'const parse = async (raw',
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
    expect(section?.content.endsWith('}')).toBe(true);
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
    expect(section?.content.startsWith(startsWith)).toBe(true);
    expect(section?.content.endsWith('}')).toBe(true);
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

  it.each([
    ['a // run', '// Adds two numbers.\n// Returns the sum.\n'],
    ['a block', '/* Adds two numbers. */\n'],
    ['a JSDoc block', '/**\n * Adds two numbers.\n * @returns {number}\n */\n'],
  ])('joins %s to the function it precedes', (_what, comment) => {
    const js = `'use strict';\n\n${comment}function add(a, b) {\n  return a + b;\n}\n`;

    expect(byId(js, 'math.js').get('function-add')).toBe(
      `${comment}function add(a, b) {\n  return a + b;\n}`,
    );
  });

  it('joins a comment to the member, the arrow and the class it precedes', () => {
    const js = [
      'var api = {',
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
      "'use strict';",
      '',
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
    ['a block', '/**\n * @file Math helpers.\n */\n'],
    ['a // run', '// Math helpers.\n// Licensed under MIT.\n'],
  ])('keeps %s that opens the file out of the first function', (_what, header) => {
    const js = `${header}function first() {\n  return 1;\n}\n\n// Adds two numbers.\nfunction second() {\n  return 2;\n}\n`;
    const sections = byId(js, 'math.js');

    expect(sections.get('function-first')).toBe('function first() {\n  return 1;\n}');
    expect(sections.get('function-second')).toBe(
      '// Adds two numbers.\nfunction second() {\n  return 2;\n}',
    );
  });

  it('joins the comment of the first function when a header comment stands before it', () => {
    const js =
      '/* Licensed under MIT. */\n\n/** Adds two numbers. */\nfunction add(a, b) {\n  return a + b;\n}\n';

    expect(byId(js, 'math.js').get('function-add')).toBe(
      '/** Adds two numbers. */\nfunction add(a, b) {\n  return a + b;\n}',
    );
  });

  it('leaves a comment out when a line of code stands between it and the construct', () => {
    const js = [
      "'use strict';",
      '',
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
      "'use strict';",
      '',
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
    const js =
      "'use strict';\r\n\r\n// Adds.\r\n// Sums.\r\nfunction add(a, b) {\r\n  return a + b;\r\n}\r\n";

    expect(byId(js, 'math.js').get('function-add')).toBe(
      '// Adds.\r\n// Sums.\r\nfunction add(a, b) {\r\n  return a + b;\r\n}',
    );
  });

  it('leaves a comment out when another section reaches into it', () => {
    // A brace inside a string unbalances `tail`, so its range ends at the `}` in the comment below it.
    const reaching = [
      'function tail(text) {',
      "  if (text[0] === '{') return text;",
      '  return null;',
      '}',
      '/**',
      ' * Closes with a `}` in prose.',
      ' */',
      'function escape(s) {',
      '  return s;',
      '}',
      '',
    ].join('\n');
    // A function in the comment is a section of its own, and the commented function must not contain it.
    const example = [
      "'use strict';",
      '',
      '/**',
      ' * @example',
      ' *   function sample() { return 1; }',
      ' */',
      'function real() {',
      '  return 2;',
      '}',
      '',
    ].join('\n');

    expect(byId(reaching, 'tail.js').get('function-escape')).toBe(
      'function escape(s) {\n  return s;\n}',
    );
    expect(byId(example, 'real.js').get('function-real')).toBe('function real() {\n  return 2;\n}');
  });

  it('lets a JS class take the comment above it and a Java class not', () => {
    const box = 'class Box {\n  size = 1;\n}\n';

    expect(byId(`'use strict';\n\n// A box.\n${box}`, 'Box.js').get('class-Box')).toBe(
      `// A box.\n${box.trim()}`,
    );
    expect(byId(`package x;\n\n// A box.\n${box}`, 'Box.java').get('class-Box')).toBe(box.trim());
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
