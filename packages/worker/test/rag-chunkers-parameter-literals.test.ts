import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

const suffix = '\nfunction middle() {}\nconst later = `template`;\nfunction after() {}';
const named = (source: string) =>
  extractCodeSections(source, 'fixture.tsx').filter((s) => !s.sectionId.startsWith('chunk-'));
function valid(source: string) {
  const file = ts.createSourceFile(
    'fixture.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
}

describe('generic parameter defaults keep literals opaque', () => {
  it.each([
    String.raw`/\)/`,
    String.raw`/\(/`,
    '/[(){}]/',
    '/[/*]/',
    String.raw`/\)\//gi`,
    String.raw`/<\/T>/`,
    'n / 2',
    '(n / 2)',
    'obj.return / 2',
    'n++ / 2',
    'n! / 2',
    'n++ < Box > 1',
    'n! < Box > 1',
    'obj.return < Box > 1',
    "')'",
    '"</T>)"',
    '`outer${`inner )`}`',
    '(() => { return /[)]/; })()',
    '(function () { return /[)]/; })()',
  ])('keeps default %s within its real parameter list', (value) => {
    const declaration = `const identity = <T extends object>(pattern = ${value}) => { return pattern; };`;
    const source = declaration + suffix;
    valid(source);
    const found = named(source);
    expect(found.map((s) => s.sectionId)).toEqual([
      'function-identity',
      'function-middle',
      'function-after',
    ]);
    expect(found[0]?.content).toBe(declaration);
  });

  it('skips comments with parenthesis and slash-like punctuation', () => {
    const declaration =
      'const identity = <T extends object>(pattern = /* ) / fake */ /[)]/ /* ) */) /* ) */ => { return pattern; };';
    const source = declaration + suffix;
    valid(source);
    // Comments between parameters and arrow remain outside the existing body-range pattern.
    expect(named(source).map((s) => s.sectionId)).toEqual(['function-middle', 'function-after']);
  });
});

describe('parameter lookahead cannot borrow beyond its candidate JSX tag', () => {
  it.each(['await', 'yield'])('keeps %s default JSX text out of code', (tag) => {
    const source =
      tag === 'await'
        ? `const Component = async (value = <${tag} extends object>(child\nfunction fake() {}\n</${tag}>) => { return value; };\nfunction middle() {}`
        : `function* holder(value = <${tag} extends object>(child\nfunction fake() {}\n</${tag}>) { return value; }\nfunction middle() {}`;
    valid(source);
    const expected = tag === 'await' ? 'function-Component' : 'function-holder';
    const found = named(source);
    expect(found.map((s) => s.sectionId)).toEqual([expected, 'function-middle']);
    expect(found[0]?.content).toContain(`function fake() {}`);
  });

  it.each(['Box', 'T'])('preserves a real generic default JSX element %s', (tag) => {
    const declaration = `const identity = <T extends object>(value = <${tag}>(child) text</${tag}>) => { return value; };`;
    const source = declaration + suffix;
    valid(source);
    const found = named(source);
    expect(found.map((s) => s.sectionId)).toEqual([
      'function-identity',
      'function-middle',
      'function-after',
    ]);
    expect(found[0]?.content).toBe(declaration);
  });

  it.each([
    '<Box>(child\nfunction fake() {}\n</Box>',
    '<T>(child\nfunction fake() {}\n</T>',
    '<><Box>(child</Box></>',
    '<Box>` text</Box>',
    '<Box>{(() => "</T>")()}</Box>',
    '<Box>` text {(() => ' + String.raw`/}<\/Box>\)/` + ')()}</Box>',
    '<Box>` text {`outer${`inner } </Box> )`}`}</Box>',
    String.raw`<Box>{(() => /\)/)()}</Box>`,
  ])('keeps JSX-default content opaque: %s', (value) => {
    const declaration = `const identity = <T extends object>(value = ${value}) => { return value; };`;
    const source = declaration + suffix;
    valid(source);
    const found = named(source);
    expect(found.map((s) => s.sectionId)).toEqual([
      'function-identity',
      'function-middle',
      'function-after',
    ]);
    expect(found[0]?.content).toBe(declaration);
  });

  it.each(['<Box/>', '<Box>` text</Box>'])('resumes division after a JSX value %s', (value) => {
    const declaration = `const identity = <T extends object>(value = ${value} / 2, pattern = /\\)/) => { return pattern; };`;
    const source = declaration + suffix;
    valid(source);
    const found = named(source);
    expect(found.map((s) => s.sectionId)).toEqual([
      'function-identity',
      'function-middle',
      'function-after',
    ]);
    expect(found[0]?.content).toBe(declaration);
  });

  it('preserves a nested constrained generic-arrow default', () => {
    const declaration =
      'const identity = <T extends object>(value = <U extends object>(input: U) => { return input; }) => { return value; };';
    const source = declaration + suffix;
    valid(source);
    expect(named(source).map((s) => s.sectionId)).toEqual([
      'function-identity',
      'function-middle',
      'function-after',
    ]);
  });
});
