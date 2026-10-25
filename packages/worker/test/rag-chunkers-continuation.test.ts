import { describe, expect, it } from 'vitest';
import {
  chunkSection,
  extractCodeSections,
  extractMarkdownSections,
  maskNonCode,
} from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

const sections = (source: string, file: string) =>
  new Map(extractCodeSections(source, file).map((section) => [section.sectionId, section]));
const constructs = (source: string, file: string) =>
  [...sections(source, file).keys()].filter((id) => !id.startsWith('chunk-'));
const gap = '// ' + 'gap '.repeat(40);

// Each expected range is written as source lines, independently of the reader's offsets.
function expectLines(source: string, file: string, id: string, first: number, last: number) {
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!.filter(Boolean);
  const actual = sections(source, file).get(id)?.content;
  expect(actual?.trimEnd()).toBe(
    lines
      .slice(first - 1, last)
      .join('')
      .trimEnd(),
  );
}

describe('T413 Go and Rust lexical boundaries', () => {
  it.each([
    ['go', 'func first() {', '  value := "}"', 'func second() {}'],
    ['rs', 'fn first() {', '  let value = "}";', 'fn second() {}'],
  ])('keeps the entire %s body past literal braces', (ext, head, literal, next) => {
    const source = [head, literal, `  ${'work(); '.repeat(30)}`, '}', gap, next].join('\n');
    expectLines(source, `a.${ext}`, 'function-first', 1, 4);
    expect(constructs(source, `a.${ext}`)).toEqual(['function-first', 'function-second']);
  });

  it.each([
    ['go', '/* func fake() {} */\nvar example = `func quoted() {}`\n', 'func real() {}'],
    [
      'rs',
      '/* fn fake() {} /* fn nested() {} */ */\nconst EXAMPLE: &str = r##"fn quoted() {}"##;\n',
      'fn real() {}',
    ],
  ])('extracts no %s constructs inside comments or raw strings', (ext, before, real) => {
    expect(constructs(before + gap + '\n' + real, `a.${ext}`)).toEqual(['function-real']);
  });

  it('preserves Rust lifetime syntax beside character and byte/raw literals', () => {
    const source = [
      "fn first<'a>(input: &'a str) {",
      "  let c = '}'; let b = b'{'; let s = br#\"}\"#;",
      '  /* } /* { */ } */',
      `  ${'work(); '.repeat(30)}`,
      '}',
      gap,
      'fn second() {}',
    ].join('\n');
    expectLines(source, 'a.rs', 'function-first', 1, 5);
    expect(constructs(source, 'a.rs')).toEqual(['function-first', 'function-second']);
  });
});

describe('T413 masking shape and comment braces', () => {
  it.each([
    ['go', 'func first() {', '  // }', 'func second() {}'],
    ['go', 'func first() {', '  value := `}`', 'func second() {}'],
    ['rust', 'fn first() {', '  /* } /* { */ } */', 'fn second() {}'],
    ['rust', 'fn first() {', '  let value = r##"} "# still string"##;', 'fn second() {}'],
  ] as const)('keeps %s body and offsets after %s %s', (syntax, head, literal, next) => {
    const source = [head, literal, `  ${'work(); '.repeat(30)}`, '}', gap, next].join('\r\n');
    const masked = maskNonCode(source, syntax);
    expect(masked.length).toBe(source.length);
    expect(masked.match(/\r\n/g)).toEqual(source.match(/\r\n/g));
    expectLines(source, syntax === 'go' ? 'a.go' : 'a.rs', 'function-first', 1, 4);
  });
});

describe('T413 Python quoted definitions', () => {
  it.each(['"""', "'''"])('ignores definitions in %s strings', (quote) => {
    const source = [
      `example = r${quote}`,
      'def fake():',
      '    pass',
      'class Fake:',
      '    pass',
      quote,
      '# def commented():',
      gap.replace('//', '#'),
      'def real():',
      '    return 1',
    ].join('\n');
    expect(constructs(source, 'a.py')).toEqual(['function-real']);
    expectLines(source, 'a.py', 'function-real', 9, 10);
  });

  it('does not end a Python class at unindented text inside its docstring', () => {
    const source = [
      'class Real:',
      '    """docs',
      'def fake():',
      '"""',
      '    def method(self):',
      '        return 1',
      gap.replace('//', '#'),
      'def after():',
      '    return 2',
    ].join('\n');
    expectLines(source, 'a.py', 'class-Real', 1, 6);
    expect(constructs(source, 'a.py')).toEqual(['class-Real', 'function-after']);
  });
});

describe('T413 ordinary boundary compatibility', () => {
  it('does not move a Python comment from the next definition into the previous one', () => {
    const source = ['def one():', '    return 1', '# two docs', 'def two():', '    return 2'].join(
      '\n',
    );
    expectLines(source, 'a.py', 'function-one', 1, 2);
    expectLines(source, 'a.py', 'function-two', 3, 5);
  });

  it('keeps TypeScript type assertions and generic arrows as code', () => {
    const source =
      'const value = <T>input;\nconst identity = <T,>(value: T) => { return value; };\nfunction after() {}';
    expect(constructs(source, 'a.ts')).toEqual(['function-identity', 'function-after']);
  });

  it('keeps existing LF cuts when a line break starts exactly at the size boundary', () => {
    const source = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
    const chunks = chunkSection(
      { sectionId: 's', content: source, breadcrumb: [] },
      { maxSize: 100, overlap: 0 },
    );
    expect(chunks.map((chunk) => chunk.content)).toEqual(['a'.repeat(100) + '\n', 'b'.repeat(100)]);
  });
});

describe('T413 PHP owners and Unicode labels', () => {
  it.each(['trait', 'interface', 'enum'])('names a method after its %s owner', (kind) => {
    const body = kind === 'interface' ? 'public function run();' : 'public function run() {}';
    const source = `<?php\n${kind} Owner { ${body} }`;
    const found = sections(source, 'a.php').get('method-Owner-run');
    expect(found?.content).toBe(source);
    expect(found?.breadcrumb).toEqual([`${kind} Owner`, 'function run']);
  });

  it('does not invent an anonymous class name or inherit its surrounding owner', () => {
    const source =
      '<?php\nclass Outer { public function build() { return new class extends Base { public function run() {} }; } }';
    expect(constructs(source, 'a.php')).toEqual(['function-run']);
    expect(sections(source, 'a.php').get('function-run')?.breadcrumb).toEqual(['function run']);
  });

  it.each(['café', '𝒜', '🙂', '\u0301name'])(
    'accepts PHP label %s under PHP byte rules',
    (name) => {
      const source = `<?php\nclass Näme { public function ${name}() {} }`;
      expect(constructs(source, 'a.php')).toEqual([`method-Näme-${name}`]);
    },
  );
});

describe('T413 JavaScript Unicode identifiers', () => {
  it.each(['café', '𝒜', 'cafe\u0301', '$x\u200D'])('extracts JS name %s', (name) => {
    expect(constructs(`function ${name}() {}`, 'a.js')).toEqual([`function-${name}`]);
    expect(constructs(`const ${name} = () => {};`, 'a.ts')).toEqual([`function-${name}`]);
    expect(constructs(`class ${name} {}`, 'a.js')).toEqual([`class-${name}`]);
    expect(constructs(`const object = { ${name}() {} };`, 'a.js')).toEqual([`function-${name}`]);
    expect(constructs(`const object = { '${name}': function () {} };`, 'a.js')).toEqual([
      `function-${name}`,
    ]);
    const source = `class Näme { ${name}() {} }`;
    expect(sections(source, 'a.js').get(`function-${name}`)?.breadcrumb).toEqual([
      'class Näme',
      `function ${name}`,
    ]);
  });

  it('does not accept PHP-only label characters as JS identifiers', () => {
    for (const name of ['🙂', '\u0301name']) {
      expect(constructs(`function ${name}() {}`, 'a.js')).toEqual([]);
    }
  });
});

describe('T413 JSX text versus expression syntax', () => {
  it.each(["don't ' quote", '// comment-looking', '/* comment-looking', '/ slash', '` key'])(
    'keeps bodies after JSX text %s',
    (text) => {
      const source = [
        'function First() {',
        `  return <p>${text}</p>;`,
        '}',
        gap,
        'function middle() { return 2; }',
        'const template = `actual`;',
        'function last() { return 3; }',
      ].join('\n');
      expect(constructs(source, 'a.tsx')).toEqual([
        'function-First',
        'function-middle',
        'function-last',
      ]);
      expectLines(source, 'a.tsx', 'function-First', 1, 3);
    },
  );

  it.each(["don't", '// text', '/* text', ': / text /', '` text'])(
    'keeps real expression code after %s',
    (text) => {
      const source = `function Component() { return <p>${text} {(() => { function inner() {} return 'ok'; })()}</p>; }\nconst later = \`template\`;\nfunction after() {}`;
      expect(constructs(source, 'a.tsx')).toEqual(['function-inner', 'function-after']);
    },
  );

  it('keeps nested JSX and self-closing attribute expressions', () => {
    const source = `function Component() { return <Box title=">" render={() => { function inside() {} return <p>don't / \` text</p>; }} />; }\nfunction after() {}`;
    expect(constructs(source, 'a.tsx')).toEqual(['function-inside', 'function-after']);
  });

  it('treats a backslash in a JSX attribute as text instead of a quote escape', () => {
    const source =
      'function Component() { return <p title="slash \\" >` text</p>; }\nfunction middle() {}\nconst template = `real`;\nfunction after() {}';
    expect(constructs(source, 'a.tsx')).toEqual([
      'function-Component',
      'function-middle',
      'function-after',
    ]);
  });

  it('ignores text constructs and masks strings, comments and templates inside JSX expressions', () => {
    const source = [
      'function Component() {',
      '  return <><b>function fake() {} / ` text</b><span title="function quoted() {}">',
      '    {(() => { /* function commented() {} */ const t = `function templated() {}`; return "}"; })()}',
      '  </span></>;',
      '}',
      gap,
      'function after() {}',
    ].join('\n');
    expect(constructs(source, 'a.jsx')).toEqual(['function-Component', 'function-after']);
    expectLines(source, 'a.jsx', 'function-Component', 1, 5);
  });
});

describe('T413 single-file component script blocks', () => {
  it.each(['vue', 'svelte'])('keeps actual script blocks in %s outside JSX mode', (ext) => {
    const markup = ext === 'vue' ? '<template><p>hello</p></template>' : '<p>hello</p>';
    const source = `<script lang="ts">\nfunction real() { return 1; }\n</script>\n${markup}`;
    expect(constructs(source, `component.${ext}`)).toEqual(['function-real']);
    expect(sections(source, `component.${ext}`).get('function-real')?.content).toBe(source);
  });
});

describe('T413 CR line boundaries', () => {
  it.each(['\n', '\r\n', '\r'])(
    'keeps JS closing lines and comments with their construct (%j)',
    (eol) => {
      const source = [
        'const api = {',
        '  one() { return 1; }',
        '};',
        '// two docs',
        'function two() {',
        '  return 2;',
        '}',
        '',
      ].join(eol);
      expectLines(source, 'a.js', 'function-one', 1, 3);
      expectLines(source, 'a.js', 'function-two', 4, 7);
    },
  );

  it.each(['\n', '\r\n', '\r'])(
    'extracts Markdown sections without changing %j line endings',
    (eol) => {
      const source = ['# First', '', 'first body', '', '## Second', '', 'second body'].join(eol);
      expect(extractMarkdownSections(source, 'a.md')).toEqual([
        {
          sectionId: 'first',
          content: ['# First', '', 'first body'].join(eol),
          breadcrumb: ['First'],
        },
        {
          sectionId: 'second',
          content: ['## Second', '', 'second body'].join(eol),
          breadcrumb: ['First', 'Second'],
        },
      ]);
      expect(
        extractMarkdownSections(
          ['# Only heading', '', '## Child', '', 'body'].join(eol),
          'a.md',
        ).map((s) => s.sectionId),
      ).toEqual(['child']);
    },
  );

  it.each(['py', 'rb'])('extracts full bodies in CR-only %s', (ext) => {
    const lines =
      ext === 'py'
        ? ['def one():', '    return 1', '', 'def two():', '    return 2']
        : ['def one', '  1', 'end', '', 'def two', '  2', 'end'];
    const source = lines.join('\r');
    expect(constructs(source, `a.${ext}`)).toEqual(['function-one', 'function-two']);
    expectLines(source, `a.${ext}`, 'function-one', 1, 3);
    expectLines(source, `a.${ext}`, 'function-two', ext === 'py' ? 4 : 5, lines.length);
  });

  it.each(['\r', '\r\n'])('splits chunks on whole %j line endings', (eol) => {
    const lines = Array.from({ length: 20 }, (_, i) => `row ${i} ${'x'.repeat(30)}`);
    const chunks = chunkSection(
      { sectionId: 's', breadcrumb: [], content: lines.join(eol) },
      { maxSize: 150, overlap: 0 },
    );
    expect(chunks.slice(0, -1).every((chunk) => chunk.content.endsWith(eol))).toBe(true);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(lines.join(eol));
  });
});

describe('T413 Ruby definitions', () => {
  it('names singleton methods and module ownership without swallowing the following declaration', () => {
    const source = [
      'module Util',
      '  def self.pick',
      '    1',
      '  end',
      'end',
      gap.replace('//', '#'),
      'def after',
      '  2',
      'end',
    ].join('\n');
    expect(constructs(source, 'a.rb')).toEqual(['function-self.pick', 'function-after']);
    expect(sections(source, 'a.rb').get('function-self.pick')?.breadcrumb).toEqual([
      'module Util',
      'function self.pick',
    ]);
    expectLines(source, 'a.rb', 'function-self.pick', 1, 4);
  });

  it('ends an endless method on its expression and keeps the following indented method', () => {
    const source = [
      'module Util',
      '  def self.one = 1',
      '  def two(value = 2)',
      '    value',
      '  end',
      'end',
    ].join('\n');
    expect(constructs(source, 'a.rb')).toEqual(['function-self.one', 'function-two']);
    expectLines(source, 'a.rb', 'function-self.one', 1, 2);
    expectLines(source, 'a.rb', 'function-two', 3, 6);
  });
  it('keeps the module owner for unindented Ruby methods', () => {
    const source = 'module Util\ndef self.one = 1\nend\ndef after = 2';
    expect(sections(source, 'a.rb').get('function-self.one')?.breadcrumb).toEqual([
      'module Util',
      'function self.one',
    ]);
    expect(sections(source, 'a.rb').get('function-after')?.breadcrumb).toEqual(['function after']);
  });

  it('does not give an endless def the following indented statement', () => {
    const source = 'def one = 1\n  outside = 2\ndef two\n  3\nend';
    expectLines(source, 'a.rb', 'function-one', 1, 1);
    expect(sections(source, 'a.rb').get('function-two')?.content).toBe(
      'outside = 2\ndef two\n  3\nend',
    );
  });
  it('keeps a continued endless expression together and excludes the next method', () => {
    const source = [
      'module Util',
      '  def one = (',
      '    "literal }" +',
      '    "body"',
      '  )',
      '  def two = 2',
      'end',
    ].join('\n');
    expect(constructs(source, 'a.rb')).toEqual(['function-one', 'function-two']);
    expectLines(source, 'a.rb', 'function-one', 1, 5);
    expectLines(source, 'a.rb', 'function-two', 6, 7);
  });
});
